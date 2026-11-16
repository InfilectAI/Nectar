export type CloudSttProvider = 'deepgram' | 'assemblyai' | 'openai' | 'gemini' | 'custom'
export type CloudAiProvider = 'openai' | 'gemini' | 'custom'

export interface NectarSettings {
  mode: 'local' | 'cloud'
  groupId: string
  localPort: number
  mcpPort: number

  cloudSttProvider: CloudSttProvider
  cloudSttModel: string
  cloudSttApiKey: string

  cloudAiProvider: CloudAiProvider
  cloudLlmModel: string
  cloudEmbeddingModel: string
  cloudAiApiKey: string

  sttUrl: string
  sttModel: string
  sttApiKey: string

  diarizeUrl: string
  diarizeModel: string
  diarizeApiKey: string

  llmBaseUrl: string
  llmModel: string
  llmApiKey: string

  embeddingBaseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingApiKey: string
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

export interface RecallCitation {
  kind: 'episode' | 'external'
  id: string
  label: string
  excerpt?: string | null
  url?: string | null
}

export interface RecallResult {
  query: string
  answer: string | null
  answerOrigin: 'episodic' | 'semantic_fallback' | 'miss'
  citations: RecallCitation[]
  selectedIds: string[]
  scoreDetails: Record<string, unknown>
  createdEpisodeId?: string | null
  latencyMs: number
}

export interface GraphEntity {
  id: string
  kind: string
  canonicalName: string
  normalizedName: string
  description: string | null
  confidence: number
  aliases: Array<{ alias: string }>
}

export interface GraphRelationship {
  id: string
  predicate: string
  confidence: number
  validAt: string
  invalidAt: string | null
  status: string
  subject: GraphEntity
  object: GraphEntity
  evidence: Array<{ episodeId: string; excerpt: string }>
}

export interface SkillSpecView {
  id: string
  patternId: string
  name: string
  version: number
  status: string
  purpose: string
  triggers: string[]
  steps: string[]
  confidence: number
}

export interface AppState {
  settings: NectarSettings
  cortexStatus: 'running' | 'starting' | 'stopped' | 'cloud'
  cortexUrl: string | null
  cortexPrimitives: Record<string, string>
  detectedMeetings: MeetingTarget[]
  activeCaptureMeetingId: string | null
  capturePaused: boolean
  permissions: Record<string, string>
  meetings: MeetingRecord[]
  graph: {
    entities: GraphEntity[]
    relationships: GraphRelationship[]
    statements: Array<Record<string, unknown>>
    skills: SkillSpecView[]
    patterns: Array<Record<string, unknown>>
  }
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
      pauseCapture(): Promise<AppState>
      resumeCapture(): Promise<AppState>
      stopCapture(): Promise<AppState>
      simulateLiveMeeting(): Promise<MeetingRecord>
      focusMainWindow(): Promise<{ ok: boolean }>
      startPillDrag(): void
      dragPill(): void
      recall(query: string): Promise<RecallResult>
      getKnowledgeGraph(includeSuperseded?: boolean): Promise<AppState['graph']>
      consolidateMemory(): Promise<unknown>
      detectProcedures(): Promise<unknown>
      setSkillStatus(
        skillId: string,
        status: 'candidate' | 'approved' | 'rejected',
      ): Promise<{ ok: boolean }>
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
