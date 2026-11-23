import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type { AuthScheme } from './store.js'

export interface StreamingWsConfig {
  url: string
  apiKey?: string
  authScheme?: AuthScheme
  language?: string
  mode?: 'meeting' | 'call'
  maxSpeakers?: number
}

export interface StreamingWsSegment {
  speaker: string
  start: number
  end: number
  text: string
}

export interface StreamingWsPartial {
  speaker: string
  text: string
  start: number
  end: number
}

export interface StreamingWsStatus {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  numSpeakers: number
  lastLatencyMs: number | null
  error: string | null
}

export interface StreamingWsCallbacks {
  onStatus?: (status: StreamingWsStatus) => void
  onSegment?: (segment: StreamingWsSegment) => void
  onPartial?: (partial: StreamingWsPartial | null) => void
  onError?: (message: string) => void
}

export function buildAuthHeader(
  scheme: AuthScheme | undefined,
  apiKey: string | undefined,
): string | undefined {
  const key = (apiKey ?? '').trim()
  if (!key || scheme === 'none') return undefined
  const prefix = scheme ?? 'Bearer'
  return `${prefix} ${key}`
}

const FRAME_BYTES = 3200 // 100 ms of 16 kHz mono PCM16
const SILENCE_FRAME_B64 = Buffer.alloc(FRAME_BYTES).toString('base64')
const SILENCE_TICK_MS = 100
const SILENCE_GAP_MS = 150
const MAX_PENDING_BYTES = 32000 * 15 // cap buffered pre-open audio at 15s

export class StreamingWsSession {
  private ws: WebSocket | null = null
  private closed = false
  private open = false
  private paused = false
  private lastFrameSentAt = 0
  private sentAudioBytes = 0
  private silenceTimer: NodeJS.Timeout | null = null
  private pcmRemainder: Buffer = Buffer.alloc(0)
  private pendingFrames: Buffer[] = []
  private pendingBytes = 0
  private emittedCount = 0
  private numSpeakers = 0
  private lastLatencyMs: number | null = null
  private finalPromiseResolve: (() => void) | null = null

  constructor(
    private readonly config: StreamingWsConfig,
    private readonly callbacks: StreamingWsCallbacks,
  ) {}

  get sentAudioSeconds(): number {
    return this.sentAudioBytes / 32000
  }

