import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type LocalModelId = 'stt' | 'diarize' | 'chat' | 'embed'

export type LocalModelStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'error'

export type CortexRuntimeStatus = 'running' | 'starting' | 'stopped' | 'error' | 'cloud'

export type PrimitiveRuntimeState =
  | 'unloaded'
  | 'loading'
  | 'loaded'
  | 'error'
  | 'unavailable'

export interface LocalModelInfo {
  id: LocalModelId
  name: string
  modelName: string
  role: string
  engine: string
  required: boolean
  kind: 'coreml' | 'gguf'
  status: LocalModelStatus
  runtimeState: PrimitiveRuntimeState
  installedOnDisk: boolean
  canCancel: boolean
  progress: number | null
  downloadedBytes: number
  totalBytes: number | null
  bytesPerSec: number | null
  detail: string | null
  error: string | null
  localPath: string | null
}

const FALLBACK_CATALOG: ReadonlyArray<
  Pick<
    LocalModelInfo,
    'id' | 'name' | 'modelName' | 'role' | 'engine' | 'required' | 'kind' | 'totalBytes'
  >
> = [
  {
    id: 'stt',
    name: 'WhisperKit',
    modelName: 'whisper-large-v3',
    role: 'Live Transcription',
    engine: 'Core ML · Apple Neural Engine',
    required: true,
    kind: 'coreml',
    totalBytes: 950 * 1024 * 1024,
  },
  {
    id: 'diarize',
    name: 'SpeakerKit',
    modelName: 'pyannote-speakerkit',
    role: 'Speaker Diarization',
    engine: 'Core ML · Apple Neural Engine',
    required: true,
    kind: 'coreml',
    totalBytes: 120 * 1024 * 1024,
  },
  {
    id: 'chat',
    name: 'Gemma 4 E2B',
    modelName: 'google_gemma-4-E2B-it-Q4_K_M.gguf',
    role: 'Note Enhancement',
    engine: 'llama.cpp · Metal GPU',
    required: false,
    kind: 'gguf',
    totalBytes: 3_462_680_032,
  },
  {
    id: 'embed',
    name: 'EmbeddingGemma 300M',
    modelName: 'embeddinggemma-300M-Q8_0.gguf',
    role: 'Memory Embeddings',
    engine: 'llama.cpp · Metal GPU',
    required: false,
    kind: 'gguf',
    totalBytes: 333_590_944,
  },
]

export function getModelsDir(): string {
  const dir = process.env.CORTEX_MODELS_DIR || path.join(os.homedir(), '.cortex', 'models')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function fallbackLocalModels(
  cortexStatus: CortexRuntimeStatus,
  primitives: Record<string, string> = {},
): LocalModelInfo[] {
  return FALLBACK_CATALOG.map((spec) => {
    const raw = cortexStatus === 'running' ? primitives[spec.id] : undefined
    const runtimeState: PrimitiveRuntimeState =
      raw === 'unloaded' || raw === 'loading' || raw === 'loaded' || raw === 'error'
        ? raw
        : 'unavailable'
    const status: LocalModelStatus =
      runtimeState === 'loaded'
        ? 'ready'
        : runtimeState === 'loading'
          ? 'loading'
          : runtimeState === 'error'
            ? 'error'
            : 'not_downloaded'
    return {
      ...spec,
      status,
      runtimeState,
      installedOnDisk: status === 'ready',
      canCancel: false,
      progress: status === 'ready' ? 1 : status === 'not_downloaded' ? 0 : null,
      downloadedBytes: 0,
      bytesPerSec: null,
      detail:
        cortexStatus === 'starting'
          ? 'Starting local runtime…'
          : cortexStatus === 'running'
            ? status === 'ready'
              ? 'Loaded in memory'
              : 'Not downloaded'
            : 'Local runtime offline',
      error: null,
      localPath: null,
    }
  })
}

export async function fetchCortexModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<LocalModelInfo[] | null> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, { signal })
  if (!res.ok) return null
  const data = (await res.json()) as { models?: LocalModelInfo[] }
  return Array.isArray(data.models) ? data.models : null
}

export async function startCortexModelDownload(
  baseUrl: string,
  id: LocalModelId,
): Promise<LocalModelInfo> {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(id)}/download`,
    { method: 'POST' },
  )
  if (!res.ok) {
    throw new Error(`Cortex download failed (HTTP ${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as LocalModelInfo
}

export async function cancelCortexModelDownload(
  baseUrl: string,
  id: LocalModelId,
): Promise<LocalModelInfo> {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(id)}/download`,
    { method: 'DELETE' },
  )
  if (!res.ok) {
    throw new Error(`Cortex cancel failed (HTTP ${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as LocalModelInfo
}
