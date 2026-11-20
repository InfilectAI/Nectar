import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'

import { Aira, type EyesSession, type MeetingTarget, type MeetingWatcher, type STTProviderInput } from '@infilectai/aira'
import { Cortex, type CortexServer } from '@infilectai/cortex'
import { SourceEvent, SourceType, Synapse } from '@infilectai/synapse'

import {
  deterministicDistill,
  distillMeeting,
  resolveEmbeddingEndpoint,
  resolveLlmEndpoint,
} from './distiller.js'
import {
  cancelCortexModelDownload,
  fallbackLocalModels,
  fetchCortexModels,
  getModelsDir,
  startCortexModelDownload,
  type CortexRuntimeStatus,
  type LocalModelId,
  type LocalModelInfo,
} from './local-models.js'
import { MCP_TOOLS, McpHttpServer } from './mcp-server.js'
import {
  NectarStore,
  anyServiceUsesLocal,
  getEffectiveServiceModes,
  getNectarDataDir,
  type AuthScheme,
  type MeetingRecord,
  type NectarSettings,
} from './store.js'
import {
  StreamingWsSession,
  buildAuthHeader,
  testStreamingWsConnection,
  type StreamingWsStatus,
} from './streaming-ws.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let pillWindow: BrowserWindow | null = null
let store: NectarStore
let synapse: Synapse
let aira: Aira | null = null
let cortexServer: CortexServer | null = null
let cortexUrl: string | null = null
let cortexStatus: CortexRuntimeStatus = 'stopped'
let cortexError: string | null = null
let cortexPrimitives: Record<string, string> = {}
let localModelsSnapshot: LocalModelInfo[] = fallbackLocalModels('stopped')
let healthPollTimer: NodeJS.Timeout | null = null
let lastModelsDigest = ''
let watcher: MeetingWatcher | null = null
let detectedMeetings: MeetingTarget[] = []
let activeCaptureSession: EyesSession | null = null
let activeStreamingWs: StreamingWsSession | null = null
let streamingWsStatus: StreamingWsStatus = {
  status: 'idle',
  numSpeakers: 0,
  lastLatencyMs: null,
  error: null,
}
let activeCaptureMeetingId: string | null = null
let capturePaused = false
let pillDragOffset: { x: number; y: number } | null = null
let mcpServer: McpHttpServer
let simulationTimer: NodeJS.Timeout | null = null

function unpackPath(p: string): string {
  return p.includes('app.asar') && !p.includes('app.asar.unpacked')
    ? p.replace('app.asar', 'app.asar.unpacked')
    : p
}

function cleanWhisperText(raw: string): string {
  return raw
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE)\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function broadcast(type: string, data: unknown = {}): void {
  const payload = { type, ...(data as object) }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('nectar:event', payload)
  }
  if (pillWindow && !pillWindow.isDestroyed()) {
    pillWindow.webContents.send('nectar:event', payload)
  }
}

function getLocalModelsPayload() {
  return {
    cortexStatus,
    cortexUrl,
    cortexError,
    localModels: localModelsSnapshot,
  }
}

function broadcastLocalModels(force = false): void {
  const payload = getLocalModelsPayload()
  const digest = JSON.stringify(payload)
  if (!force && digest === lastModelsDigest) return
  lastModelsDigest = digest
  broadcast('models:changed', payload)
}

function stopHealthPolling(): void {
  if (healthPollTimer) {
    clearInterval(healthPollTimer)
    healthPollTimer = null
  }
}

function startHealthPolling(port: number): void {
  stopHealthPolling()
  healthPollTimer = setInterval(() => {
    pollCortexHealth(port).catch(() => {})
  }, 1000)
}

async function pollCortexHealth(port: number): Promise<void> {
  if (store && !anyServiceUsesLocal(store.getSettings())) return
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    const [healthRes, models] = await Promise.all([
      fetch(`${baseUrl}/health`, { signal: controller.signal }),
      fetchCortexModels(baseUrl, controller.signal).catch(() => null),
    ])
    clearTimeout(timer)
    if (!healthRes.ok) {
      if (cortexStatus === 'running') {
        cortexStatus = 'stopped'
        cortexPrimitives = {}
        localModelsSnapshot = fallbackLocalModels('stopped')
        broadcastLocalModels()
      }
      return
    }
    const data = (await healthRes.json()) as {
      status?: string
      primitives?: Record<string, string>
    }
    cortexPrimitives = data.primitives ?? {}
    cortexUrl = baseUrl
    cortexStatus = 'running'
    cortexError = null
    localModelsSnapshot = models ?? fallbackLocalModels('running', cortexPrimitives)
    broadcastLocalModels()
  } catch {
    if (cortexStatus !== 'starting') {
      if (cortexStatus !== 'error') {
        cortexStatus = 'stopped'
      }
      cortexPrimitives = {}
      localModelsSnapshot = fallbackLocalModels(cortexStatus)
      broadcastLocalModels()
    }
  }
}

/**
 * Deterministic semantic vector hash (64-dim) so offline/local recall works
 * immediately even before an external GGUF embedding model is downloaded, while
 * seamlessly using Cortex/Cloud `/v1/embeddings` when available.
 */
function deterministicEmbed(text: string, dims: number = 64): number[] {
  const vec = new Array<number>(dims).fill(0)
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) {
    vec[0] = 1
    return vec
  }
  for (const tok of tokens) {
    let h = 2166136261
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    const idx = Math.abs(h) % dims
    vec[idx]! += 1
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / norm)
}

