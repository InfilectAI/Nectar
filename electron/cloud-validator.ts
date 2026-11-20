import { resolveEmbeddingEndpoint, resolveLlmEndpoint } from './distiller.js'
import {
  getEffectiveServiceModes,
  type NectarSettings,
} from './store.js'
import {
  buildAuthHeader,
  testStreamingWsConnection,
} from './streaming-ws.js'

export type CloudServiceKey = 'stt' | 'diarize' | 'llm' | 'embedding'

export interface ServiceValidationResult {
  service: CloudServiceKey
  ok: boolean
  skipped?: boolean
  latencyMs: number
  message: string
}

export interface CloudValidationResponse {
  ok: boolean
  results: ServiceValidationResult[]
}

/** Builds a tiny valid 0.15s silent 16kHz mono PCM16 WAV buffer for HTTP audio smoke tests. */
function makeSilentWavBuffer(durationSec: number = 0.15): Buffer {
  const sampleRate = 16_000
  const numSamples = Math.max(160, Math.round(sampleRate * durationSec))
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // PCM format
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = 10_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readErrorSnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim()
    if (!text) return res.statusText || `HTTP ${res.status}`
    try {
      const json = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
        detail?: string
      }
      if (typeof json.error === 'string') return json.error.slice(0, 160)
      if (json.error && typeof json.error === 'object' && json.error.message) {
        return String(json.error.message).slice(0, 160)
      }
      if (json.message) return String(json.message).slice(0, 160)
      if (json.detail) return String(json.detail).slice(0, 160)
    } catch {
      // plain text body
    }
    return text.slice(0, 160)
  } catch {
    return res.statusText || `HTTP ${res.status}`
  }
}

function formatNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'Connection timed out'
    return err.message
  }
  return String(err)
}

export async function validateSttService(
  settings: NectarSettings,
  timeoutMs: number = 10_000,
): Promise<ServiceValidationResult> {
  const modes = getEffectiveServiceModes(settings)
  if (modes.stt !== 'cloud') {
    return { service: 'stt', ok: true, skipped: true, latencyMs: 0, message: 'Local' }
  }

  const provider = settings.cloudSttProvider || 'websocket'
  const apiKey = settings.sttApiKey.trim()
  const t0 = Date.now()

  if (provider === 'websocket') {
    const url = settings.sttUrl.trim()
    if (!url) {
      return {
        service: 'stt',
        ok: false,
        latencyMs: 0,
        message: 'WebSocket URL is required.',
      }
    }
    const res = await testStreamingWsConnection(
      {
        url,
        apiKey,
        authScheme: settings.sttAuthScheme,
        language: settings.sttLanguage,
        mode: settings.sttWsMode,
      },
      timeoutMs,
    )
    return {
      service: 'stt',
      ok: res.ok,
      latencyMs: res.latencyMs,
      message: res.message,
    }
  }

  if (provider === 'deepgram') {
    if (!apiKey) {
      return { service: 'stt', ok: false, latencyMs: 0, message: 'Deepgram API key is required.' }
    }
    try {
      const res = await fetchWithTimeout(
        'https://api.deepgram.com/v1/projects',
        { headers: { Authorization: `Token ${apiKey}` } },
        timeoutMs,
      )
      if (!res.ok) {
        return {
          service: 'stt',
          ok: false,
          latencyMs: Date.now() - t0,
          message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
        }
      }
      return {
        service: 'stt',
        ok: true,
        latencyMs: Date.now() - t0,
        message: `Connected (${Date.now() - t0} ms)`,
      }
    } catch (err) {
      return {
        service: 'stt',
        ok: false,
        latencyMs: Date.now() - t0,
        message: formatNetworkError(err),
      }
    }
  }

  if (provider === 'assemblyai') {
    if (!apiKey) {
      return { service: 'stt', ok: false, latencyMs: 0, message: 'AssemblyAI API key is required.' }
    }
    try {
      const res = await fetchWithTimeout(
        'https://api.assemblyai.com/v2/transcript?limit=1',
        { headers: { Authorization: apiKey } },
        timeoutMs,
      )
      if (!res.ok) {
        return {
          service: 'stt',
          ok: false,
          latencyMs: Date.now() - t0,
          message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
        }
      }
      return {
        service: 'stt',
        ok: true,
        latencyMs: Date.now() - t0,
        message: `Connected (${Date.now() - t0} ms)`,
      }
    } catch (err) {
      return {
        service: 'stt',
        ok: false,
        latencyMs: Date.now() - t0,
        message: formatNetworkError(err),
      }
    }
  }

  if (provider === 'openai') {
    if (!apiKey) {
      return { service: 'stt', ok: false, latencyMs: 0, message: 'OpenAI API key is required.' }
    }
    try {
      const res = await fetchWithTimeout(
        'https://api.openai.com/v1/models',
        { headers: { Authorization: `Bearer ${apiKey}` } },
        timeoutMs,
      )
      if (!res.ok) {
        return {
          service: 'stt',
          ok: false,
          latencyMs: Date.now() - t0,
          message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
        }
      }
      return {
        service: 'stt',
        ok: true,
        latencyMs: Date.now() - t0,
        message: `Connected (${Date.now() - t0} ms)`,
      }
    } catch (err) {
      return {
        service: 'stt',
        ok: false,
        latencyMs: Date.now() - t0,
        message: formatNetworkError(err),
      }
    }
  }

  if (provider === 'gemini') {
    if (!apiKey) {
      return { service: 'stt', ok: false, latencyMs: 0, message: 'Gemini API key is required.' }
    }
    try {
      const res = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { method: 'GET' },
        timeoutMs,
      )
      if (!res.ok) {
        return {
          service: 'stt',
          ok: false,
          latencyMs: Date.now() - t0,
          message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
        }
      }
      return {
        service: 'stt',
        ok: true,
        latencyMs: Date.now() - t0,
        message: `Connected (${Date.now() - t0} ms)`,
      }
    } catch (err) {
      return {
        service: 'stt',
        ok: false,
        latencyMs: Date.now() - t0,
        message: formatNetworkError(err),
      }
    }
  }

  // Custom HTTP STT endpoint
  const url = settings.sttUrl.trim()
  if (!url || !isValidHttpUrl(url)) {
    return {
      service: 'stt',
      ok: false,
      latencyMs: 0,
      message: 'Enter a valid http(s) STT endpoint URL.',
    }
  }
  try {
    const headers: Record<string, string> = {}
    const auth = buildAuthHeader(settings.sttAuthScheme, apiKey)
    if (auth) headers.Authorization = auth
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(makeSilentWavBuffer())], { type: 'audio/wav' }),
      'ping.wav',
    )
    if (settings.sttModel.trim()) {
      form.append('model', settings.sttModel.trim())
    }
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: form }, timeoutMs)
    if (!res.ok) {
      return {
        service: 'stt',
        ok: false,
        latencyMs: Date.now() - t0,
        message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
      }
    }
    return {
      service: 'stt',
      ok: true,
      latencyMs: Date.now() - t0,
      message: `Verified (${Date.now() - t0} ms)`,
    }
  } catch (err) {
    return {
      service: 'stt',
      ok: false,
      latencyMs: Date.now() - t0,
      message: formatNetworkError(err),
    }
  }
}