  start(): void {
    if (this.ws || this.closed) return
    const url = this.config.url.trim()
    if (!url) {
      this.emitStatus('error', 'Missing WebSocket URL')
      this.callbacks.onError?.('Missing WebSocket URL')
      return
    }

    this.emitStatus('connecting', null)

    const headers: Record<string, string> = {}
    const auth = buildAuthHeader(this.config.authScheme ?? 'Api-Key', this.config.apiKey)
    if (auth) {
      headers.Authorization = auth
    }

    const ws = new WebSocket(url, {
      headers,
      handshakeTimeout: 30_000,
    })
    this.ws = ws

    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (d: Buffer) => {
        body += d.toString('utf8')
      })
      res.on('end', () => {
        const msg = `WebSocket rejected (HTTP ${res.statusCode}): ${body.slice(0, 180) || res.statusMessage || 'error'}`
        this.emitStatus('error', msg)
        this.callbacks.onError?.(msg)
      })
    })

    ws.on('open', () => {
      if (this.closed) {
        ws.close()
        return
      }
      this.open = true
      const handshake: Record<string, unknown> = {
        session_id: `nectar-${randomUUID().slice(0, 8)}`,
        max_speakers: this.config.maxSpeakers ?? 8,
        language: this.config.language?.trim() || 'auto',
        mode: this.config.mode ?? 'meeting',
      }
      ws.send(JSON.stringify(handshake))
      this.emitStatus('connected', null)
      this.lastFrameSentAt = Date.now()
      this.flushPending()
      this.startSilencePadding()
    })

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as {
          type?: string
          error?: string
          is_final?: boolean
          num_speakers?: number
          segments?: Array<{
            speaker?: string
            start?: number
            end?: number
            text?: string
          }>
          partial?: Array<{
            speaker?: string
            start?: number
            end?: number
            text?: string
          }>
          stats?: {
            commit_lat_s?: { p50?: number | null }
          }
        }

        if (frame.type === 'error') {
          const msg = frame.error || 'Streaming server returned an error'
          this.emitStatus('error', msg)
          this.callbacks.onError?.(msg)
          return
        }

        if (typeof frame.num_speakers === 'number') {
          this.numSpeakers = frame.num_speakers
        }
        const p50 = frame.stats?.commit_lat_s?.p50
        if (typeof p50 === 'number' && Number.isFinite(p50)) {
          this.lastLatencyMs = Math.round(p50 * 1000)
        }

        const segments = Array.isArray(frame.segments) ? frame.segments : []
        if (segments.length > this.emittedCount) {
          for (let i = this.emittedCount; i < segments.length; i += 1) {
            const seg = segments[i]!
            const text = String(seg.text ?? '').trim()
            if (!text) continue
            this.callbacks.onSegment?.({
              speaker: String(seg.speaker || 'speaker_0'),
              start: Number(seg.start ?? 0),
              end: Number(seg.end ?? seg.start ?? 0),
              text,
            })
          }
          this.emittedCount = segments.length
        }

        const partials = Array.isArray(frame.partial) ? frame.partial : []
        const latestPartial = partials[partials.length - 1]
        if (latestPartial && String(latestPartial.text ?? '').trim()) {
          this.callbacks.onPartial?.({
            speaker: String(latestPartial.speaker || 'speaker_0'),
            text: String(latestPartial.text ?? '').trim(),
            start: Number(latestPartial.start ?? 0),
            end: Number(latestPartial.end ?? latestPartial.start ?? 0),
          })
        } else if (frame.is_final) {
          this.callbacks.onPartial?.(null)
        }

        this.emitStatus('connected', null)

        if (frame.is_final && this.finalPromiseResolve) {
          this.finalPromiseResolve()
          this.finalPromiseResolve = null
        }
      } catch {
        // ignore non-JSON frames
      }
    })

    ws.on('error', (err) => {
      const msg = err.message || 'WebSocket connection error'
      this.emitStatus('error', msg)
      this.callbacks.onError?.(msg)
    })

    ws.on('close', () => {
      this.open = false
      this.stopSilencePadding()
      if (this.finalPromiseResolve) {
        this.finalPromiseResolve()
        this.finalPromiseResolve = null
      }
      if (!this.closed) {
        this.emitStatus('idle', null)
      }
    })
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) {
      this.lastFrameSentAt = Date.now()
    }
  }

  feedPcm(pcm: Buffer | Uint8Array): void {
    if (this.closed || this.paused || !pcm || pcm.byteLength === 0) return
    const incoming = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
    let buf = this.pcmRemainder.length > 0 ? Buffer.concat([this.pcmRemainder, incoming]) : incoming

    while (buf.length >= FRAME_BYTES) {
      const frame = buf.subarray(0, FRAME_BYTES)
      buf = buf.subarray(FRAME_BYTES)
      this.sendOrQueueFrame(frame)
    }
    this.pcmRemainder = buf.length > 0 ? Buffer.from(buf) : Buffer.alloc(0)
  }

  private startSilencePadding(): void {
    this.stopSilencePadding()
    this.silenceTimer = setInterval(() => {
      if (
        this.closed ||
        this.paused ||
        !this.open ||
        !this.ws ||
        this.ws.readyState !== WebSocket.OPEN
      ) {
        return
      }
      if (Date.now() - this.lastFrameSentAt >= SILENCE_GAP_MS) {
        this.lastFrameSentAt = Date.now()
        this.sentAudioBytes += FRAME_BYTES
        this.ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: SILENCE_FRAME_B64,
          }),
        )
      }
    }, SILENCE_TICK_MS)
  }

  private stopSilencePadding(): void {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer)
      this.silenceTimer = null
    }
  }

  private sendOrQueueFrame(frame: Buffer): void {
    if (this.open && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.lastFrameSentAt = Date.now()
      this.sentAudioBytes += frame.length
      this.ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: frame.toString('base64'),
        }),
      )
      return
    }
    this.pendingFrames.push(Buffer.from(frame))
    this.pendingBytes += frame.length
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pendingFrames.length > 0) {
      const dropped = this.pendingFrames.shift()!
      this.pendingBytes -= dropped.length
    }
  }

  private flushPending(): void {
    if (!this.open || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    while (this.pendingFrames.length > 0) {
      const frame = this.pendingFrames.shift()!
      this.pendingBytes -= frame.length
      this.lastFrameSentAt = Date.now()
      this.sentAudioBytes += frame.length
      this.ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: frame.toString('base64'),
        }),
      )
    }
  }

  async finish(timeoutMs: number = 3500): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopSilencePadding()

    if (this.ws && this.open && this.ws.readyState === WebSocket.OPEN) {
      if (this.pcmRemainder.length > 0) {
        this.ws.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: this.pcmRemainder.toString('base64'),
          }),
        )
        this.pcmRemainder = Buffer.alloc(0)
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.finalPromiseResolve = null
          resolve()
        }, timeoutMs)
        this.finalPromiseResolve = () => {
          clearTimeout(timer)
          resolve()
        }
        try {
          this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }

    try {
      this.ws?.close()
    } catch {
      // ignore close errors
    }
    this.ws = null
    this.open = false
    this.pendingFrames = []
    this.pendingBytes = 0
    this.emitStatus('idle', null)
  }

  private emitStatus(
    status: StreamingWsStatus['status'],
    error: string | null,
  ): void {
    this.callbacks.onStatus?.({
      status,
      numSpeakers: this.numSpeakers,
      lastLatencyMs: this.lastLatencyMs,
      error,
    })
  }
}

export async function testStreamingWsConnection(
  config: StreamingWsConfig,
  timeoutMs: number = 12_000,
): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const url = config.url.trim()
  if (!url) {
    return { ok: false, latencyMs: 0, message: 'Enter a WebSocket URL first.' }
  }
  const t0 = Date.now()
  const headers: Record<string, string> = {}
  const auth = buildAuthHeader(config.authScheme ?? 'Api-Key', config.apiKey)
  if (auth) headers.Authorization = auth

  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean, message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolve({ ok, latencyMs: Date.now() - t0, message })
    }

    const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs })
    const timer = setTimeout(
      () => finish(false, `Connection timed out after ${Math.round(timeoutMs / 1000)}s`),
      timeoutMs,
    )

    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (d: Buffer) => {
        body += d.toString('utf8')
      })
      res.on('end', () => {
        finish(
          false,
          `HTTP ${res.statusCode}: ${body.slice(0, 140) || res.statusMessage || 'rejected'}`,
        )
      })
    })

    ws.on('open', () => {
      finish(true, `Connected in ${Date.now() - t0} ms`)
    })

    ws.on('error', (err) => {
      finish(false, err.message || 'WebSocket connection failed')
    })
  })
}