function projectVector(vec: number[], targetDims: number = 64): number[] {
  if (vec.length === targetDims) return vec
  const out = new Array<number>(targetDims).fill(0)
  for (let i = 0; i < vec.length; i += 1) {
    out[i % targetDims]! += vec[i]!
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1
  return out.map((v) => v / norm)
}

function resolveDiarizeProvider(
  settings: NectarSettings,
): { url: string; apiKey?: string; headers?: Record<string, string> } | undefined {
  const modes = getEffectiveServiceModes(settings)
  if (modes.stt === 'cloud' && settings.sttIncludesDiarization) {
    return undefined
  }
  if (modes.diarize === 'local') {
    const base = (
      cortexUrl ?? `http://127.0.0.1:${settings.localPort}`
    ).replace(/\/+$/, '')
    return {
      url: `${base}/v1/audio/diarize`,
    }
  }
  const url = settings.diarizeUrl?.trim()
  if (!url) return undefined
  const key = settings.diarizeApiKey || settings.sttApiKey
  const auth = buildAuthHeader(settings.diarizeAuthScheme ?? 'Api-Key', key)
  return {
    url,
    headers: auth ? { Authorization: auth } : undefined,
  }
}

function resolveSttAndDiarize(settings: NectarSettings): {
  stt: STTProviderInput
  diarize?: { url: string; apiKey?: string; headers?: Record<string, string> }
  useStreamingWs: boolean
} {
  const modes = getEffectiveServiceModes(settings)
  const diarize = resolveDiarizeProvider(settings)

  if (modes.stt === 'local') {
    const base = (
      cortexUrl ?? `http://127.0.0.1:${settings.localPort}`
    ).replace(/\/+$/, '')
    return {
      stt: {
        url: `${base}/v1/audio/transcriptions`,
        model: settings.sttModel || 'whisper-large-v3',
      },
      diarize,
      useStreamingWs: false,
    }
  }

  const provider = settings.cloudSttProvider || 'websocket'
  const apiKey = settings.sttApiKey

  if (provider === 'websocket') {
    return {
      // Audio PCM is streamed directly over StreamingWsSession; no-op batch callback prevents double STT
      stt: async () => ({ text: '' }),
      diarize: undefined,
      useStreamingWs: true,
    }
  }

  if (provider === 'deepgram') {
    const model = settings.sttModel || 'nova-3'
    return {
      stt: async (wav: Buffer) => {
        const res = await fetch(
          `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true&diarize=true`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${apiKey}`,
              'Content-Type': 'audio/wav',
            },
            body: new Uint8Array(wav),
          },
        )
        if (!res.ok) {
          throw new Error(`Deepgram STT failed (${res.status}): ${await res.text()}`)
        }
        const data = (await res.json()) as {
          results?: {
            channels?: Array<{
              alternatives?: Array<{
                transcript?: string
              }>
            }>
          }
        }
        const alt = data.results?.channels?.[0]?.alternatives?.[0]
        return { text: alt?.transcript ?? '' }
      },
      diarize,
      useStreamingWs: false,
    }
  }

  if (provider === 'assemblyai') {
    return {
      stt: async (wav: Buffer) => {
        const upRes = await fetch('https://api.assemblyai.com/v2/upload', {
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/octet-stream',
          },
          body: new Uint8Array(wav),
        })
        if (!upRes.ok) throw new Error(`AssemblyAI upload failed (${upRes.status})`)
        const { upload_url } = (await upRes.json()) as { upload_url: string }
        const trRes = await fetch('https://api.assemblyai.com/v2/transcript', {
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audio_url: upload_url,
            speaker_labels: true,
          }),
        })
        if (!trRes.ok) throw new Error(`AssemblyAI transcript failed (${trRes.status})`)
        const { id } = (await trRes.json()) as { id: string }
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 800))
          const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
            headers: { Authorization: apiKey },
          })
          const statusObj = (await poll.json()) as {
            status: string
            text?: string
          }
          if (statusObj.status === 'completed') {
            return { text: statusObj.text ?? '' }
          }
          if (statusObj.status === 'error') {
            throw new Error('AssemblyAI transcription error')
          }
        }
        return { text: '' }
      },
      diarize,
      useStreamingWs: false,
    }
  }

  if (provider === 'openai') {
    return {
      stt: {
        url: 'https://api.openai.com/v1/audio/transcriptions',
        model: settings.sttModel || 'gpt-4o-transcribe',
        apiKey,
      },
      diarize,
      useStreamingWs: false,
    }
  }

  if (provider === 'gemini') {
    const model = settings.sttModel || 'gemini-2.5-flash'
    return {
      stt: async (wav: Buffer) => {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: 'Transcribe this audio verbatim. Return only the spoken words.' },
                    {
                      inline_data: {
                        mime_type: 'audio/wav',
                        data: wav.toString('base64'),
                      },
                    },
                  ],
                },
              ],
            }),
          },
        )
        if (!res.ok) throw new Error(`Gemini STT failed (${res.status})`)
        const body = (await res.json()) as {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> }
          }>
        }
        return { text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? '' }
      },
      diarize,
      useStreamingWs: false,
    }
  }

  const customAuth = buildAuthHeader(settings.sttAuthScheme ?? 'Bearer', apiKey)
  return {
    stt: {
      url: settings.sttUrl || 'https://api.openai.com/v1/audio/transcriptions',
      model: settings.sttModel || 'whisper-1',
      headers: customAuth ? { Authorization: customAuth } : undefined,
    },
    diarize,
    useStreamingWs: false,
  }
}

async function initSynapse(settings: NectarSettings): Promise<void> {
  if (synapse) {
    await synapse.close().catch(() => {})
  }
  const synapseDbPath = path.join(getNectarDataDir(), 'synapse.db')
  const llm = resolveLlmEndpoint(settings, cortexUrl)
  const emb = resolveEmbeddingEndpoint(settings, cortexUrl)

  synapse = await Synapse.open(synapseDbPath, {
    defaultGroupId: settings.groupId,
    chatBaseUrl: llm.baseUrl,
    chatModel: llm.model,
    chatApiKey: llm.apiKey,
    embeddingBaseUrl: emb.baseUrl,
    embeddingModel: emb.model,
    embeddingApiKey: emb.apiKey,
    embeddingDimensions: 64,
    memoryHitThreshold: 0.15,
    inferenceMode: 'fake',
    consolidationMode: 'deterministic',
    embedder: async (text: string) => {
      if (emb.mode === 'cloud' && emb.baseUrl) {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          }
          const auth = buildAuthHeader(emb.authScheme, emb.apiKey)
          if (auth) headers.Authorization = auth
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 8_000)
          const res = await fetch(`${emb.baseUrl}/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: emb.model || 'default', input: text }),
            signal: controller.signal,
          })
          clearTimeout(timer)
          if (res.ok) {
            const payload = (await res.json()) as {
              data?: Array<{ embedding?: number[] }>
            }
            const raw = payload.data?.[0]?.embedding
            if (Array.isArray(raw) && raw.length > 0) {
              return projectVector(raw, 64)
            }
          }
        } catch {
          // fall back to deterministic vector hash when offline
        }
      }
      return deterministicEmbed(text, 64)
    },
    judge: {
      async select(query, candidates) {
        if (candidates.length === 0) {
          return { answerable: false, selectedEpisodeId: null, confidence: 0 }
        }
        const qTokens = query
          .toLowerCase()
          .replace(/[^a-z0-9\s]+/g, ' ')
          .split(/\s+/)
          .filter((t) => t.length > 2)
        for (const c of candidates) {
          const lower = c.text.toLowerCase()
          const hits = qTokens.filter((t) => lower.includes(t)).length
          if (hits >= Math.min(2, qTokens.length)) {
            return {
              answerable: true,
              selectedEpisodeId: c.episode_id,
              confidence: 0.92,
            }
          }
        }
        return {
          answerable: true,
          selectedEpisodeId: candidates[0]!.episode_id,
          confidence: 0.84,
        }
      },
    },
  })
}

