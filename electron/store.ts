import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type CloudSttProvider = 'deepgram' | 'assemblyai' | 'openai' | 'gemini' | 'custom'
export type CloudAiProvider = 'openai' | 'gemini' | 'custom'

export interface NectarSettings {
  mode: 'local' | 'cloud'
  groupId: string
  localPort: number
  mcpPort: number

  // Cloud simplified presets
  cloudSttProvider: CloudSttProvider
  cloudSttModel: string
  cloudSttApiKey: string

  cloudAiProvider: CloudAiProvider
  cloudLlmModel: string
  cloudEmbeddingModel: string
  cloudAiApiKey: string

  // Custom / Low-level overrides (auto-populated from presets)
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

export const LOCAL_PRESET: Omit<NectarSettings, 'mode' | 'groupId' | 'localPort' | 'mcpPort'> = {
  cloudSttProvider: 'deepgram',
  cloudSttModel: '',
  cloudSttApiKey: '',

  cloudAiProvider: 'openai',
  cloudLlmModel: '',
  cloudEmbeddingModel: '',
  cloudAiApiKey: '',

  sttUrl: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  sttModel: '',
  sttApiKey: '',

  diarizeUrl: 'http://127.0.0.1:8000/v1/audio/diarize',
  diarizeModel: '',
  diarizeApiKey: '',

  llmBaseUrl: 'http://127.0.0.1:8000/v1',
  llmModel: '',
  llmApiKey: '',

  embeddingBaseUrl: 'http://127.0.0.1:8000/v1',
  embeddingModel: '',
  embeddingDimensions: 768,
  embeddingApiKey: '',
}

export const DEFAULT_SETTINGS: NectarSettings = {
  mode: 'local',
  groupId: 'workspace',
  localPort: 8000,
  mcpPort: 4577,
  ...LOCAL_PRESET,
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
      return { ...DEFAULT_SETTINGS }
    }
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<NectarSettings>) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(patch: Partial<NectarSettings>): NectarSettings {
    const updated = { ...this.getSettings(), ...patch }
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
          title = ?, ended_at = ?, status = ?, participants = ?,
          rough_notes = ?, distilled_notes = ?, action_items = ?,
          decisions = ?, episode_id = ?
        WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
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
