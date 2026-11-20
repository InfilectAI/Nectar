export type ServiceMode = 'local' | 'cloud'
export type AuthScheme = 'Bearer' | 'Api-Key' | 'Token' | 'none'
export type CloudSttProvider =
  | 'websocket'
  | 'deepgram'
  | 'assemblyai'
  | 'openai'
  | 'gemini'
  | 'custom'
export type CloudAiProvider = 'openai-compatible' | 'openai' | 'gemini' | 'custom'

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

export interface StreamingWsStatus {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  numSpeakers: number
  lastLatencyMs: number | null
  error: string | null
}

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

export interface NectarSettings {
  mode: 'local' | 'cloud' | 'hybrid'
  onboardingCompleted: boolean
  groupId: string
  localPort: number
  mcpPort: number

  sttMode: ServiceMode
  diarizeMode: ServiceMode
  llmMode: ServiceMode
  embeddingMode: ServiceMode
  sttIncludesDiarization: boolean

  cloudSttProvider: CloudSttProvider
  cloudAiProvider: CloudAiProvider

  sttUrl: string
  sttModel: string
  sttApiKey: string
  sttAuthScheme: AuthScheme
  sttWsMode: 'meeting' | 'call'
  sttLanguage: string

  diarizeUrl: string
  diarizeApiKey: string
  diarizeAuthScheme: AuthScheme

  llmBaseUrl: string
  llmModel: string
  llmApiKey: string
  llmAuthScheme: AuthScheme

  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKey: string
  embeddingAuthScheme: AuthScheme
}

export interface ActionItem {
  owner: string
  task: string
  status: 'open' | 'done'
}

export interface TranscriptTurnRow {
  id: string
  meetingId: string
  speaker: string
  participantId: string | null
  text: string
  t0: number
  t1: number
  createdAt: string
}

export interface MeetingRecord {
  id: string
  title: string
  platform: string
  url: string
  startedAt: string
  endedAt: string | null
  status: 'recording' | 'completed'
  participants: string[]
  roughNotes: string
  distilledNotes: string
  actionItems: ActionItem[]
  decisions: string[]
  episodeId: string | null
  turns: TranscriptTurnRow[]
}

export interface MeetingTarget {
  pid: number
  browser: string
  platform: string
  url: string
  title: string
}

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

export interface AppState {
  settings: NectarSettings
  cortexStatus: CortexRuntimeStatus
  cortexUrl: string | null
  cortexError: string | null
  localModels: LocalModelInfo[]
  streamingWs: StreamingWsStatus
  detectedMeetings: MeetingTarget[]
  activeCaptureMeetingId: string | null
  activeCaptureKind: 'meeting' | 'self-note' | null
  capturePaused: boolean
  permissions: Record<string, string>
  meetings: MeetingRecord[]
  mcp: {
    url: string
    port: number
    tools: Array<{ name: string; description: string }>
    requestsHandled: number
    stdioScriptPath: string
    installed: Record<'claude' | 'codex' | 'cursor' | 'copilot' | 'vscode', boolean>
  }
}

declare global {
  interface Window {
    nectar: {
      getState(): Promise<AppState>
      saveSettings(patch: Partial<NectarSettings>): Promise<AppState>
      checkPermissions(prompt: boolean): Promise<Record<string, string>>
      completeOnboarding(): Promise<AppState>
      refreshLocalModels(): Promise<{
        cortexStatus: CortexRuntimeStatus
        cortexUrl: string | null
        cortexError: string | null
        localModels: LocalModelInfo[]
      }>
      downloadLocalModel(modelId: LocalModelId): Promise<{ ok: boolean }>
      downloadAllLocalModels(modelIds?: LocalModelId[]): Promise<{ ok: boolean }>
      cancelLocalModelDownload(modelId: LocalModelId): Promise<{ ok: boolean }>
      restartCortex(): Promise<AppState>
      openModelsFolder(): Promise<{ ok: boolean; path: string }>
      testSttConnection(config: {
        url: string
        apiKey?: string
        authScheme?: AuthScheme
        language?: string
        mode?: 'meeting' | 'call'
      }): Promise<{ ok: boolean; latencyMs: number; message: string }>
      validateCloudSettings(
        draft: Partial<NectarSettings>,
      ): Promise<CloudValidationResponse>
      createMeeting(input: {
        title?: string
        platform?: string
        url?: string
        roughNotes?: string
      }): Promise<MeetingRecord>
      updateMeeting(id: string, patch: Partial<MeetingRecord>): Promise<MeetingRecord>
      deleteMeeting(id: string): Promise<{ ok: boolean }>
      distillMeeting(id: string): Promise<MeetingRecord>
      startCapture(target?: MeetingTarget, meetingId?: string): Promise<MeetingRecord>
      startSelfNote(meetingId?: string): Promise<MeetingRecord>
      pauseCapture(): Promise<AppState>
      resumeCapture(): Promise<AppState>
      stopCapture(): Promise<AppState>
      simulateLiveMeeting(): Promise<MeetingRecord>
      focusMainWindow(): Promise<{ ok: boolean }>
      startPillDrag(): void
      dragPill(): void
      installMcp(
        target: 'claude' | 'codex' | 'cursor' | 'copilot' | 'vscode',
      ): Promise<{
        ok: boolean
        target: string
        path: string
        installed: Record<'claude' | 'codex' | 'cursor' | 'copilot' | 'vscode', boolean>
      }>
      onEvent(callback: (payload: Record<string, unknown>) => void): () => void
    }
  }
}