export async function validateDiarizeService(
  settings: NectarSettings,
  timeoutMs: number = 10_000,
): Promise<ServiceValidationResult> {
  const modes = getEffectiveServiceModes(settings)
  if (
    modes.diarize !== 'cloud' ||
    (modes.stt === 'cloud' && settings.sttIncludesDiarization)
  ) {
    return { service: 'diarize', ok: true, skipped: true, latencyMs: 0, message: 'Skipped' }
  }

  const url = settings.diarizeUrl.trim()
  if (!url || !isValidHttpUrl(url)) {
    return {
      service: 'diarize',
      ok: false,
      latencyMs: 0,
      message: 'Enter a valid http(s) diarization endpoint URL.',
    }
  }

  const t0 = Date.now()
  try {
    const headers: Record<string, string> = {}
    const key = settings.diarizeApiKey.trim() || settings.sttApiKey.trim()
    const auth = buildAuthHeader(settings.diarizeAuthScheme ?? 'Api-Key', key)
    if (auth) headers.Authorization = auth
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(makeSilentWavBuffer())], { type: 'audio/wav' }),
      'ping.wav',
    )
    const res = await fetchWithTimeout(url, { method: 'POST', headers, body: form }, timeoutMs)
    if (!res.ok) {
      return {
        service: 'diarize',
        ok: false,
        latencyMs: Date.now() - t0,
        message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
      }
    }
    return {
      service: 'diarize',
      ok: true,
      latencyMs: Date.now() - t0,
      message: `Verified (${Date.now() - t0} ms)`,
    }
  } catch (err) {
    return {
      service: 'diarize',
      ok: false,
      latencyMs: Date.now() - t0,
      message: formatNetworkError(err),
    }
  }
}

