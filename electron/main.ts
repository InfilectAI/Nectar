import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'

import { Aira, type EyesSession, type MeetingTarget, type MeetingWatcher } from '@infilectai/aira'
import { Cortex, type CortexServer } from '@infilectai/cortex'
import { SourceEvent, SourceType, Synapse } from '@infilectai/synapse'

import { distillMeeting } from './distiller.js'
import { MCP_TOOLS, McpHttpServer } from './mcp-server.js'
import { NectarStore, getNectarDataDir, type MeetingRecord, type NectarSettings } from './store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let store: NectarStore
let synapse: Synapse
let aira: Aira | null = null
let cortexServer: CortexServer | null = null
let cortexUrl: string | null = null
let cortexStatus: 'running' | 'starting' | 'stopped' | 'cloud' = 'stopped'
let watcher: MeetingWatcher | null = null
let detectedMeetings: MeetingTarget[] = []
let activeCaptureSession: EyesSession | null = null
let activeCaptureMeetingId: string | null = null
let mcpServer: McpHttpServer
let simulationTimer: NodeJS.Timeout | null = null

function broadcast(type: string, data: unknown = {}): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('nectar:event', { type, ...(data as object) })
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

async function initSynapse(settings: NectarSettings): Promise<void> {
  if (synapse) {
    await synapse.close().catch(() => {})
  }
  const synapseDbPath = path.join(getNectarDataDir(), 'synapse.db')

  synapse = await Synapse.open(synapseDbPath, {
    defaultGroupId: settings.groupId,
    chatBaseUrl: settings.llmBaseUrl,
    chatModel: settings.llmModel,
    chatApiKey: settings.llmApiKey,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingApiKey: settings.embeddingApiKey,
    embeddingDimensions: 64,
    memoryHitThreshold: 0.15,
    inferenceMode: 'fake',
    consolidationMode: 'deterministic',
    embedder: async (text: string) => deterministicEmbed(text, 64),
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

async function initComputeAndPerception(settings: NectarSettings): Promise<void> {
  if (settings.mode === 'local') {
    cortexStatus = 'starting'
    broadcast('status:changed', { cortexStatus })
    try {
      // Check if Cortex is already listening on localPort
      const probe = await fetch(`http://127.0.0.1:${settings.localPort}/health`).catch(
        () => null,
      )
      if (probe && probe.ok) {
        cortexUrl = `http://127.0.0.1:${settings.localPort}`
        cortexStatus = 'running'
      } else {
        cortexServer = await Cortex.start({ port: settings.localPort })
        cortexUrl = cortexServer.url
        cortexStatus = 'running'
      }
    } catch {
      cortexUrl = `http://127.0.0.1:${settings.localPort}`
      cortexStatus = 'stopped'
    }
  } else {
    if (cortexServer) {
      await cortexServer.stop().catch(() => {})
      cortexServer = null
    }
    cortexStatus = 'cloud'
  }

  await initSynapse(settings)

  // Initialize Aira for meeting detection & audio capture
  if (!aira) {
    aira = await Aira.create({
      stt: {
        url: settings.sttUrl,
        model: settings.sttModel || undefined,
        apiKey: settings.sttApiKey || undefined,
      },
      diarize: {
        url: settings.diarizeUrl,
        apiKey: settings.diarizeApiKey || undefined,
      },
    })

    watcher = aira.eyes.watchMeetings()
    watcher.on('Detected', (meetings: MeetingTarget[]) => {
      detectedMeetings = meetings
      broadcast('meetings:detected', { detectedMeetings })
    })
  }

  broadcast('status:changed', { cortexStatus, cortexUrl })
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
  const marchDistilled = await distillMeeting(marchFull, settings, cortexUrl)
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
  const q4Distilled = await distillMeeting(q4Full, settings, cortexUrl)
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

async function getFullAppState() {
  const settings = store.getSettings()
  const meetings = store.listMeetings()
  const permissions = aira
    ? await aira.checkPermissions(false).catch(() => ({}))
    : { accessibility: 'granted', microphone: 'granted', 'system-audio': 'granted' }
  const [entities, relationships, statements, skills, patterns] = await Promise.all([
    synapse.entities(settings.groupId),
    synapse.relationships(settings.groupId, { includeSuperseded: true }),
    synapse.statements(settings.groupId, { includeSuperseded: true }),
    synapse.skills(settings.groupId),
    synapse.patterns(settings.groupId),
  ])

  return {
    settings,
    cortexStatus,
    cortexUrl,
    detectedMeetings,
    activeCaptureMeetingId,
    permissions,
    meetings,
    graph: {
      entities,
      relationships,
      statements,
      skills,
      patterns,
    },
    mcp: {
      url: mcpServer.url,
      port: mcpServer.port,
      tools: MCP_TOOLS,
      requestsHandled: mcpServer.requestsHandled,
      stdioScriptPath: path.resolve(__dirname, '..', 'bin', 'nectar-mcp.js'),
    },
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('nectar:getState', async () => getFullAppState())

  ipcMain.handle('nectar:saveSettings', async (_e, patch: Partial<NectarSettings>) => {
    const prev = store.getSettings()
    const updated = store.saveSettings(patch)
    if (prev.mode !== updated.mode || prev.localPort !== updated.localPort) {
      await initComputeAndPerception(updated)
    } else {
      await initSynapse(updated)
    }
    return getFullAppState()
  })

  ipcMain.handle('nectar:checkPermissions', async (_e, prompt: boolean) => {
    if (!aira) return {}
    return aira.checkPermissions(Boolean(prompt))
  })

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
      const settings = store.getSettings()

      const session = aira.startMeeting(resolvedTarget, {
        stt: {
          url: settings.sttUrl,
          model: settings.sttModel || undefined,
          apiKey: settings.sttApiKey || undefined,
        },
        diarize: {
          url: settings.diarizeUrl,
          apiKey: settings.diarizeApiKey || undefined,
        },
      })
      activeCaptureSession = session

      ;(async () => {
        for await (const ev of session.events) {
          if (ev.type === 'transcript') {
            if (!ev.partial && ev.text.trim()) {
              const turn = store.addTranscriptTurn({
                meetingId: meeting.id,
                speaker: ev.name || 'Speaker',
                participantId: ev.participantId ?? null,
                text: ev.text.trim(),
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
            } else if (ev.partial) {
              broadcast('meeting:partial', {
                meetingId: meeting.id,
                speaker: ev.name,
                text: ev.text,
                t0: ev.t0,
              })
            }
          }
        }
      })().catch(() => {})

      broadcast('state:refresh', await getFullAppState())
      return meeting
    },
  )

  ipcMain.handle('nectar:stopCapture', async () => {
    if (simulationTimer) {
      clearInterval(simulationTimer)
      simulationTimer = null
    }
    if (activeCaptureSession) {
      await activeCaptureSession.close().catch(() => {})
      activeCaptureSession = null
    }
    const stoppedMeetingId = activeCaptureMeetingId
    activeCaptureMeetingId = null
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
      if (idx >= script.length) {
        if (simulationTimer) {
          clearInterval(simulationTimer)
          simulationTimer = null
        }
        activeCaptureMeetingId = null
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

  ipcMain.handle('nectar:recall', async (_e, query: string) => {
    const settings = store.getSettings()
    const res = await synapse.recall(query, settings.groupId)
    await synapse.detectProcedures(settings.groupId).catch(() => {})
    broadcast('state:refresh', await getFullAppState())
    return res
  })

  ipcMain.handle('nectar:getKnowledgeGraph', async (_e, includeSuperseded = true) => {
    const settings = store.getSettings()
    const [entities, relationships, statements, skills, patterns] = await Promise.all([
      synapse.entities(settings.groupId),
      synapse.relationships(settings.groupId, { includeSuperseded }),
      synapse.statements(settings.groupId, { includeSuperseded }),
      synapse.skills(settings.groupId),
      synapse.patterns(settings.groupId),
    ])
    return { entities, relationships, statements, skills, patterns }
  })

  ipcMain.handle('nectar:consolidateMemory', async () => {
    const settings = store.getSettings()
    const run = await synapse.consolidate(settings.groupId)
    broadcast('state:refresh', await getFullAppState())
    return run
  })

  ipcMain.handle('nectar:detectProcedures', async () => {
    const settings = store.getSettings()
    const res = await synapse.detectProcedures(settings.groupId)
    broadcast('state:refresh', await getFullAppState())
    return res
  })

  ipcMain.handle(
    'nectar:setSkillStatus',
    async (_e, skillId: string, status: 'candidate' | 'approved' | 'rejected') => {
      const settings = store.getSettings()
      await synapse.proceduralService.setStatus(
        skillId,
        status,
        settings.groupId,
        synapse.session,
      )
      broadcast('state:refresh', await getFullAppState())
      return { ok: true }
    },
  )
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
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

app.whenReady().then(async () => {
  store = new NectarStore()
  const settings = store.getSettings()

  mcpServer = new McpHttpServer(store, () => synapse)
  await mcpServer.start(settings.mcpPort)

  await initComputeAndPerception(settings)
  await seedInitialWorkspaceIfEmpty()

  registerIpcHandlers()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', async () => {
  if (simulationTimer) clearInterval(simulationTimer)
  if (activeCaptureSession) await activeCaptureSession.close().catch(() => {})
  if (watcher) watcher.close()
  if (aira) await aira.close().catch(() => {})
  if (cortexServer) await cortexServer.stop().catch(() => {})
  if (mcpServer) await mcpServer.stop().catch(() => {})
  if (synapse) await synapse.close().catch(() => {})
  if (store) store.close()
})
