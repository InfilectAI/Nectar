import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

export interface NectarSettings {
  mode: 'local' | 'cloud' | 'hybrid'
  onboardingCompleted: boolean
  groupId: string
  localPort: number
  mcpPort: number

  // Per-service runtime mode (mix & match Local and Cloud independently)
  sttMode: ServiceMode
  diarizeMode: ServiceMode
  llmMode: ServiceMode
  embeddingMode: ServiceMode
  sttIncludesDiarization: boolean

  // Cloud provider selectors
  cloudSttProvider: CloudSttProvider
  cloudAiProvider: CloudAiProvider

  // Per-service endpoint, auth scheme, model & key configuration
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

export const DEFAULT_SETTINGS: NectarSettings = {
  mode: 'local',
  onboardingCompleted: false,
  groupId: 'workspace',
  localPort: 8000,
  mcpPort: 4577,

  sttMode: 'local',
  diarizeMode: 'local',
  llmMode: 'local',
  embeddingMode: 'local',
  sttIncludesDiarization: false,

  cloudSttProvider: 'websocket',
  cloudAiProvider: 'openai-compatible',

  sttUrl: '',
  sttModel: '',
  sttApiKey: '',
  sttAuthScheme: 'Api-Key',
  sttWsMode: 'meeting',
  sttLanguage: 'auto',

  diarizeUrl: '',
  diarizeApiKey: '',
  diarizeAuthScheme: 'Api-Key',

  llmBaseUrl: '',
  llmModel: '',
  llmApiKey: '',
  llmAuthScheme: 'Bearer',

  embeddingBaseUrl: '',
  embeddingModel: '',
  embeddingApiKey: '',
  embeddingAuthScheme: 'Api-Key',
}

export function getEffectiveServiceModes(settings: NectarSettings): {
  stt: ServiceMode
  diarize: ServiceMode
  llm: ServiceMode
  embedding: ServiceMode
} {
  const stt = settings.sttMode ?? (settings.mode === 'cloud' ? 'cloud' : 'local')
  const diarize =
    stt === 'cloud' && settings.sttIncludesDiarization
      ? 'cloud'
      : settings.diarizeMode ?? (settings.mode === 'cloud' ? 'cloud' : 'local')
  const llm = settings.llmMode ?? (settings.mode === 'cloud' ? 'cloud' : 'local')
  const embedding =
    settings.embeddingMode ?? (settings.mode === 'cloud' ? 'cloud' : 'local')
  return { stt, diarize, llm, embedding }
}

export function computeOverallMode(
  settings: NectarSettings,
): 'local' | 'cloud' | 'hybrid' {
  const m = getEffectiveServiceModes(settings)
  const list = [m.stt, m.diarize, m.llm, m.embedding]
  if (list.every((x) => x === 'local')) return 'local'
  if (list.every((x) => x === 'cloud')) return 'cloud'
  return 'hybrid'
}

export function anyServiceUsesLocal(settings: NectarSettings): boolean {
  const m = getEffectiveServiceModes(settings)
  return (
    m.stt === 'local' ||
    m.diarize === 'local' ||
    m.llm === 'local' ||
    m.embedding === 'local'
  )
}

interface LegacySettingsFields {
  cloudSttModel?: string
  cloudSttApiKey?: string
  cloudLlmModel?: string
  cloudEmbeddingModel?: string
  cloudAiApiKey?: string
}

const LEGACY_LOCAL_MODELS = new Set([
  'whisper-large-v3',
  'pyannote-speakerkit',
  'gemma-4-E2B-it',
  'embeddinggemma-300M',
])

const LEGACY_LOCAL_URLS = new Set([
  'http://127.0.0.1:8000/v1',
  'http://127.0.0.1:8000/v1/audio/transcriptions',
  'http://127.0.0.1:8000/v1/audio/diarize',
])

function stripLegacyLocalUrl(url?: string): string {
  const trimmed = (url ?? '').trim()
  return LEGACY_LOCAL_URLS.has(trimmed) ? '' : trimmed
}

function stripLegacyLocalModel(model?: string): string {
  const trimmed = (model ?? '').trim()
  return LEGACY_LOCAL_MODELS.has(trimmed) ? '' : trimmed
}

export function normalizeSettings(
  raw: Partial<NectarSettings> & LegacySettingsFields,
): NectarSettings {
  const fallbackMode: ServiceMode = raw.mode === 'cloud' ? 'cloud' : 'local'
  const merged: NectarSettings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    sttMode: raw.sttMode ?? fallbackMode,
    diarizeMode: raw.diarizeMode ?? fallbackMode,
    llmMode: raw.llmMode ?? fallbackMode,
    embeddingMode: raw.embeddingMode ?? fallbackMode,
    sttUrl: stripLegacyLocalUrl(raw.sttUrl),
    diarizeUrl: stripLegacyLocalUrl(raw.diarizeUrl),
    llmBaseUrl: stripLegacyLocalUrl(raw.llmBaseUrl),
    embeddingBaseUrl: stripLegacyLocalUrl(raw.embeddingBaseUrl),
    sttModel: stripLegacyLocalModel(raw.sttModel || raw.cloudSttModel),
    sttApiKey: raw.sttApiKey || raw.cloudSttApiKey || '',
    llmModel: stripLegacyLocalModel(raw.llmModel || raw.cloudLlmModel),
    llmApiKey: raw.llmApiKey || raw.cloudAiApiKey || '',
    embeddingModel: stripLegacyLocalModel(
      raw.embeddingModel || raw.cloudEmbeddingModel,
    ),
  }
  merged.mode = computeOverallMode(merged)
  return merged
}