async function startLocalCortex(port: number): Promise<string> {
  cortexStatus = 'starting'
  cortexError = null
  broadcastLocalModels(true)

  const expectedUrl = `http://127.0.0.1:${port}`
  if (cortexServer && cortexServer.port !== port) {
    await cortexServer.stop().catch(() => {})
    cortexServer = null
  }

  try {
    // Check if Cortex is already listening on localPort
    const probe = await fetch(`${expectedUrl}/health`).catch(() => null)
    if (probe && probe.ok) {
      const data = (await probe.json().catch(() => ({}))) as {
        primitives?: Record<string, string>
      }
      cortexUrl = expectedUrl
      cortexPrimitives = data.primitives ?? {}
      cortexStatus = 'running'
      cortexError = null
    } else {
      const modelsDir = getModelsDir()
      const started = await Cortex.start({
        port,
        modelsDir,
        stdio: 'pipe',
      })
      cortexServer = started
      cortexUrl = started.url
      cortexStatus = 'running'
      cortexError = null

      started.process.once('exit', (code, signal) => {
        if (cortexServer !== started) return
        cortexServer = null
        if (store && anyServiceUsesLocal(store.getSettings())) {
          cortexStatus = code && code !== 0 ? 'error' : 'stopped'
          cortexError =
            code && code !== 0
              ? `Local Cortex runtime exited unexpectedly (code ${code}${signal ? `, ${signal}` : ''})`
              : null
          cortexPrimitives = {}
          localModelsSnapshot = fallbackLocalModels(cortexStatus)
          broadcastLocalModels(true)
        }
      })

      const [initialHealth, models] = await Promise.all([
        started.health().catch(() => null),
        fetchCortexModels(started.url).catch(() => null),
      ])
      if (initialHealth?.primitives) {
        cortexPrimitives = Object.fromEntries(
          Object.entries(initialHealth.primitives).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      }
      localModelsSnapshot = models ?? fallbackLocalModels('running', cortexPrimitives)
    }
    startHealthPolling(port)
    broadcastLocalModels(true)
    return cortexUrl
  } catch (err) {
    cortexUrl = expectedUrl
    cortexStatus = 'error'
    cortexError = err instanceof Error ? err.message : String(err)
    cortexPrimitives = {}
    localModelsSnapshot = fallbackLocalModels('error')
    startHealthPolling(port)
    broadcastLocalModels(true)
    throw err
  }
}

async function initComputeAndPerception(settings: NectarSettings): Promise<void> {
  if (anyServiceUsesLocal(settings)) {
    await startLocalCortex(settings.localPort).catch(() => {})
  } else {
    stopHealthPolling()
    if (cortexServer) {
      await cortexServer.stop().catch(() => {})
      cortexServer = null
    }
    cortexStatus = 'cloud'
    cortexError = null
    cortexPrimitives = {}
    localModelsSnapshot = fallbackLocalModels('cloud')
    broadcastLocalModels(true)
  }

  await initSynapse(settings)

  // Initialize Aira for meeting detection & audio capture
  if (!aira) {
    const resolved = resolveSttAndDiarize(settings)
    const packedCaptureCandidate = unpackPath(
      path.resolve(
        __dirname,
        '..',
        'node_modules',
        '@infilectai',
        'aira',
        'bin',
        'aira-capture',
      ),
    )
    aira = await Aira.create({
      capturePath: fs.existsSync(packedCaptureCandidate)
        ? packedCaptureCandidate
        : undefined,
      stt: resolved.stt,
      diarize: resolved.diarize,
    })

    watcher = aira.eyes.watchMeetings()
    watcher.on('meetings', (meetings: MeetingTarget[]) => {
      detectedMeetings = meetings
      broadcast('meetings:detected', { detectedMeetings })
    })
  }

  broadcastLocalModels(true)
}

async function seedInitialWorkspaceIfEmpty(): Promise<void> {
  const existing = store.listMeetings()
  if (existing.length > 0) return

  const settings = store.getSettings()
  const groupId = settings.groupId

  // 1. Historical March meeting (Sam owned checkout-service originally)
  const marchMeeting = store.createMeeting({
    title: 'Q1 Platform Kickoff & Service Ownership',
    platform: 'google-meet',
    url: 'https://meet.google.com/qwe-rtyu-iop',
    startedAt: '2026-03-10T17:00:00.000Z',
    endedAt: '2026-03-10T17:30:00.000Z',
    status: 'completed',
    participants: ['Sam', 'Alex'],
    roughNotes:
      '- Sam taking initial ownership of checkout-service for Q1\n- Alex setting up staging clusters',
  })
  store.addTranscriptTurn({
    meetingId: marchMeeting.id,
    speaker: 'Sam',
    text: 'Sam owns checkout-service for the initial Q1 launch window.',
    t0: 12.0,
    t1: 18.4,
    createdAt: '2026-03-10T17:05:00.000Z',
  })
  const marchFull = store.getMeeting(marchMeeting.id)!
  const marchDistilled = deterministicDistill(marchFull)
  store.updateMeeting(marchMeeting.id, {
    distilledNotes: marchDistilled.distilledNotes,
    actionItems: marchDistilled.actionItems,
    decisions: marchDistilled.decisions,
  })
  await synapse.ingest(
    new SourceEvent({
      sourceId: `meeting-${marchMeeting.id}`,
      sourceType: SourceType.MEETING,
      conversationId: marchMeeting.id,
      content: marchFull.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
      participants: marchFull.participants,
      occurredAt: new Date('2026-03-10T17:00:00.000Z'),
      metadata: {
        semantic_assertions: marchDistilled.assertions,
      },
    }),
    groupId,
  )

  // 2. Recent Q4 meeting (Priya takes over checkout-service, superseding Sam!)
  const q4Meeting = store.createMeeting({
    title: 'Q4 On-Call Rotation & Checkout Handoff',
    platform: 'google-meet',
    url: 'https://meet.google.com/abc-defg-hij',
    startedAt: '2026-11-14T16:00:00.000Z',
    endedAt: '2026-11-14T16:25:00.000Z',
    status: 'completed',
    participants: ['Sam', 'Priya', 'Alex'],
    roughNotes:
      '- Freeze Q4 on-call rotation by Friday\n- Priya taking over checkout-service after deploy\n- [ ] Alex: Update checkout-rollback v2 runbook and PagerDuty escalation',
  })
  store.addTranscriptTurn({
    meetingId: q4Meeting.id,
    speaker: 'Sam',
    text: "Before we freeze Q4 on-call rotations, let's confirm who is taking checkout-service.",
    t0: 4.8,
    t1: 11.2,
    createdAt: '2026-11-14T16:01:00.000Z',
  })
  store.addTranscriptTurn({
    meetingId: q4Meeting.id,
    speaker: 'Priya',
    text: "Priya owns checkout-service now—we're cutting ownership over to my team after Friday's deploy.",
    t0: 14.2,
    t1: 20.1,
    createdAt: '2026-11-14T16:02:00.000Z',
  })
  store.addTranscriptTurn({
    meetingId: q4Meeting.id,
    speaker: 'Alex',
    text: 'Copy that—updating checkout-rollback v2 runbook and PagerDuty escalation now.',
    t0: 20.6,
    t1: 26.4,
    createdAt: '2026-11-14T16:03:00.000Z',
  })

  const q4Full = store.getMeeting(q4Meeting.id)!
  const q4Distilled = deterministicDistill(q4Full)
  store.updateMeeting(q4Meeting.id, {
    distilledNotes: q4Distilled.distilledNotes,
    actionItems: q4Distilled.actionItems,
    decisions: q4Distilled.decisions,
  })
  await synapse.ingest(
    new SourceEvent({
      sourceId: `meeting-${q4Meeting.id}`,
      sourceType: SourceType.MEETING,
      conversationId: q4Meeting.id,
      content: q4Full.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
      participants: q4Full.participants,
      occurredAt: new Date('2026-11-14T16:00:00.000Z'),
      metadata: {
        semantic_assertions: q4Distilled.assertions,
      },
    }),
    groupId,
  )

  await synapse.consolidate(groupId)
}

function getMcpInstalledState(): Record<
  'claude' | 'codex' | 'cursor' | 'copilot' | 'vscode',
  boolean
> {
  const home = os.homedir()
  const hasJsonMcp = (filePath: string, key = 'mcpServers'): boolean => {
    try {
      if (!fs.existsSync(filePath)) return false
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
        string,
        unknown
      >
      const servers = parsed[key] as Record<string, unknown> | undefined
      return Boolean(servers && typeof servers === 'object' && 'nectar' in servers)
    } catch {
      return false
    }
  }

  const claudeCodePath = path.join(home, '.claude.json')
  const claudeDesktopPath = path.join(
    home,
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json',
  )
  const cursorPath = path.join(home, '.cursor', 'mcp.json')
  const copilotPath = path.join(home, '.copilot', 'mcp-config.json')
  const vscodePath = path.join(
    home,
    'Library',
    'Application Support',
    'Code',
    'User',
    'mcp.json',
  )
  const codexPath = path.join(home, '.codex', 'config.toml')

  let codexInstalled = false
  try {
    if (fs.existsSync(codexPath)) {
      codexInstalled = fs.readFileSync(codexPath, 'utf8').includes('[mcp_servers.nectar]')
    }
  } catch {
    codexInstalled = false
  }

  return {
    claude: hasJsonMcp(claudeCodePath) || hasJsonMcp(claudeDesktopPath),
    codex: codexInstalled,
    cursor: hasJsonMcp(cursorPath),
    copilot: hasJsonMcp(copilotPath),
    vscode: hasJsonMcp(vscodePath, 'servers') || hasJsonMcp(vscodePath, 'mcpServers'),
  }
}

async function getFullAppState() {
  const settings = store.getSettings()
  const meetings = store.listMeetings()
  const permissions = aira
    ? await aira.checkPermissions(false).catch(() => ({}))
    : { accessibility: 'granted', microphone: 'granted', 'system-audio': 'granted' }

  return {
    settings,
    cortexStatus,
    cortexUrl,
    cortexError,
    localModels: localModelsSnapshot,
    streamingWs: streamingWsStatus,
    detectedMeetings,
    activeCaptureMeetingId,
    capturePaused,
    permissions,
    meetings,
    mcp: {
      url: mcpServer.url,
      port: mcpServer.port,
      tools: MCP_TOOLS,
      requestsHandled: mcpServer.requestsHandled,
      stdioScriptPath: unpackPath(
        path.resolve(__dirname, '..', 'bin', 'nectar-mcp.js'),
      ),
      installed: getMcpInstalledState(),
    },
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('nectar:getState', async () => getFullAppState())

  ipcMain.handle('nectar:saveSettings', async (_e, patch: Partial<NectarSettings>) => {
    const prev = store.getSettings()
    const updated = store.saveSettings(patch)
    const prevLocal = anyServiceUsesLocal(prev)
    const nextLocal = anyServiceUsesLocal(updated)
    if (prevLocal !== nextLocal || prev.localPort !== updated.localPort) {
      await initComputeAndPerception(updated)
    } else {
      await initSynapse(updated)
    }
    const nextState = await getFullAppState()
    broadcast('state:refresh', nextState)
    return nextState
  })

  ipcMain.handle('nectar:checkPermissions', async (_e, prompt: boolean) => {
    if (!aira) return {}
    const perms = await aira.checkPermissions(Boolean(prompt))
    if (prompt && perms.accessibility !== 'granted') {
      shell
        .openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        )
        .catch(() => {})
    }
    broadcast('permissions:changed', { permissions: perms })
    return perms
  })

  ipcMain.handle('nectar:completeOnboarding', async () => {
    store.saveSettings({ onboardingCompleted: true })
    const nextState = await getFullAppState()
    broadcast('state:refresh', nextState)
    return nextState
  })

  ipcMain.handle('nectar:refreshLocalModels', async () => {
    const settings = store.getSettings()
    if (anyServiceUsesLocal(settings)) {
      await pollCortexHealth(settings.localPort)
    }
    broadcastLocalModels(true)
    return getLocalModelsPayload()
  })

  const ensureCortexBaseUrl = async (): Promise<string> => {
    const settings = store.getSettings()
    if (cortexStatus === 'running' && cortexUrl) return cortexUrl
    return startLocalCortex(settings.localPort)
  }

  ipcMain.handle('nectar:downloadLocalModel', async (_e, modelId: LocalModelId) => {
    const baseUrl = await ensureCortexBaseUrl()
    await startCortexModelDownload(baseUrl, modelId)
    await pollCortexHealth(store.getSettings().localPort)
    return { ok: true }
  })

  ipcMain.handle(
    'nectar:downloadAllLocalModels',
    async (_e, modelIds?: LocalModelId[]) => {
      const targets: LocalModelId[] =
        Array.isArray(modelIds) && modelIds.length > 0
          ? modelIds
          : ['stt', 'diarize', 'chat', 'embed']
      const baseUrl = await ensureCortexBaseUrl()
      await Promise.all(
        targets.map((id) => startCortexModelDownload(baseUrl, id).catch(() => {})),
      )
      await pollCortexHealth(store.getSettings().localPort)
      return { ok: true }
    },
  )

  ipcMain.handle(
    'nectar:cancelLocalModelDownload',
    async (_e, modelId: LocalModelId) => {
      if (cortexUrl && cortexStatus === 'running') {
        await cancelCortexModelDownload(cortexUrl, modelId).catch(() => {})
        await pollCortexHealth(store.getSettings().localPort)
      }
      return { ok: true }
    },
  )

  ipcMain.handle('nectar:restartCortex', async () => {
    const settings = store.getSettings()
    if (anyServiceUsesLocal(settings)) {
      if (cortexServer) {
        await cortexServer.stop().catch(() => {})
        cortexServer = null
      }
      await startLocalCortex(settings.localPort).catch(() => {})
    }
    const nextState = await getFullAppState()
    broadcast('state:refresh', nextState)
    return nextState
  })

  ipcMain.handle('nectar:openModelsFolder', async () => {
    const dir = getModelsDir()
    await shell.openPath(dir).catch(() => {})
    return { ok: true, path: dir }
  })

  ipcMain.handle(
    'nectar:testSttConnection',
    async (
      _e,
      config: {
        url: string
        apiKey?: string
        authScheme?: AuthScheme
        language?: string
        mode?: 'meeting' | 'call'
      },
    ) => {
      return testStreamingWsConnection(config)
    },
  )

  ipcMain.handle(
    'nectar:createMeeting',
    async (
      _e,
      input: { title?: string; platform?: string; url?: string; roughNotes?: string },
    ) => {
      const meeting = store.createMeeting({
        title: input.title || 'Untitled Meeting Note',
        platform: input.platform || 'local-note',
        url: input.url || 'nectar://note',
        status: 'recording',
        roughNotes: input.roughNotes ?? '',
      })
      broadcast('meetings:changed', { meetings: store.listMeetings() })
      return meeting
    },
  )

  ipcMain.handle(
    'nectar:updateMeeting',
    async (_e, id: string, patch: Partial<MeetingRecord>) => {
      const updated = store.updateMeeting(id, patch)
      broadcast('meetings:changed', { meetings: store.listMeetings() })
      return updated
    },
  )

  ipcMain.handle('nectar:deleteMeeting', async (_e, id: string) => {
    store.deleteMeeting(id)
    broadcast('meetings:changed', { meetings: store.listMeetings() })
    return { ok: true }
  })

  ipcMain.handle('nectar:distillMeeting', async (_e, id: string) => {
    const meeting = store.getMeeting(id)
    if (!meeting) throw new Error(`Meeting ${id} not found`)
    const settings = store.getSettings()
    const result = await distillMeeting(meeting, settings, cortexUrl)
    const updated = store.updateMeeting(id, {
      status: 'completed',
      endedAt: meeting.endedAt ?? new Date().toISOString(),
      distilledNotes: result.distilledNotes,
      actionItems: result.actionItems,
      decisions: result.decisions,
    })!

    const transcriptContent =
      updated.turns.length > 0
        ? updated.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n')
        : updated.roughNotes || updated.title

    await synapse.ingest(
      new SourceEvent({
        sourceId: `meeting-${updated.id}`,
        sourceType: SourceType.MEETING,
        conversationId: updated.id,
        content: transcriptContent,
        participants:
          updated.participants.length > 0 ? updated.participants : ['You'],
        occurredAt: new Date(updated.startedAt),
        metadata: {
          title: updated.title,
          semantic_assertions: result.assertions,
        },
      }),
      settings.groupId,
    )
    await synapse.consolidate(settings.groupId)
    broadcast('state:refresh', await getFullAppState())
    return updated
  })

  ipcMain.handle(
    'nectar:startCapture',
    async (_e, target?: MeetingTarget, existingMeetingId?: string) => {
      if (!aira) throw new Error('Aira SDK not initialized')
      const perms = await aira.checkPermissions(true).catch(() => ({}))
      broadcast('permissions:changed', { permissions: perms })

      if (activeStreamingWs) {
        await activeStreamingWs.finish().catch(() => {})
        activeStreamingWs = null
      }
      if (activeCaptureSession) {
        await activeCaptureSession.close().catch(() => {})
        activeCaptureSession = null
      }

      const resolvedTarget: MeetingTarget = target ??
        detectedMeetings[0] ?? {
          pid: process.pid,
          browser: 'chrome',
          platform: 'google-meet',
          url: 'https://meet.google.com/live',
          title: 'Live Meeting Capture',
        }

      const meeting = existingMeetingId
        ? store.getMeeting(existingMeetingId)!
        : store.createMeeting({
            title: resolvedTarget.title || 'Live Meeting',
            platform: resolvedTarget.platform || 'google-meet',
            url: resolvedTarget.url || 'nectar://live',
            status: 'recording',
          })

      activeCaptureMeetingId = meeting.id
      capturePaused = false
      const settings = store.getSettings()
      const resolved = resolveSttAndDiarize(settings)

      if (resolved.useStreamingWs) {
        const wsSession = new StreamingWsSession(
          {
            url: settings.sttUrl,
            apiKey: settings.sttApiKey,
            authScheme: settings.sttAuthScheme ?? 'Api-Key',
            language: settings.sttLanguage || 'auto',
            mode: settings.sttWsMode || 'meeting',
            maxSpeakers: 8,
          },
          {
            onStatus: (nextStatus) => {
              streamingWsStatus = nextStatus
              broadcast('streaming:status', { streamingWs: nextStatus })
            },
            onSegment: (seg) => {
              const cleanedText = cleanWhisperText(seg.text)
              if (!cleanedText) return
              const turn = store.addTranscriptTurn({
                meetingId: meeting.id,
                speaker: seg.speaker || 'speaker_0',
                participantId: seg.speaker || null,
                text: cleanedText,
                t0: seg.start,
                t1: seg.end,
              })
              synapse
                .ingest(
                  {
                    speaker: turn.speaker,
                    participantId: turn.participantId,
                    text: turn.text,
                    t0: turn.t0,
                    t1: turn.t1,
                    partial: false,
                    conversationId: meeting.id,
                    sourceId: `turn-${turn.id}`,
                  },
                  settings.groupId,
                )
                .catch(() => {})
              broadcast('meeting:turn', {
                meetingId: meeting.id,
                turn,
                meeting: store.getMeeting(meeting.id),
              })
            },
            onPartial: (partial) => {
              if (!partial) {
                broadcast('meeting:partial', { meetingId: meeting.id, text: '' })
                return
              }
              const cleanedText = cleanWhisperText(partial.text)
              if (cleanedText) {
                broadcast('meeting:partial', {
                  meetingId: meeting.id,
                  speaker: partial.speaker || 'speaker_0',
                  text: cleanedText,
                  t0: partial.start,
                })
              }
            },
          },
        )
        activeStreamingWs = wsSession
        wsSession.start()
      }

      const session = aira.startMeeting(resolvedTarget, {
        stt: resolved.stt,
        diarize: resolved.diarize,
      })
      activeCaptureSession = session

      session.on(
        'audio',
        (chunk: { pcm?: Buffer; sysRMS?: number; micRMS?: number }) => {
          if (!capturePaused) {
            const level = Math.max(chunk.sysRMS ?? 0, chunk.micRMS ?? 0)
            broadcast('audio:level', { level })
            if (activeStreamingWs && chunk.pcm && chunk.pcm.length > 0) {
              activeStreamingWs.feedPcm(chunk.pcm)
            }
          }
        },
      )

      if (!resolved.useStreamingWs) {
        ;(async () => {
          for await (const ev of session.events) {
            if (capturePaused) continue
            if (ev.type === 'transcript') {
              const cleanedText = cleanWhisperText(ev.text)
              if (!ev.partial && cleanedText) {
                const turn = store.addTranscriptTurn({
                  meetingId: meeting.id,
                  speaker: ev.name || 'You',
                  participantId: ev.participantId ?? null,
                  text: cleanedText,
                  t0: ev.t0,
                  t1: ev.t1,
                })
                await synapse.ingest(
                  {
                    speaker: turn.speaker,
                    participantId: turn.participantId,
                    text: turn.text,
                    t0: turn.t0,
                    t1: turn.t1,
                    partial: false,
                    conversationId: meeting.id,
                    sourceId: `turn-${turn.id}`,
                  },
                  settings.groupId,
                )
                broadcast('meeting:turn', {
                  meetingId: meeting.id,
                  turn,
                  meeting: store.getMeeting(meeting.id),
                })
              } else if (ev.partial && cleanedText) {
                broadcast('meeting:partial', {
                  meetingId: meeting.id,
                  speaker: ev.name || 'You',
                  text: cleanedText,
                  t0: ev.t0,
                })
              }
            }
          }
        })().catch(() => {})
      }

      broadcast('state:refresh', await getFullAppState())
      return meeting
    },
  )

  ipcMain.handle('nectar:pauseCapture', async () => {
    capturePaused = true
    if (activeCaptureSession && 'pause' in activeCaptureSession) {
      ;(activeCaptureSession as unknown as { pause(): void }).pause()
    }
    broadcast('audio:level', { level: 0 })
    const state = await getFullAppState()
    broadcast('state:refresh', state)
    return state
  })

  ipcMain.handle('nectar:resumeCapture', async () => {
    capturePaused = false
    if (activeCaptureSession && 'resume' in activeCaptureSession) {
      ;(activeCaptureSession as unknown as { resume(): void }).resume()
    }
    const state = await getFullAppState()
    broadcast('state:refresh', state)
    return state
  })

  ipcMain.handle('nectar:focusMainWindow', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
    return { ok: true }
  })

  ipcMain.on('nectar:startPillDrag', () => {
    if (pillWindow && !pillWindow.isDestroyed()) {
      const cursor = screen.getCursorScreenPoint()
      const bounds = pillWindow.getBounds()
      pillDragOffset = {
        x: cursor.x - bounds.x,
        y: cursor.y - bounds.y,
      }
    }
  })

  ipcMain.on('nectar:dragPill', () => {
    if (pillWindow && !pillWindow.isDestroyed() && pillDragOffset) {
      const cursor = screen.getCursorScreenPoint()
      const bounds = pillWindow.getBounds()
      const clamped = clampPillBounds(
        cursor.x - pillDragOffset.x,
        cursor.y - pillDragOffset.y,
        bounds.width,
        bounds.height,
      )
      pillWindow.setPosition(clamped.x, clamped.y, false)
    }
  })

  ipcMain.handle('nectar:stopCapture', async () => {
    if (simulationTimer) {
      clearInterval(simulationTimer)
      simulationTimer = null
    }
    if (activeStreamingWs) {
      await activeStreamingWs.finish().catch(() => {})
      activeStreamingWs = null
    }
    if (activeCaptureSession) {
      await activeCaptureSession.close().catch(() => {})
      activeCaptureSession = null
    }
    streamingWsStatus = {
      status: 'idle',
      numSpeakers: 0,
      lastLatencyMs: null,
      error: null,
    }
    broadcast('streaming:status', { streamingWs: streamingWsStatus })
    const stoppedMeetingId = activeCaptureMeetingId
    activeCaptureMeetingId = null
    capturePaused = false
    broadcast('audio:level', { level: 0 })
    if (stoppedMeetingId) {
      store.updateMeeting(stoppedMeetingId, {
        status: 'completed',
        endedAt: new Date().toISOString(),
      })
    }
    const state = await getFullAppState()
    broadcast('state:refresh', state)
    return state
  })

  ipcMain.handle('nectar:simulateLiveMeeting', async () => {
    if (simulationTimer) {
      clearInterval(simulationTimer)
      simulationTimer = null
    }

    const meeting = store.createMeeting({
      title: 'Apple Silicon Inference & Synapse Sync',
      platform: 'google-meet',
      url: 'https://meet.google.com/syn-apse-ai',
      status: 'recording',
      participants: ['Maya', 'Rishi', 'Sam'],
      roughNotes:
        '- Reviewing Cortex 0.1.0 memory footprint on M4 Max\n- Confirming who owns vector-indexer migration\n- [ ] Rishi: Benchmark TTFT with Gemma 4 E2B Q4_K_M',
    })
    activeCaptureMeetingId = meeting.id
    capturePaused = false
    broadcast('state:refresh', await getFullAppState())

    const script = [
      {
        speaker: 'Maya',
        text: 'Maya owns vector-indexer migration for the Synapse 0.2 release.',
        t0: 2.4,
        t1: 7.8,
      },
      {
        speaker: 'Rishi',
        text: 'We decided Cortex will use WhisperKit and SpeakerKit on Apple Neural Engine with zero ScreenCaptureKit permissions.',
        t0: 8.5,
        t1: 15.2,
      },
      {
        speaker: 'Sam',
        text: 'Awesome—Rishi will benchmark Gemma 4 E2B TTFT and publish the telemetry by Friday.',
        t0: 16.0,
        t1: 22.1,
      },
    ]

    let idx = 0
    const settings = store.getSettings()
    simulationTimer = setInterval(async () => {
      if (capturePaused) return
      if (idx >= script.length) {
        if (simulationTimer) {
          clearInterval(simulationTimer)
          simulationTimer = null
        }
        activeCaptureMeetingId = null
        capturePaused = false
        broadcast('audio:level', { level: 0 })
        const full = store.getMeeting(meeting.id)!
        const distilled = await distillMeeting(full, settings, cortexUrl)
        store.updateMeeting(meeting.id, {
          status: 'completed',
          endedAt: new Date().toISOString(),
          distilledNotes: distilled.distilledNotes,
          actionItems: distilled.actionItems,
          decisions: distilled.decisions,
        })
        await synapse.ingest(
          new SourceEvent({
            sourceId: `meeting-${meeting.id}`,
            sourceType: SourceType.MEETING,
            conversationId: meeting.id,
            content: full.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n'),
            participants: full.participants,
            occurredAt: new Date(full.startedAt),
            metadata: {
              semantic_assertions: distilled.assertions,
            },
          }),
          settings.groupId,
        )
        await synapse.consolidate(settings.groupId)
        broadcast('state:refresh', await getFullAppState())
        return
      }

      const item = script[idx++]!
      broadcast('audio:level', { level: 0.28 })
      const turn = store.addTranscriptTurn({
        meetingId: meeting.id,
        speaker: item.speaker,
        text: item.text,
        t0: item.t0,
        t1: item.t1,
      })
      broadcast('meeting:turn', {
        meetingId: meeting.id,
        turn,
        meeting: store.getMeeting(meeting.id),
      })
    }, 1200)

    return meeting
  })

  ipcMain.handle(
    'nectar:installMcp',
    async (
      _e,
      target: 'claude' | 'codex' | 'cursor' | 'copilot' | 'vscode',
    ) => {
      const home = os.homedir()
      const stdioScriptPath = unpackPath(
        path.resolve(__dirname, '..', 'bin', 'nectar-mcp.js'),
      )

      const mergeJsonMcp = (
        filePath: string,
        entry: Record<string, unknown>,
        rootKey = 'mcpServers',
      ) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        let current: Record<string, unknown> = {}
        if (fs.existsSync(filePath)) {
          try {
            current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<
              string,
              unknown
            >
          } catch {
            current = {}
          }
        }
        const servers =
          current[rootKey] && typeof current[rootKey] === 'object'
            ? (current[rootKey] as Record<string, unknown>)
            : {}
        servers.nectar = entry
        current[rootKey] = servers
        fs.writeFileSync(filePath, JSON.stringify(current, null, 2) + '\n', 'utf8')
      }

      let targetPath = ''
      if (target === 'claude') {
        const claudeCodePath = path.join(home, '.claude.json')
        const claudeDesktopPath = path.join(
          home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        )
        const entry = { command: 'node', args: [stdioScriptPath] }
        mergeJsonMcp(claudeCodePath, entry)
        mergeJsonMcp(claudeDesktopPath, entry)
        targetPath = claudeCodePath
      } else if (target === 'cursor') {
        const cursorPath = path.join(home, '.cursor', 'mcp.json')
        mergeJsonMcp(cursorPath, { command: 'node', args: [stdioScriptPath] })
        targetPath = cursorPath
      } else if (target === 'copilot') {
        const copilotPath = path.join(home, '.copilot', 'mcp-config.json')
        mergeJsonMcp(copilotPath, {
          type: 'local',
          command: 'node',
          args: [stdioScriptPath],
          tools: ['*'],
        })
        targetPath = copilotPath
      } else if (target === 'vscode') {
        const vscodePath = path.join(
          home,
          'Library',
          'Application Support',
          'Code',
          'User',
          'mcp.json',
        )
        mergeJsonMcp(
          vscodePath,
          { type: 'stdio', command: 'node', args: [stdioScriptPath] },
          'servers',
        )
        targetPath = vscodePath
      } else if (target === 'codex') {
        const codexPath = path.join(home, '.codex', 'config.toml')
        fs.mkdirSync(path.dirname(codexPath), { recursive: true })
        let toml = fs.existsSync(codexPath)
          ? fs.readFileSync(codexPath, 'utf8')
          : ''
        const block = `\n[mcp_servers.nectar]\ncommand = "node"\nargs = [${JSON.stringify(stdioScriptPath)}]\n`
        if (toml.includes('[mcp_servers.nectar]')) {
          toml = toml.replace(
            /\[mcp_servers\.nectar\][\s\S]*?(?=\n\[|$)/,
            block.trim(),
          )
        } else {
          toml = toml.trimEnd() + '\n' + block
        }
        fs.writeFileSync(codexPath, toml, 'utf8')
        targetPath = codexPath
      } else {
        throw new Error(`Unknown MCP install target: ${String(target)}`)
      }

      const nextState = await getFullAppState()
      broadcast('state:refresh', nextState)
      return {
        ok: true,
        target,
        path: targetPath,
        installed: nextState.mcp.installed,
      }
    },
  )
}