export async function validateLlmService(
  settings: NectarSettings,
  timeoutMs: number = 10_000,
): Promise<ServiceValidationResult> {
  const modes = getEffectiveServiceModes(settings)
  if (modes.llm !== 'cloud') {
    return { service: 'llm', ok: true, skipped: true, latencyMs: 0, message: 'Local' }
  }

  const isCustomBase =
    settings.cloudAiProvider === 'openai-compatible' ||
    settings.cloudAiProvider === 'custom'
  if (isCustomBase && (!settings.llmBaseUrl.trim() || !isValidHttpUrl(settings.llmBaseUrl.trim()))) {
    return {
      service: 'llm',
      ok: false,
      latencyMs: 0,
      message: 'Enter a valid http(s) LLM Base URL.',
    }
  }

  const resolved = resolveLlmEndpoint(settings, null)
  if (resolved.authScheme !== 'none' && !resolved.apiKey.trim()) {
    return {
      service: 'llm',
      ok: false,
      latencyMs: 0,
      message: 'LLM API key is required.',
    }
  }

  const t0 = Date.now()
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const auth = buildAuthHeader(resolved.authScheme, resolved.apiKey)
    if (auth) headers.Authorization = auth

    const res = await fetchWithTimeout(
      `${resolved.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolved.model || 'default',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          temperature: 0,
        }),
      },
      timeoutMs,
    )
    if (!res.ok) {
      return {
        service: 'llm',
        ok: false,
        latencyMs: Date.now() - t0,
        message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
      }
    }
    return {
      service: 'llm',
      ok: true,
      latencyMs: Date.now() - t0,
      message: `Verified (${Date.now() - t0} ms)`,
    }
  } catch (err) {
    return {
      service: 'llm',
      ok: false,
      latencyMs: Date.now() - t0,
      message: formatNetworkError(err),
    }
  }
}

export async function validateEmbeddingService(
  settings: NectarSettings,
  timeoutMs: number = 10_000,
): Promise<ServiceValidationResult> {
  const modes = getEffectiveServiceModes(settings)
  if (modes.embedding !== 'cloud') {
    return { service: 'embedding', ok: true, skipped: true, latencyMs: 0, message: 'Local' }
  }

  const explicitUrl = settings.embeddingBaseUrl.trim()
  if (explicitUrl && !isValidHttpUrl(explicitUrl)) {
    return {
      service: 'embedding',
      ok: false,
      latencyMs: 0,
      message: 'Enter a valid http(s) Embedding Base URL.',
    }
  }
  if (!explicitUrl && modes.llm !== 'cloud') {
    return {
      service: 'embedding',
      ok: false,
      latencyMs: 0,
      message: 'Embedding Base URL is required when LLM is Local.',
    }
  }

  const resolved = resolveEmbeddingEndpoint(settings, null)
  if (!isValidHttpUrl(resolved.baseUrl)) {
    return {
      service: 'embedding',
      ok: false,
      latencyMs: 0,
      message: 'Enter a valid http(s) Embedding Base URL.',
    }
  }
  if (resolved.authScheme !== 'none' && !resolved.apiKey.trim()) {
    return {
      service: 'embedding',
      ok: false,
      latencyMs: 0,
      message: 'Embedding API key is required.',
    }
  }

  const t0 = Date.now()
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const auth = buildAuthHeader(resolved.authScheme, resolved.apiKey)
    if (auth) headers.Authorization = auth

    const res = await fetchWithTimeout(
      `${resolved.baseUrl}/embeddings`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: resolved.model || 'default',
          input: 'ping',
        }),
      },
      timeoutMs,
    )
    if (!res.ok) {
      return {
        service: 'embedding',
        ok: false,
        latencyMs: Date.now() - t0,
        message: `HTTP ${res.status}: ${await readErrorSnippet(res)}`,
      }
    }
    const body = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>
    }
    const vec = body.data?.[0]?.embedding
    if (!Array.isArray(vec) || vec.length === 0) {
      return {
        service: 'embedding',
        ok: false,
        latencyMs: Date.now() - t0,
        message: 'Endpoint responded 200 but did not return an embedding vector.',
      }
    }
    return {
      service: 'embedding',
      ok: true,
      latencyMs: Date.now() - t0,
      message: `Verified (${vec.length}d · ${Date.now() - t0} ms)`,
    }
  } catch (err) {
    return {
      service: 'embedding',
      ok: false,
      latencyMs: Date.now() - t0,
      message: formatNetworkError(err),
    }
  }
}

export async function validateCloudSettings(
  settings: NectarSettings,
  timeoutMs: number = 10_000,
): Promise<CloudValidationResponse> {
  const results = await Promise.all([
    validateSttService(settings, timeoutMs),
    validateDiarizeService(settings, timeoutMs),
    validateLlmService(settings, timeoutMs),
    validateEmbeddingService(settings, timeoutMs),
  ])
  return {
    ok: results.every((r) => r.ok),
    results,
  }
}