export function getNectarDataDir(): string {
  const dir = process.env.NECTAR_DATA_DIR ?? path.join(os.homedir(), '.nectar')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export class NectarStore {
  readonly db: DatabaseSync
  readonly dbPath: string

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(getNectarDataDir(), 'nectar.db')
    fs.mkdirSync(path.dirname(path.resolve(this.dbPath)), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA foreign_keys=ON')
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        platform TEXT NOT NULL,
        url TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'recording',
        participants TEXT NOT NULL DEFAULT '[]',
        rough_notes TEXT NOT NULL DEFAULT '',
        distilled_notes TEXT NOT NULL DEFAULT '',
        action_items TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        episode_id TEXT
      );

      CREATE TABLE IF NOT EXISTS transcript_turns (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        speaker TEXT NOT NULL,
        participant_id TEXT,
        text TEXT NOT NULL,
        t0 REAL NOT NULL,
        t1 REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ix_turns_meeting ON transcript_turns(meeting_id, t0);
    `)
  }

  getSettings(): NectarSettings {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = 'config'`)
      .get() as { value: string } | undefined
    if (!row) {
      return normalizeSettings({})
    }
    try {
      return normalizeSettings(JSON.parse(row.value) as Partial<NectarSettings>)
    } catch {
      return normalizeSettings({})
    }
  }

  saveSettings(patch: Partial<NectarSettings>): NectarSettings {
    const updated = normalizeSettings({ ...this.getSettings(), ...patch })
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('config', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(updated))
    return updated
  }

  listMeetings(): MeetingRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM meetings ORDER BY started_at DESC`)
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => this.hydrateMeeting(r))
  }

  getMeeting(id: string): MeetingRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM meetings WHERE id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.hydrateMeeting(row) : null
  }

  createMeeting(input: {
    id?: string
    title: string
    platform: string
    url: string
    startedAt?: string
    endedAt?: string | null
    status?: 'recording' | 'completed'
    participants?: string[]
    roughNotes?: string
    distilledNotes?: string
    actionItems?: ActionItem[]
    decisions?: string[]
    episodeId?: string | null
  }): MeetingRecord {
    const id = input.id ?? randomUUID()
    const startedAt = input.startedAt ?? new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO meetings (
          id, title, platform, url, started_at, ended_at, status,
          participants, rough_notes, distilled_notes, action_items, decisions, episode_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.platform,
        input.url,
        startedAt,
        input.endedAt ?? null,
        input.status ?? 'recording',
        JSON.stringify(input.participants ?? []),
        input.roughNotes ?? '',
        input.distilledNotes ?? '',
        JSON.stringify(input.actionItems ?? []),
        JSON.stringify(input.decisions ?? []),
        input.episodeId ?? null,
      )
    return this.getMeeting(id)!
  }

  updateMeeting(
    id: string,
    patch: Partial<{
      title: string
      platform: string
      url: string
      endedAt: string | null
      status: 'recording' | 'completed'
      participants: string[]
      roughNotes: string
      distilledNotes: string
      actionItems: ActionItem[]
      decisions: string[]
      episodeId: string | null
    }>,
  ): MeetingRecord | null {
    const current = this.getMeeting(id)
    if (!current) return null

    this.db
      .prepare(
        `UPDATE meetings SET
          title = ?, platform = ?, url = ?, ended_at = ?, status = ?, participants = ?,
          rough_notes = ?, distilled_notes = ?, action_items = ?,
          decisions = ?, episode_id = ?
        WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.platform ?? current.platform,
        patch.url ?? current.url,
        patch.endedAt !== undefined ? patch.endedAt : current.endedAt,
        patch.status ?? current.status,
        JSON.stringify(patch.participants ?? current.participants),
        patch.roughNotes !== undefined ? patch.roughNotes : current.roughNotes,
        patch.distilledNotes !== undefined
          ? patch.distilledNotes
          : current.distilledNotes,
        JSON.stringify(patch.actionItems ?? current.actionItems),
        JSON.stringify(patch.decisions ?? current.decisions),
        patch.episodeId !== undefined ? patch.episodeId : current.episodeId,
        id,
      )
    return this.getMeeting(id)
  }

  deleteMeeting(id: string): void {
    this.db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id)
  }

  addTranscriptTurn(input: {
    id?: string
    meetingId: string
    speaker: string
    participantId?: string | null
    text: string
    t0: number
    t1: number
    createdAt?: string
  }): TranscriptTurnRow {
    const id = input.id ?? randomUUID()
    const createdAt = input.createdAt ?? new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO transcript_turns (
          id, meeting_id, speaker, participant_id, text, t0, t1, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.meetingId,
        input.speaker,
        input.participantId ?? null,
        input.text,
        input.t0,
        input.t1,
        createdAt,
      )

    const meeting = this.getMeeting(input.meetingId)
    if (meeting && !meeting.participants.includes(input.speaker)) {
      this.updateMeeting(input.meetingId, {
        participants: [...meeting.participants, input.speaker],
      })
    }

    return {
      id,
      meetingId: input.meetingId,
      speaker: input.speaker,
      participantId: input.participantId ?? null,
      text: input.text,
      t0: input.t0,
      t1: input.t1,
      createdAt,
    }
  }

  relabelSpeakerTurns(
    meetingId: string,
    clusterId: string,
    newSpeaker: string,
  ): boolean {
    const clean = newSpeaker.trim()
    if (!clean) return false
    const fallbackMatch = clusterId.match(/^speaker_(\d+)$/i)
    const fallbackName = fallbackMatch
      ? `Speaker ${Number(fallbackMatch[1]) + 1}`
      : clusterId

    const result = this.db
      .prepare(
        `UPDATE transcript_turns
         SET speaker = ?
         WHERE meeting_id = ?
           AND (participant_id = ? OR speaker = ? OR speaker = ?)`,
      )
      .run(clean, meetingId, clusterId, clusterId, fallbackName)

    if (Number(result.changes ?? 0) === 0) {
      return false
    }

    const meeting = this.getMeeting(meetingId)
    if (meeting) {
      const updatedParticipants = Array.from(
        new Set(
          meeting.participants
            .map((p) =>
              p === clusterId || p === fallbackName ? clean : p,
            )
            .concat(clean),
        ),
      )
      this.updateMeeting(meetingId, { participants: updatedParticipants })
    }
    return true
  }

  private hydrateMeeting(row: Record<string, unknown>): MeetingRecord {
    const id = String(row.id)
    const turnRows = this.db
      .prepare(
        `SELECT * FROM transcript_turns WHERE meeting_id = ? ORDER BY t0 ASC, created_at ASC`,
      )
      .all(id) as Array<Record<string, unknown>>

    return {
      id,
      title: String(row.title),
      platform: String(row.platform),
      url: String(row.url),
      startedAt: String(row.started_at),
      endedAt: row.ended_at != null ? String(row.ended_at) : null,
      status: (row.status as 'recording' | 'completed') ?? 'completed',
      participants: JSON.parse(String(row.participants ?? '[]')) as string[],
      roughNotes: String(row.rough_notes ?? ''),
      distilledNotes: String(row.distilled_notes ?? ''),
      actionItems: JSON.parse(String(row.action_items ?? '[]')) as ActionItem[],
      decisions: JSON.parse(String(row.decisions ?? '[]')) as ActionItem[] as unknown as string[],
      episodeId: row.episode_id != null ? String(row.episode_id) : null,
      turns: turnRows.map((t) => ({
        id: String(t.id),
        meetingId: String(t.meeting_id),
        speaker: String(t.speaker),
        participantId: t.participant_id != null ? String(t.participant_id) : null,
        text: String(t.text),
        t0: Number(t.t0),
        t1: Number(t.t1),
        createdAt: String(t.created_at),
      })),
    }
  }

  close(): void {
    this.db.close()
  }
}