async function createWindow(): Promise<void> {
  const iconPath = path.join(__dirname, '..', 'public', 'icon.png')
  if (fs.existsSync(iconPath)) {
    app.dock?.setIcon(iconPath)
  }

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F5F5F2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    await mainWindow.loadURL(devUrl)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
}

function clampPillBounds(
  rawX: number,
  rawY: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const displays = screen.getAllDisplays()
  const margin = 6

  // Global horizontal span across all connected displays
  const globalMinX = Math.min(...displays.map((d) => d.bounds.x)) + margin
  const globalMaxX =
    Math.max(...displays.map((d) => d.bounds.x + d.bounds.width)) - width - margin

  const nextX = Math.max(globalMinX, Math.min(globalMaxX, Math.round(rawX)))
  const centerX = nextX + Math.round(width / 2)
  const centerY = Math.round(rawY + height / 2)

  // Find the display that owns this horizontal X position
  const activeDisplay =
    displays.find(
      (d) => centerX >= d.bounds.x && centerX <= d.bounds.x + d.bounds.width,
    ) ?? screen.getDisplayNearestPoint({ x: centerX, y: centerY })

  const topLimit = activeDisplay.workArea.y + margin
  const bottomLimit =
    activeDisplay.bounds.y + activeDisplay.bounds.height - height - margin
  const nextY = Math.max(topLimit, Math.min(bottomLimit, Math.round(rawY)))

  return { x: nextX, y: nextY }
}

async function createPillWindow(): Promise<void> {
  const display = screen.getPrimaryDisplay()
  const db = display.bounds
  const pillWidth = 40
  const pillHeight = 136
  const margin = 6

  pillWindow = new BrowserWindow({
    width: pillWidth,
    height: pillHeight,
    x: db.x + db.width - pillWidth - margin,
    y: db.y + db.height - pillHeight - margin,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    await pillWindow.loadURL(`${devUrl}?view=pill`)
  } else {
    await pillWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
      search: 'view=pill',
    })
  }
}

app.whenReady().then(async () => {
  store = new NectarStore()
  // Sanitize any existing transcript turns and meeting summaries that contained raw Whisper <|...|> tokens
  const existingTurns = store.db
    .prepare(
      `SELECT id, text, speaker FROM transcript_turns WHERE text LIKE '%<|%' OR speaker = 'Speaker'`,
    )
    .all() as Array<{ id: string; text: string; speaker: string }>
  for (const row of existingTurns) {
    const cleaned = cleanWhisperText(row.text)
    const speaker = row.speaker === 'Speaker' ? 'You' : row.speaker
    store.db
      .prepare(`UPDATE transcript_turns SET text = ?, speaker = ? WHERE id = ?`)
      .run(cleaned, speaker, row.id)
  }

  for (const m of store.listMeetings()) {
    if (m.distilledNotes.includes('<|') || m.participants.includes('Speaker')) {
      const cleanedNotes = m.distilledNotes.replace(/<\|[^|]*\|>/g, '').replace(/Speaker/g, 'You')
      const cleanedParticipants = m.participants.map((p) => (p === 'Speaker' ? 'You' : p))
      store.updateMeeting(m.id, {
        distilledNotes: cleanedNotes,
        participants: Array.from(new Set(cleanedParticipants)),
      })
    }
  }

  const settings = store.getSettings()

  mcpServer = new McpHttpServer(store, () => synapse)
  await mcpServer.start(settings.mcpPort)

  await initComputeAndPerception(settings)
  if (anyServiceUsesLocal(settings)) {
    await pollCortexHealth(settings.localPort)
  }

  await seedInitialWorkspaceIfEmpty()

  registerIpcHandlers()
  await createWindow()
  await createPillWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', async () => {
  stopHealthPolling()
  if (simulationTimer) clearInterval(simulationTimer)
  if (activeStreamingWs) await activeStreamingWs.finish(1000).catch(() => {})
  if (activeCaptureSession) await activeCaptureSession.close().catch(() => {})
  if (watcher) watcher.close()
  if (aira) await aira.close().catch(() => {})
  if (cortexServer) await cortexServer.stop().catch(() => {})
  if (mcpServer) await mcpServer.stop().catch(() => {})
  if (synapse) await synapse.close().catch(() => {})
  if (store) store.close()
})
