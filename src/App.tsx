import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Loader2,
  MessageSquareText,
  Mic,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plus,
  Radio,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import {
  AgentIcon,
  type McpAgentId,
} from './components/AgentIcons'
import {
  DownloadConfirmModal,
  getMissingSelectedLocalModels,
  getSelectedLocalModelIds,
} from './components/DownloadConfirmModal'
import { GranolaHandle, type PillMeetingNotice } from './components/GranolaHandle'
import { MarkdownView } from './components/MarkdownView'
import {
  formatBytes,
  groupActionItemsByOwner,
  groupConsecutiveTurns,
  stripMarkdownActionItemsSection,
} from './utils/format'
import { OnboardingWizard } from './components/OnboardingWizard'
import { ServiceStackEditor } from './components/ServiceStackEditor'
import type {
  AppState,
  CloudServiceKey,
  CortexRuntimeStatus,
  LocalModelId,
  LocalModelInfo,
  MeetingRecord,
  NectarSettings,
  ServiceValidationResult,
  StreamingWsStatus,
} from './types'

function SignalInflectionMark({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="3" y="9" width="5" height="16" rx="1" fill="#111113" />
      <path d="M11 22L11 12L17 6L17 16L11 22Z" fill="#111113" />
      <rect x="20" y="3" width="5" height="13" rx="1" fill="#111113" />
      <circle cx="22.5" cy="21.75" r="2.75" fill="#FF5A1F" />
    </svg>
  )
}

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null)
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null)
  const [searchFilter, setSearchFilter] = useState('')
  const [noteTab, setNoteTab] = useState<'summary' | 'notes'>('summary')
  const [showSidebar, setShowSidebar] = useState(true)
  const [showTranscript, setShowTranscript] = useState(true)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [pendingSettingsDownloads, setPendingSettingsDownloads] = useState<
    LocalModelInfo[] | null
  >(null)
  const [showMcpModal, setShowMcpModal] = useState(false)
  const [selectedMcpAgent, setSelectedMcpAgent] = useState<McpAgentId>('claude')
  const [showManualMcp, setShowManualMcp] = useState(false)
  const [isDistilling, setIsDistilling] = useState(false)
  const [distillingMeetingId, setDistillingMeetingId] = useState<string | null>(null)
  const [livePartial, setLivePartial] = useState<{ speaker: string; text: string } | null>(
    null,
  )
  const [audioLevel, setAudioLevel] = useState(0)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<NectarSettings | null>(null)
  const [validatingSettings, setValidatingSettings] = useState(false)
  const [settingsValidationResults, setSettingsValidationResults] = useState<
    Partial<Record<CloudServiceKey, ServiceValidationResult>>
  >({})
  const [settingsValidationFailed, setSettingsValidationFailed] = useState(false)
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null)
  const [customSpeakerInput, setCustomSpeakerInput] = useState('')
  const [pillNotice, setPillNotice] = useState<PillMeetingNotice | null>(null)
  const [pillNoticeSide, setPillNoticeSide] = useState<'left' | 'right'>('left')
  const pillAutoHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isPillOverlay =
    typeof window !== 'undefined' && window.location.search.includes('view=pill')

  const clearPillAutoHide = () => {
    if (pillAutoHideRef.current) {
      clearTimeout(pillAutoHideRef.current)
      pillAutoHideRef.current = null
    }
  }

  useEffect(() => {
    if (!isPillOverlay) return
    void window.nectar
      .setPillExpanded(Boolean(pillNotice))
      .then((res) => {
        if (res?.side) setPillNoticeSide(res.side)
      })
      .catch(() => {})
  }, [isPillOverlay, Boolean(pillNotice)])

  useEffect(() => {
    if (isPillOverlay) {
      document.documentElement.style.background = 'transparent'
      document.body.style.background = 'transparent'
    }
    window.nectar.getState().then((initial) => {
      setState(initial)
      setSettingsDraft(initial.settings)
      if (!isPillOverlay && !initial.settings.onboardingCompleted) {
        setShowOnboarding(true)
      }
      if (isPillOverlay) {
        if (initial.activeCaptureMeetingId && initial.meetingEndedPrompt) {
          setPillNotice({
            kind: 'ended',
            title: initial.meetingEndedPrompt.title,
            platform: initial.meetingEndedPrompt.platform,
            isRecording: true,
          })
        } else if (
          !initial.activeCaptureMeetingId &&
          initial.detectedMeetings.length > 0
        ) {
          const m = initial.detectedMeetings[0]!
          setPillNotice({
            kind: 'started',
            title: m.title || 'Live Meeting',
            platform: m.platform,
            isRecording: false,
          })
        }
      }
      if (initial.meetings.length > 0) {
        setSelectedMeetingId(initial.meetings[0]!.id)
      }
    })

    const unsub = window.nectar.onEvent((ev) => {
      if (ev.type === 'state:refresh') {
        const next = ev as unknown as AppState
        setState(next)
        setSettingsDraft(next.settings)
        if (isPillOverlay) {
          if (next.activeCaptureMeetingId) {
            setPillNotice((prev) => (prev?.kind === 'started' ? null : prev))
          } else {
            setPillNotice((prev) =>
              prev?.kind === 'ended' && prev.isRecording ? null : prev,
            )
          }
        }
      } else if (ev.type === 'meeting:lifecycle') {
        if (isPillOverlay) {
          clearPillAutoHide()
          if (ev.kind === 'started') {
            setPillNotice({
              kind: 'started',
              title: String(ev.title ?? 'Live Meeting'),
              platform: String(ev.platform ?? ''),
              isRecording: false,
            })
          } else if (ev.kind === 'ended') {
            const isRecording = Boolean(ev.isRecording)
            setPillNotice({
              kind: 'ended',
              title: String(ev.title ?? 'Meeting'),
              platform: String(ev.platform ?? ''),
              isRecording,
            })
            if (!isRecording) {
              pillAutoHideRef.current = setTimeout(() => {
                setPillNotice((prev) =>
                  prev?.kind === 'ended' && !prev.isRecording ? null : prev,
                )
              }, 4500)
            }
          } else if (ev.kind === 'resumed') {
            setPillNotice((prev) => (prev?.kind === 'ended' ? null : prev))
          }
        }
      } else if (ev.type === 'audio:level') {
        setAudioLevel(Number(ev.level ?? 0))
      } else if (ev.type === 'meetings:changed') {
        const meetings = ev.meetings as MeetingRecord[]
        setState((prev) => (prev ? { ...prev, meetings } : prev))
      } else if (ev.type === 'meetings:detected') {
        const detectedMeetings = ev.detectedMeetings as AppState['detectedMeetings']
        setState((prev) => (prev ? { ...prev, detectedMeetings } : prev))
      } else if (ev.type === 'models:changed') {
        const cortexStatus = ev.cortexStatus as CortexRuntimeStatus
        const cortexUrl = (ev.cortexUrl as string | null) ?? null
        const cortexError = (ev.cortexError as string | null) ?? null
        const localModels = (ev.localModels as LocalModelInfo[]) ?? []
        setState((prev) =>
          prev
            ? {
                ...prev,
                cortexStatus,
                cortexUrl,
                cortexError,
                localModels,
              }
            : prev,
        )
      } else if (ev.type === 'permissions:changed') {
        const permissions = ev.permissions as Record<string, string>
        setState((prev) => (prev ? { ...prev, permissions } : prev))
      } else if (ev.type === 'meeting:turn') {
        setLivePartial(null)
        const updatedMeeting = ev.meeting as MeetingRecord
        setState((prev) => {
          if (!prev) return prev
          const meetings = prev.meetings.map((m) =>
            m.id === updatedMeeting.id ? updatedMeeting : m,
          )
          return { ...prev, meetings }
        })
      } else if (ev.type === 'streaming:status') {
        const streamingWs = ev.streamingWs as StreamingWsStatus
        setState((prev) => (prev ? { ...prev, streamingWs } : prev))
      } else if (ev.type === 'meeting:roster') {
        const activeRoster = (ev.activeRoster as string[]) ?? []
        setState((prev) => (prev ? { ...prev, activeRoster } : prev))
      } else if (ev.type === 'meeting:started') {
        const startedId = String(ev.meetingId ?? '')
        if (!isPillOverlay && startedId) {
          setSelectedMeetingId(startedId)
          setShowTranscript(true)
          if (ev.kind === 'self-note') {
            setNoteTab('notes')
          }
        }
      } else if (ev.type === 'meeting:distilling') {
        const targetId = String(ev.meetingId ?? '')
        const active = Boolean(ev.distilling)
        setIsDistilling(active)
        setDistillingMeetingId(active ? targetId : null)
        if (!isPillOverlay && active && targetId) {
          setSelectedMeetingId(targetId)
          setNoteTab('summary')
        }
      } else if (ev.type === 'meeting:partial') {
        const text = String(ev.text ?? '').trim()
        if (!text) {
          setLivePartial(null)
        } else {
          setLivePartial({
            speaker: String(ev.speaker ?? 'Speaker'),
            text,
          })
        }
      }
    })

    return () => {
      clearPillAutoHide()
      unsub()
    }
  }, [])

  if (!state) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-chassis text-muted font-mono text-xs">
        Loading Nectar…
      </div>
    )
  }

  const filteredMeetings = state.meetings.filter((m) => {
    if (!searchFilter.trim()) return true
    const q = searchFilter.toLowerCase()
    return (
      m.title.toLowerCase().includes(q) ||
      m.roughNotes.toLowerCase().includes(q) ||
      m.distilledNotes.toLowerCase().includes(q) ||
      m.participants.some((p) => p.toLowerCase().includes(q))
    )
  })

  const selectedMeeting =
    state.meetings.find((m) => m.id === selectedMeetingId) ??
    filteredMeetings[0] ??
    null

  const isRecordingThisMeeting =
    selectedMeeting && state.activeCaptureMeetingId === selectedMeeting.id

  const handleCreateNote = async () => {
    const created = await window.nectar.createMeeting({
      title: 'Untitled Meeting',
      platform: 'note',
      roughNotes: '',
    })
    const fresh = await window.nectar.getState()
    setState(fresh)
    setSelectedMeetingId(created.id)
    setNoteTab('notes')
  }

  const handleSimulateLive = async () => {
    const sim = await window.nectar.simulateLiveMeeting()
    setSelectedMeetingId(sim.id)
    setNoteTab('notes')
    setShowTranscript(true)
  }

  const handleStartDetectedCapture = async () => {
    const target = state.detectedMeetings[0]
    const reusableBlankNoteId =
      selectedMeeting &&
      selectedMeeting.platform === 'note' &&
      selectedMeeting.turns.length === 0 &&
      !selectedMeeting.distilledNotes.trim()
        ? selectedMeeting.id
        : undefined
    const started = await window.nectar.startCapture(target, reusableBlankNoteId)
    setSelectedMeetingId(started.id)
    setShowTranscript(true)
  }

  const handleStartSelfNote = async (existingMeetingId?: string) => {
    const started = await window.nectar.startSelfNote(existingMeetingId)
    const fresh = await window.nectar.getState()
    setState(fresh)
    setSelectedMeetingId(started.id)
    setNoteTab('notes')
    setShowTranscript(true)
  }

  const handleStopCapture = async () => {
    const next = await window.nectar.stopCapture()
    setState(next)
    setNoteTab('summary')
  }

  const handlePauseCapture = async () => {
    const next = await window.nectar.pauseCapture()
    setState(next)
  }

  const handleResumeCapture = async () => {
    const next = await window.nectar.resumeCapture()
    setState(next)
  }

  const handleStatus: 'idle' | 'recording' | 'paused' = state.activeCaptureMeetingId
    ? state.capturePaused
      ? 'paused'
      : 'recording'
    : 'idle'

  if (isPillOverlay) {
    return (
      <div
        className={`flex h-screen w-screen items-end pb-0.5 px-[2px] bg-transparent overflow-hidden ${
          pillNotice
            ? pillNoticeSide === 'right'
              ? 'justify-start'
              : 'justify-end'
            : 'justify-center'
        }`}
      >
        <GranolaHandle
          status={handleStatus}
          meetingDetected={state.detectedMeetings.length > 0}
          audioLevel={audioLevel}
          notice={pillNotice}
          noticeSide={pillNoticeSide}
          onDismissNotice={() => {
            clearPillAutoHide()
            setPillNotice(null)
          }}
          onStart={() => {
            clearPillAutoHide()
            setPillNotice(null)
            if (state.detectedMeetings.length > 0) {
              const reusableBlankNoteId =
                selectedMeeting &&
                selectedMeeting.platform === 'note' &&
                selectedMeeting.turns.length === 0
                  ? selectedMeeting.id
                  : undefined
              void window.nectar.startCapture(
                state.detectedMeetings[0],
                reusableBlankNoteId,
              )
            } else {
              void window.nectar.startSelfNote()
            }
          }}
          onPause={handlePauseCapture}
          onResume={handleResumeCapture}
          onStop={() => {
            clearPillAutoHide()
            setPillNotice(null)
            void handleStopCapture()
          }}
          onOpenApp={() => window.nectar.focusMainWindow()}
        />
      </div>
    )
  }

  const handleDistill = async (id: string) => {
    setIsDistilling(true)
    try {
      await window.nectar.distillMeeting(id)
      const fresh = await window.nectar.getState()
      setState(fresh)
      setNoteTab('summary')
    } finally {
      setIsDistilling(false)
    }
  }

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 1800)
  }

  const mcpClaudeConfig = JSON.stringify(
    {
      mcpServers: {
        nectar: {
          command: 'node',
          args: [state.mcp.stdioScriptPath],
        },
      },
    },
    null,
    2,
  )

  const openServicesSettings = () => {
    setSettingsDraft(state.settings)
    setSettingsValidationResults({})
    setSettingsValidationFailed(false)
    setShowSettingsModal(true)
    if (getSelectedLocalModelIds(state.settings).length > 0) {
      window.nectar.refreshLocalModels().catch(() => {})
    }
  }

  const handleRefreshModels = () => {
    window.nectar.refreshLocalModels().then((res) => {
      setState((prev) =>
        prev
          ? {
              ...prev,
              cortexStatus: res.cortexStatus,
              cortexUrl: res.cortexUrl,
              cortexError: res.cortexError,
              localModels: res.localModels,
            }
          : prev,
      )
    })
  }

  const handleRestartCortex = () => {
    window.nectar.restartCortex().then((next) => {
      setState(next)
      setSettingsDraft(next.settings)
    })
  }

  const handleDownloadModel = (id: LocalModelId) => {
    window.nectar.downloadLocalModel(id).catch(() => {})
  }

  const handleDownloadModels = (ids: LocalModelId[]) => {
    window.nectar.downloadAllLocalModels(ids).catch(() => {})
  }

  const handleCancelDownload = (id: LocalModelId) => {
    window.nectar.cancelLocalModelDownload(id).catch(() => {})
  }

  const handleOpenModelsFolder = () => {
    window.nectar.openModelsFolder().catch(() => {})
  }

  const persistSettingsModal = async (downloadIds?: LocalModelId[]) => {
    if (!settingsDraft) return
    const next = await window.nectar.saveSettings(settingsDraft)
    setState(next)
    setSettingsDraft(next.settings)
    if (downloadIds && downloadIds.length > 0) {
      handleDownloadModels(downloadIds)
    }
    setPendingSettingsDownloads(null)
    setShowSettingsModal(false)
  }

  const handleSaveSettingsModal = async (skipValidation = false) => {
    if (!settingsDraft) return
    const localCount = getSelectedLocalModelIds(settingsDraft).length
    const hasCloudServices = localCount < 4

    if (!skipValidation && hasCloudServices) {
      setValidatingSettings(true)
      setSettingsValidationFailed(false)
      try {
        const res = await window.nectar.validateCloudSettings(settingsDraft)
        const map: Partial<Record<CloudServiceKey, ServiceValidationResult>> = {}
        for (const r of res.results) {
          map[r.service] = r
        }
        setSettingsValidationResults(map)
        if (!res.ok) {
          setSettingsValidationFailed(true)
          return
        }
      } finally {
        setValidatingSettings(false)
      }
    }

    const missing = getMissingSelectedLocalModels(settingsDraft, localModels)
    if (missing.length > 0) {
      setPendingSettingsDownloads(missing)
      return
    }
    await persistSettingsModal()
  }

  const localModels = state.localModels ?? []
  const selectedLocalIds = getSelectedLocalModelIds(state.settings)
  const anyLocalSelected = selectedLocalIds.length > 0
  const activeModels = localModels.filter(
    (m) => m.status === 'downloading' || m.status === 'loading',
  )
  const primaryActiveModel =
    activeModels.find((m) => m.status === 'downloading') ?? activeModels[0] ?? null
  const missingSelectedLocalModels = getMissingSelectedLocalModels(
    state.settings,
    localModels,
  )
  const sttModel = localModels.find((m) => m.id === 'stt')
  const diarizeModel = localModels.find((m) => m.id === 'diarize')
  const streamingWs = state.streamingWs

  const speakerColorClass = (speaker: string) => {
    const palette = [
      'text-signal',
      'text-emerald-700',
      'text-amber',
      'text-sky-700',
    ]
    const clusterMatch = speaker.match(/(\d+)$/)
    if (clusterMatch) {
      return palette[Number(clusterMatch[1]) % palette.length]!
    }
    let h = 0
    for (let i = 0; i < speaker.length; i += 1) {
      h = (h * 31 + speaker.charCodeAt(i)) >>> 0
    }
    return palette[h % palette.length]!
  }

  return (
    <div className="flex h-screen w-screen flex-col bg-chassis text-ink font-sans select-text">
      {/* Minimal macOS Titlebar */}
      <header className="app-drag flex h-11 shrink-0 items-center justify-between border-b border-rail bg-strip pl-20 pr-3.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSidebar((v) => !v)}
            title={showSidebar ? 'Collapse sidebar' : 'Expand sidebar'}
            className="app-no-drag flex h-6 w-6 items-center justify-center rounded-[4px] text-muted hover:bg-well hover:text-ink transition-colors"
          >
            {showSidebar ? (
              <PanelLeftClose className="h-3.5 w-3.5" />
            ) : (
              <PanelLeft className="h-3.5 w-3.5" />
            )}
          </button>
          <SignalInflectionMark className="h-4 w-4" />
          <span className="font-semibold tracking-[-0.02em] text-[13.5px] text-ink">
            Nectar
          </span>
        </div>

        {/* Center Live Call / Permission / Model Download & Streaming WS Banner */}
        <div className="app-no-drag flex items-center gap-2">
          {(state.permissions?.accessibility === 'denied' ||
            state.permissions?.microphone === 'denied' ||
            state.permissions?.['system-audio'] === 'denied') && (
            <div className="flex items-center gap-2 rounded-[4px] border border-amber bg-amber-tint px-2.5 py-0.5">
              <span className="font-mono text-[10.5px] font-medium text-ink">
                Permissions needed:{' '}
                {[
                  state.permissions?.['system-audio'] === 'denied' ? 'System Audio' : '',
                  state.permissions?.accessibility === 'denied' ? 'Accessibility' : '',
                  state.permissions?.microphone === 'denied' ? 'Microphone' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <button
                onClick={async () => {
                  const perms = await window.nectar.checkPermissions(true)
                  setState((prev) => (prev ? { ...prev, permissions: perms } : prev))
                }}
                className="rounded-[3px] bg-ink px-2 py-0.5 font-mono text-[10px] font-semibold text-well hover:bg-signal-bright"
              >
                Grant Access
              </button>
            </div>
          )}

          {streamingWs && streamingWs.status !== 'idle' && (
            <button
              type="button"
              onClick={openServicesSettings}
              className={`flex items-center gap-1.5 rounded-[4px] border px-2.5 py-0.5 font-mono text-[10.5px] font-semibold ${
                streamingWs.status === 'connected'
                  ? 'border-emerald-700/35 bg-emerald-950/10 text-emerald-800'
                  : streamingWs.status === 'connecting'
                    ? 'border-amber/45 bg-amber-tint text-amber'
                    : 'border-signal/45 bg-signal-tint text-signal'
              }`}
            >
              {streamingWs.status === 'connecting' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : streamingWs.status === 'error' ? (
                <AlertCircle className="h-3 w-3" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
              )}
              <span>
                {streamingWs.status === 'connected'
                  ? `Streaming WS${
                      streamingWs.numSpeakers > 0
                        ? ` · ${streamingWs.numSpeakers} ${
                            streamingWs.numSpeakers === 1 ? 'speaker' : 'speakers'
                          }`
                        : ''
                    }`
                  : streamingWs.status === 'connecting'
                    ? 'Connecting WS…'
                    : 'WS Stream Error'}
              </span>
            </button>
          )}

          {anyLocalSelected && primaryActiveModel ? (
            <button
              type="button"
              onClick={openServicesSettings}
              className={`flex items-center gap-2 rounded-[4px] border px-2.5 py-0.5 font-mono text-[10.5px] transition-colors ${
                primaryActiveModel.status === 'downloading'
                  ? 'border-signal/45 bg-signal-tint text-signal hover:border-signal'
                  : 'border-amber/45 bg-amber-tint text-amber hover:border-amber'
              }`}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>
                {primaryActiveModel.status === 'downloading'
                  ? `Downloading ${primaryActiveModel.name}${
                      primaryActiveModel.progress !== null
                        ? ` (${Math.round(primaryActiveModel.progress * 100)}%)`
                        : ''
                    }`
                  : `Compiling ${primaryActiveModel.name}…`}
                {activeModels.length > 1 ? ` +${activeModels.length - 1}` : ''}
              </span>
            </button>
          ) : anyLocalSelected &&
            (state.cortexStatus === 'error' || state.cortexStatus === 'stopped') ? (
            <button
              type="button"
              onClick={openServicesSettings}
              className="flex items-center gap-1.5 rounded-[4px] border border-signal/40 bg-signal-tint px-2.5 py-0.5 font-mono text-[10.5px] text-signal hover:border-signal"
            >
              <AlertCircle className="h-3 w-3" />
              <span>
                {state.cortexStatus === 'error'
                  ? 'Local runtime error'
                  : 'Local runtime offline'}
              </span>
            </button>
          ) : anyLocalSelected &&
            missingSelectedLocalModels.length > 0 &&
            !state.activeCaptureMeetingId ? (
            <button
              type="button"
              onClick={() => setPendingSettingsDownloads(missingSelectedLocalModels)}
              className="flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-2.5 py-0.5 font-mono text-[10.5px] text-ink hover:border-ink/50"
            >
              <Download className="h-3 w-3 text-signal" />
              <span>
                Download {missingSelectedLocalModels.length} local{' '}
                {missingSelectedLocalModels.length === 1 ? 'model' : 'models'}
              </span>
            </button>
          ) : null}

          {state.activeCaptureMeetingId ? (
            <div className="flex items-center gap-2.5 rounded-[4px] border border-signal bg-signal-tint px-3 py-1">
              <span className="h-2 w-2 rounded-full bg-signal-bright animate-pulse" />
              <span className="font-mono text-[11px] font-semibold text-signal">
                {state.activeCaptureKind === 'self-note'
                  ? 'Recording self note'
                  : 'Recording meeting'}
              </span>
              <button
                onClick={handleStopCapture}
                className="inline-flex items-center gap-1 rounded-[3px] bg-ink px-2 py-0.5 font-mono text-[10.5px] font-semibold text-well hover:bg-signal"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            </div>
          ) : state.detectedMeetings.length > 0 ? (
            <div className="flex items-center gap-2.5 rounded-[4px] border border-amber bg-amber-tint px-3 py-1">
              <Radio className="h-3.5 w-3.5 text-amber animate-pulse" />
              <span className="text-[12px] font-medium text-ink">
                {state.detectedMeetings[0]!.title}
              </span>
              <button
                onClick={handleStartDetectedCapture}
                className="rounded-[3px] bg-ink px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-well hover:bg-signal-bright"
              >
                Join &amp; Transcribe
              </button>
            </div>
          ) : null}
        </div>

        {/* Right Controls: MCP Button + Settings Button */}
        <div className="app-no-drag flex items-center gap-1.5">
          <button
            onClick={() => setShowMcpModal(true)}
            title="Connect MCP to Claude, Codex, Copilot, or Custom"
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-2.5 py-1 font-mono text-[10.5px] text-ink hover:border-ink/40"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            <span>MCP</span>
          </button>

          <button
            onClick={openServicesSettings}
            title="Models & Services Settings"
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-2.5 py-1 font-mono text-[10.5px] text-ink hover:border-ink/40"
          >
            <SettingsIcon className="h-3.5 w-3.5 text-muted" />
            <span>Settings</span>
            <span className="rounded-[2px] bg-strip px-1.5 py-0.2 text-[9.5px] uppercase text-muted">
              {state.settings.mode}
            </span>
          </button>
        </div>
      </header>

      {/* Main Meetings Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Collapsible Left Sidebar: Meetings Only */}
        {showSidebar && (
          <aside className="flex w-68 shrink-0 flex-col border-r border-rail bg-chassis">
          <div className="p-3 space-y-2 border-b border-rail">
            <div className="flex gap-1.5">
              <button
                onClick={handleCreateNote}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-[4px] bg-ink px-2.5 py-1.5 text-[12px] font-medium text-well hover:bg-signal-bright transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                New Note
              </button>
              <button
                onClick={() => handleStartSelfNote()}
                title="Dictate a self note with your microphone"
                className="inline-flex items-center justify-center gap-1 rounded-[4px] border border-signal/40 bg-signal-tint px-2.5 py-1.5 font-mono text-[11px] font-semibold text-signal hover:bg-signal hover:text-white transition-colors"
              >
                <Mic className="h-3 w-3" />
                Self Note
              </button>
              <button
                onClick={handleSimulateLive}
                title="Simulate a live call"
                className="inline-flex items-center justify-center rounded-[4px] border border-rail bg-well px-2 py-1.5 font-mono text-[11px] font-medium text-ink hover:border-ink/40"
              >
                <Play className="h-3 w-3 text-muted fill-current" />
              </button>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-dim" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter notes…"
                className="w-full rounded-[4px] border border-rail bg-recessed pl-8 pr-2.5 py-1 text-[12.5px] text-ink placeholder:text-dim focus:border-ink/40 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-rail/70">
            {filteredMeetings.map((m) => {
              const selected = selectedMeeting?.id === m.id
              const recording = state.activeCaptureMeetingId === m.id
              return (
                <div
                  key={m.id}
                  onClick={() => {
                    setSelectedMeetingId(m.id)
                    setNoteTab(
                      m.platform === 'note' &&
                        m.turns.length === 0 &&
                        !m.distilledNotes.trim()
                        ? 'notes'
                        : 'summary',
                    )
                  }}
                  className={`cursor-pointer px-3.5 py-3 transition-colors ${
                    selected ? 'bg-well' : 'hover:bg-recessed/70'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium leading-snug text-ink line-clamp-1">
                      {m.title}
                    </span>
                    {recording && (
                      <span className="shrink-0 rounded-[3px] bg-signal px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-white">
                        LIVE
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center justify-between font-mono text-[10.5px] text-dim">
                    <span>{formatShortDate(m.startedAt)}</span>
                    {m.participants.length > 0 && (
                      <span className="truncate max-w-[110px]">
                        {m.participants.join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          </aside>
        )}

        {/* Center Granola-Style Notepad */}
        <main className="flex flex-1 overflow-hidden bg-well">
          {selectedMeeting ? (
            <div className="flex flex-1 overflow-hidden">
              <div className="relative flex flex-1 flex-col overflow-hidden">
                {/* Note Header & Toolbar */}
                <div className="flex items-center justify-between border-b border-rail px-8 py-4 bg-recessed/50">
                  <div className="flex-1 pr-4">
                    <input
                      type="text"
                      value={selectedMeeting.title}
                      onChange={(e) => {
                        const title = e.target.value
                        setState((prev) =>
                          prev
                            ? {
                                ...prev,
                                meetings: prev.meetings.map((m) =>
                                  m.id === selectedMeeting.id ? { ...m, title } : m,
                                ),
                              }
                            : prev,
                        )
                        window.nectar.updateMeeting(selectedMeeting.id, { title })
                      }}
                      className="w-full bg-transparent text-[21px] font-semibold tracking-[-0.02em] text-ink focus:outline-none"
                    />
                    <div className="mt-1 flex items-center gap-2.5 font-mono text-[11px] text-muted">
                      <span>{formatShortDate(selectedMeeting.startedAt)}</span>
                      {selectedMeeting.participants.length > 0 && (
                        <>
                          <span>·</span>
                          <span>{selectedMeeting.participants.join(', ')}</span>
                        </>
                      )}
                      {isRecordingThisMeeting && (
                        <>
                          <span>·</span>
                          <span
                            className={`font-semibold ${
                              state.capturePaused ? 'text-amber' : 'text-emerald-700'
                            }`}
                          >
                            {state.capturePaused ? 'Paused' : 'Recording'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Summary (primary) vs My Notes (secondary) toggle */}
                    <div className="inline-flex rounded-[4px] border border-rail bg-chassis p-0.5 font-mono text-[11px]">
                      <button
                        onClick={() => setNoteTab('summary')}
                        className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                          noteTab === 'summary'
                            ? 'bg-well text-ink font-semibold shadow-2xs'
                            : 'text-muted hover:text-ink'
                        }`}
                      >
                        Summary
                      </button>
                      <button
                        onClick={() => setNoteTab('notes')}
                        className={`rounded-[3px] px-2.5 py-1 transition-colors ${
                          noteTab === 'notes'
                            ? 'bg-well text-ink font-semibold shadow-2xs'
                            : 'text-muted hover:text-ink'
                        }`}
                      >
                        My Notes
                      </button>
                    </div>

                    {!isRecordingThisMeeting ? (
                      <button
                        onClick={() => handleStartSelfNote(selectedMeeting.id)}
                        title="Dictate voice directly into this note"
                        className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-3 py-1.5 font-mono text-[11px] font-medium text-ink hover:border-signal hover:text-signal"
                      >
                        <Mic className="h-3.5 w-3.5 text-signal" />
                        Dictate
                      </button>
                    ) : (
                      <button
                        onClick={handleStopCapture}
                        className="inline-flex items-center gap-1.5 rounded-[4px] bg-signal px-3 py-1.5 font-mono text-[11px] font-semibold text-white hover:bg-signal-bright"
                      >
                        <Square className="h-3 w-3 fill-current" />
                        Stop
                      </button>
                    )}

                    <button
                      onClick={() => handleDistill(selectedMeeting.id)}
                      disabled={isDistilling}
                      className="inline-flex items-center gap-1.5 rounded-[4px] bg-ink px-3 py-1.5 font-mono text-[11px] font-semibold text-well hover:bg-signal-bright disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {isDistilling ? 'Enhancing…' : 'Enhance Notes'}
                    </button>

                    <button
                      onClick={() => setShowTranscript(!showTranscript)}
                      title="Toggle Transcript Drawer"
                      className={`inline-flex items-center gap-1.5 rounded-[4px] border px-2.5 py-1.5 font-mono text-[11px] transition-colors ${
                        showTranscript
                          ? 'border-ink bg-chassis text-ink font-semibold'
                          : 'border-rail bg-well text-muted hover:text-ink'
                      }`}
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                      <span>{selectedMeeting.turns.length}</span>
                    </button>

                    <button
                      onClick={() => window.nectar.deleteMeeting(selectedMeeting.id)}
                      title="Delete Note"
                      className="rounded-[4px] border border-rail bg-well p-1.5 text-muted hover:text-signal"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {/* Note Body */}
                {noteTab === 'notes' ? (
                  <div className="flex flex-1 flex-col overflow-y-auto">
                    <textarea
                      value={selectedMeeting.roughNotes}
                      onChange={(e) => {
                        const roughNotes = e.target.value
                        setState((prev) =>
                          prev
                            ? {
                                ...prev,
                                meetings: prev.meetings.map((m) =>
                                  m.id === selectedMeeting.id
                                    ? { ...m, roughNotes }
                                    : m,
                                ),
                              }
                            : prev,
                        )
                        window.nectar.updateMeeting(selectedMeeting.id, {
                          roughNotes,
                        })
                      }}
                      placeholder="Jot down rough thoughts and bullet points during your meeting…&#10;&#10;When you're done, click 'Enhance Notes' to combine your bullets with the live transcript."
                      className="mx-auto w-full max-w-3xl flex-1 resize-none bg-transparent px-8 py-7 text-[15px] leading-relaxed text-ink placeholder:text-dim focus:outline-none"
                    />
                  </div>
                ) : (
                  (() => {
                    const actionGroups = groupActionItemsByOwner(
                      selectedMeeting.actionItems,
                    )
                    const totalActions = actionGroups.reduce(
                      (sum, g) => sum + g.items.length,
                      0,
                    )
                    const cleanSummaryMarkdown = stripMarkdownActionItemsSection(
                      selectedMeeting.distilledNotes,
                    )
                    const isDistillingThis =
                      isDistilling &&
                      (!distillingMeetingId ||
                        distillingMeetingId === selectedMeeting.id)

                    const fullCopyMarkdown = [
                      cleanSummaryMarkdown || selectedMeeting.roughNotes,
                      actionGroups.length > 0
                        ? [
                            '### Action Items',
                            ...actionGroups.flatMap((g) => [
                              `#### ${g.owner}`,
                              ...g.items.map((item) => `- [ ] ${item.task}`),
                            ]),
                          ].join('\n')
                        : '',
                    ]
                      .filter(Boolean)
                      .join('\n\n')

                    return (
                      <div className="flex flex-1 flex-col overflow-y-auto drafting-grid p-8">
                        <div className="mx-auto w-full max-w-3xl space-y-5">
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[11px] font-semibold text-muted uppercase">
                              Meeting Summary
                            </span>
                            <button
                              onClick={() => copyText('summary', fullCopyMarkdown)}
                              className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-2.5 py-1 font-mono text-[11px] text-ink hover:border-ink/40"
                            >
                              {copiedKey === 'summary' ? (
                                <>
                                  <Check className="h-3 w-3 text-signal" />
                                  <span className="text-signal">Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3 w-3" />
                                  <span>Copy Markdown</span>
                                </>
                              )}
                            </button>
                          </div>

                          {isDistillingThis && (
                            <div className="flex items-center gap-2.5 rounded-[4px] border border-signal/40 bg-signal-tint px-4 py-3 font-mono text-[11.5px] text-signal">
                              <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                              <span>
                                Generating summary &amp; owner-grouped action items…
                              </span>
                            </div>
                          )}

                          <div className="rounded-[4px] border border-rail bg-well p-6">
                            {cleanSummaryMarkdown ? (
                              <MarkdownView content={cleanSummaryMarkdown} />
                            ) : isDistillingThis ? (
                              <p className="text-[14px] leading-relaxed text-muted">
                                Synthesizing notes from the transcript…
                              </p>
                            ) : (
                              <div className="flex items-center justify-between gap-4">
                                <p className="text-[14px] leading-relaxed text-muted">
                                  {isRecordingThisMeeting
                                    ? 'Summary and action items will generate automatically when recording stops.'
                                    : 'No summary generated yet.'}
                                </p>
                                {!isRecordingThisMeeting &&
                                  (selectedMeeting.turns.length > 0 ||
                                    selectedMeeting.roughNotes.trim().length > 0) && (
                                    <button
                                      type="button"
                                      onClick={() => handleDistill(selectedMeeting.id)}
                                      className="shrink-0 inline-flex items-center gap-1.5 rounded-[4px] bg-ink px-3 py-1.5 font-mono text-[11px] font-semibold text-well hover:bg-signal-bright"
                                    >
                                      <Sparkles className="h-3.5 w-3.5" />
                                      Generate Summary
                                    </button>
                                  )}
                              </div>
                            )}
                          </div>

                          {actionGroups.length > 0 && (
                            <div className="rounded-[4px] border border-rail bg-well p-5 space-y-4">
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-[10.5px] font-semibold text-signal uppercase tracking-wider">
                                  Action Items
                                </span>
                                <span className="font-mono text-[10px] text-dim">
                                  {totalActions}{' '}
                                  {totalActions === 1 ? 'item' : 'items'} ·{' '}
                                  {actionGroups.length}{' '}
                                  {actionGroups.length === 1 ? 'owner' : 'owners'}
                                </span>
                              </div>
                              <div className="space-y-4">
                                {actionGroups.map((group) => (
                                  <div key={group.owner} className="space-y-1.5">
                                    <div className="flex items-center gap-2">
                                      <span className="rounded-[3px] bg-ink px-2 py-0.5 font-mono text-[10.5px] font-semibold text-well">
                                        {group.owner}
                                      </span>
                                      <span className="font-mono text-[10px] text-dim">
                                        {group.items.length}
                                      </span>
                                    </div>
                                    <ul className="space-y-1.5 pl-1">
                                      {group.items.map((item, idx) => (
                                        <li
                                          key={idx}
                                          className="flex items-start gap-2.5 text-[13.5px] leading-snug text-ink"
                                        >
                                          <span
                                            aria-hidden="true"
                                            className="mt-1 h-3.5 w-3.5 shrink-0 rounded-[3px] border border-rail bg-chassis"
                                          />
                                          <span>{item.task}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })()
                )}
              </div>

              {/* Collapsible Right Drawer: Live Speaker Transcript */}
              {showTranscript &&
                (() => {
                  const groupedTurns = groupConsecutiveTurns(selectedMeeting.turns)
                  const lastBlock = groupedTurns[groupedTurns.length - 1]
                  const partialJoinsLastBlock = Boolean(
                    livePartial &&
                      lastBlock &&
                      lastBlock.speaker.toLowerCase() ===
                        livePartial.speaker.trim().toLowerCase(),
                  )
                  const rosterChoices = Array.from(
                    new Set([
                      ...(isRecordingThisMeeting ? state.activeRoster ?? [] : []),
                      ...selectedMeeting.participants.filter(
                        (p) => !/^(?:speaker[_ ]\d+|speaker)$/i.test(p.trim()),
                      ),
                    ]),
                  )
                  return (
                    <div className="flex w-84 shrink-0 flex-col border-l border-rail bg-chassis">
                      <div className="flex items-center justify-between border-b border-rail bg-strip px-4 py-2.5 font-mono text-[11px] font-semibold text-muted">
                        <span>TRANSCRIPT ({groupedTurns.length})</span>
                        <button
                          onClick={() => setShowTranscript(false)}
                          className="text-muted hover:text-ink"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
                        {groupedTurns.map((block, idx) => {
                          const isEditing = editingTurnId === block.id
                          const isLastWithLive =
                            partialJoinsLastBlock && idx === groupedTurns.length - 1
                          const clusterKeys =
                            block.clusterKeys.length > 0
                              ? block.clusterKeys
                              : [block.participantId || block.speaker]
                          const assignSpeaker = async (name: string) => {
                            const clean = name.trim()
                            if (!clean) return
                            for (const key of clusterKeys) {
                              await window.nectar.relabelSpeaker(
                                selectedMeeting.id,
                                key,
                                clean,
                              )
                            }
                            setEditingTurnId(null)
                            setCustomSpeakerInput('')
                          }
                          return (
                            <div
                              key={block.id}
                              className={`rounded-[4px] border p-3 ${
                                isLastWithLive
                                  ? 'border-signal/60 bg-well'
                                  : 'border-rail bg-well'
                              }`}
                            >
                              <div className="flex items-center justify-between font-mono text-[10.5px]">
                                <button
                                  type="button"
                                  title="Click to assign speaker name for all turns from this voice"
                                  onClick={() => {
                                    if (isEditing) {
                                      setEditingTurnId(null)
                                    } else {
                                      setEditingTurnId(block.id)
                                      setCustomSpeakerInput(
                                        /^(?:speaker[_ ]\d+|speaker)$/i.test(
                                          block.speaker.trim(),
                                        )
                                          ? ''
                                          : block.speaker,
                                      )
                                    }
                                  }}
                                  className={`inline-flex items-center gap-1 rounded-[3px] px-1 -ml-1 hover:bg-strip font-semibold ${speakerColorClass(block.speaker)}`}
                                >
                                  <span>{block.speaker}</span>
                                  <span className="text-[9px] text-dim font-normal">▾</span>
                                </button>
                                <span
                                  className={
                                    isLastWithLive ? 'text-signal' : 'text-dim'
                                  }
                                >
                                  {isLastWithLive
                                    ? `${formatTimecode(block.t0)} · Live…`
                                    : formatTimecode(block.t0)}
                                </span>
                              </div>

                              {isEditing && (
                                <div className="mt-2 rounded-[4px] border border-rail bg-chassis p-2 space-y-1.5">
                                  {rosterChoices.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                      {rosterChoices.map((name) => (
                                        <button
                                          key={name}
                                          type="button"
                                          onClick={() => void assignSpeaker(name)}
                                          className="rounded-[3px] border border-rail bg-well px-2 py-0.5 font-mono text-[10px] font-medium text-ink hover:border-signal hover:text-signal"
                                        >
                                          {name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <form
                                    onSubmit={(e) => {
                                      e.preventDefault()
                                      void assignSpeaker(customSpeakerInput)
                                    }}
                                    className="flex items-center gap-1"
                                  >
                                    <input
                                      type="text"
                                      autoFocus
                                      value={customSpeakerInput}
                                      onChange={(e) =>
                                        setCustomSpeakerInput(e.target.value)
                                      }
                                      placeholder="Assign speaker name…"
                                      className="flex-1 min-w-0 rounded-[3px] border border-rail bg-well px-2 py-0.5 text-[11px] text-ink placeholder:text-dim focus:border-ink/40 focus:outline-none"
                                    />
                                    <button
                                      type="submit"
                                      className="rounded-[3px] bg-ink px-2 py-0.5 font-mono text-[10px] font-semibold text-well hover:bg-signal-bright"
                                    >
                                      Set
                                    </button>
                                  </form>
                                </div>
                              )}

                              <p className="mt-1 text-[13px] leading-relaxed text-ink">
                                {block.text}
                                {isLastWithLive && livePartial && (
                                  <span className="italic text-muted">
                                    {' '}
                                    {livePartial.text}
                                  </span>
                                )}
                              </p>
                            </div>
                          )
                        })}

                        {livePartial && !partialJoinsLastBlock && (
                          <div className="rounded-[4px] border border-dashed border-signal bg-signal-tint p-3">
                            <div className="flex items-center justify-between font-mono text-[10.5px]">
                              <span
                                className={`font-semibold ${speakerColorClass(livePartial.speaker)}`}
                              >
                                {livePartial.speaker}
                              </span>
                              <span className="text-signal">Live…</span>
                            </div>
                            <p className="mt-1 text-[13px] italic text-ink">
                              {livePartial.text}
                            </p>
                          </div>
                        )}

                    {selectedMeeting.turns.length === 0 && !livePartial && (
                      <div className="p-6 text-center text-[12.5px] text-muted space-y-2.5">
                        {state.settings.sttMode === 'local' &&
                        (sttModel?.status === 'downloading' ||
                          diarizeModel?.status === 'downloading') ? (
                          <div className="rounded-[4px] border border-signal/40 bg-signal-tint p-3 font-mono text-[11px] text-ink space-y-1.5 text-left">
                            <div className="flex items-center gap-1.5 font-semibold text-signal">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              <span>
                                Downloading{' '}
                                {sttModel?.status === 'downloading'
                                  ? sttModel.name
                                  : diarizeModel?.name}
                                …
                              </span>
                            </div>
                            <div className="text-[10.5px] text-muted">
                              {(sttModel?.status === 'downloading'
                                ? sttModel.detail
                                : diarizeModel?.detail) ??
                                'First-time Core ML download from HuggingFace…'}
                            </div>
                            {(() => {
                              const active =
                                sttModel?.status === 'downloading'
                                  ? sttModel
                                  : diarizeModel
                              if (!active || active.progress === null) return null
                              return (
                                <div className="space-y-1 pt-1">
                                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-well">
                                    <div
                                      className="h-full rounded-full bg-signal transition-all duration-200"
                                      style={{
                                        width: `${Math.max(
                                          3,
                                          Math.round(active.progress * 100),
                                        )}%`,
                                      }}
                                    />
                                  </div>
                                  <div className="text-[10px] text-dim tabular-nums">
                                    {Math.round(active.progress * 100)}% ·{' '}
                                    {formatBytes(active.downloadedBytes)} /{' '}
                                    {formatBytes(active.totalBytes)}
                                  </div>
                                </div>
                              )
                            })()}
                          </div>
                        ) : state.settings.sttMode === 'local' &&
                          (sttModel?.status === 'loading' ||
                            diarizeModel?.status === 'loading') ? (
                          <div className="rounded-[4px] border border-amber bg-amber-tint p-3 font-mono text-[11px] text-ink">
                            Compiling local WhisperKit &amp; SpeakerKit models for Apple
                            Neural Engine… (first run takes ~20s)
                          </div>
                        ) : state.settings.sttMode === 'local' &&
                          (sttModel?.status === 'error' ||
                            diarizeModel?.status === 'error') ? (
                          <div className="rounded-[4px] border border-signal/40 bg-signal-tint p-3 font-mono text-[11px] text-signal space-y-2">
                            <div>
                              Local speech model error:{' '}
                              {sttModel?.error ?? diarizeModel?.error}
                            </div>
                            <button
                              type="button"
                              onClick={openServicesSettings}
                              className="rounded-[3px] bg-ink px-2.5 py-1 text-[10.5px] font-semibold text-well"
                            >
                              Inspect Services
                            </button>
                          </div>
                        ) : streamingWs?.status === 'error' && streamingWs.error ? (
                          <div className="rounded-[4px] border border-signal/40 bg-signal-tint p-3 font-mono text-[11px] text-signal space-y-2">
                            <div>Stream error: {streamingWs.error}</div>
                            <button
                              type="button"
                              onClick={openServicesSettings}
                              className="rounded-[3px] bg-ink px-2.5 py-1 text-[10.5px] font-semibold text-well"
                            >
                              Check STT Settings
                            </button>
                          </div>
                        ) : isRecordingThisMeeting &&
                          state.permissions?.['system-audio'] === 'denied' ? (
                          <div className="rounded-[4px] border border-amber bg-amber-tint p-3 font-mono text-[11px] text-ink space-y-2 text-left">
                            <div className="font-semibold text-amber">
                              No system audio detected
                            </div>
                            <div className="text-[10.5px] text-muted leading-relaxed">
                              macOS muted meeting audio. Add Nectar under{' '}
                              <strong className="text-ink">
                                Privacy &amp; Security → Screen &amp; System Audio
                                Recording → System Audio Recording Only
                              </strong>
                              , then restart Nectar.
                            </div>
                            <button
                              type="button"
                              onClick={async () => {
                                const perms = await window.nectar.checkPermissions(true)
                                setState((prev) =>
                                  prev ? { ...prev, permissions: perms } : prev,
                                )
                              }}
                              className="rounded-[3px] bg-ink px-2.5 py-1 text-[10.5px] font-semibold text-well hover:bg-signal-bright"
                            >
                              Open System Settings
                            </button>
                          </div>
                        ) : isRecordingThisMeeting ? (
                          <div className="space-y-2">
                            <div className="font-mono text-[11.5px] text-signal">
                              {streamingWs?.status === 'connecting'
                                ? 'Connecting to streaming WebSocket…'
                                : 'Listening for speech…'}
                            </div>
                            {state.settings.sttMode === 'local' &&
                              sttModel?.status === 'not_downloaded' && (
                                <div className="font-mono text-[10.5px] text-muted">
                                  First speech segment will download WhisperKit (~950 MB)
                                  automatically.
                                </div>
                              )}
                          </div>
                        ) : (
                          <div>Transcript segments appear here during a meeting.</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center justify-between border-t border-rail bg-strip px-3.5 py-2 font-mono text-[10px] text-muted">
                    <span>
                      {state.settings.sttMode === 'local'
                        ? 'Local Speech'
                        : state.settings.cloudSttProvider === 'websocket'
                          ? `Streaming WS${
                              streamingWs?.lastLatencyMs
                                ? ` · ${(streamingWs.lastLatencyMs / 1000).toFixed(2)}s`
                                : ''
                            }`
                          : `Cloud STT (${state.settings.cloudSttProvider})`}
                    </span>
                    <span>
                      {state.settings.llmMode === 'local' ? 'Local LLM' : 'Cloud LLM'}
                    </span>
                  </div>
                </div>
                  )
                })()}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted text-sm">
              Select a meeting or create a new note.
            </div>
          )}
        </main>
      </div>

      {/* Unified Models & Services Settings Modal (Per-Service Mix & Match) */}
      {showSettingsModal && settingsDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] p-4">
          <div className="w-full max-w-2xl rounded-[6px] border border-rail bg-well shadow-xl overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-rail bg-strip px-4.5 py-3">
              <div className="flex items-center gap-2.5">
                <span className="text-[14px] font-semibold tracking-[-0.015em] text-ink">
                  Models &amp; Services
                </span>
                <span className="font-mono text-[10px] text-muted">
                  Mix Local &amp; Cloud per service
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowSettingsModal(false)
                    setShowOnboarding(true)
                  }}
                  className="rounded-[3px] border border-rail bg-well px-2 py-0.5 font-mono text-[10px] font-medium text-ink hover:border-ink/50"
                >
                  Setup Wizard
                </button>
                <button
                  onClick={() => setShowSettingsModal(false)}
                  className="text-muted hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="p-5 space-y-4 max-h-[78vh] overflow-y-auto">
              <ServiceStackEditor
                draft={settingsDraft}
                onChange={(next) => {
                  setSettingsDraft(next)
                  setSettingsValidationFailed(false)
                }}
                cortexStatus={state.cortexStatus}
                cortexError={state.cortexError}
                localModels={localModels}
                validationResults={settingsValidationResults}
                onRefreshModels={handleRefreshModels}
                onRestartCortex={handleRestartCortex}
                onDownloadModel={handleDownloadModel}
                onCancelDownload={handleCancelDownload}
                onOpenModelsFolder={handleOpenModelsFolder}
              />

              {/* Local Server Port (only when >=1 service uses Local) */}
              {getSelectedLocalModelIds(settingsDraft).length > 0 && (
                <div className="flex items-end justify-between gap-3 rounded-[4px] border border-rail bg-chassis px-3.5 py-2.5">
                  <div>
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Local Runtime Port
                    </label>
                    <input
                      type="number"
                      value={settingsDraft.localPort}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settingsDraft,
                          localPort: Number(e.target.value),
                        })
                      }
                      className="w-32 rounded-[4px] border border-rail bg-well px-2.5 py-1 font-mono text-[11.5px]"
                    />
                  </div>
                  <span className="font-mono text-[10px] text-dim">
                    {state.cortexUrl ?? `http://127.0.0.1:${settingsDraft.localPort}`}
                  </span>
                </div>
              )}

              {/* macOS Permissions row */}
              <div className="flex items-center justify-between rounded-[4px] border border-rail bg-chassis px-3.5 py-2.5 font-mono text-[11px]">
                <div className="flex items-center gap-3">
                  <span>
                    Accessibility:{' '}
                    <strong
                      className={
                        state.permissions?.accessibility === 'granted'
                          ? 'text-emerald-700'
                          : 'text-signal'
                      }
                    >
                      {state.permissions?.accessibility ?? 'granted'}
                    </strong>
                  </span>
                  <span>·</span>
                  <span>
                    Mic:{' '}
                    <strong
                      className={
                        state.permissions?.microphone === 'granted'
                          ? 'text-emerald-700'
                          : 'text-signal'
                      }
                    >
                      {state.permissions?.microphone ?? 'granted'}
                    </strong>
                  </span>
                </div>
                <button
                  onClick={async () => {
                    const perms = await window.nectar.checkPermissions(true)
                    setState((prev) => (prev ? { ...prev, permissions: perms } : prev))
                  }}
                  className="rounded-[3px] border border-rail bg-well px-2.5 py-1 text-[10.5px] font-semibold text-ink hover:border-ink/40"
                >
                  Check Permissions
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-rail bg-strip px-5 py-3">
              <span className="font-mono text-[10.5px] text-muted">
                Stack:{' '}
                <strong className="uppercase text-ink">
                  {getSelectedLocalModelIds(settingsDraft).length} Local ·{' '}
                  {4 - getSelectedLocalModelIds(settingsDraft).length} Cloud
                </strong>
                {settingsDraft.sttMode === 'cloud' &&
                  settingsDraft.sttIncludesDiarization && (
                    <span className="text-dim"> · STT+Diarize combined</span>
                  )}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowSettingsModal(false)}
                  className="rounded-[4px] border border-rail bg-well px-3.5 py-1.5 font-mono text-[11.5px] text-muted hover:text-ink"
                >
                  Cancel
                </button>
                {settingsValidationFailed && (
                  <button
                    disabled={validatingSettings}
                    onClick={() => handleSaveSettingsModal(true)}
                    className="rounded-[4px] border border-rail bg-well px-3 py-1.5 font-mono text-[11.5px] text-muted hover:text-ink disabled:opacity-50"
                  >
                    Save Anyway
                  </button>
                )}
                <button
                  disabled={validatingSettings}
                  onClick={() => handleSaveSettingsModal(false)}
                  className="inline-flex items-center gap-1.5 rounded-[4px] bg-ink px-4 py-1.5 font-mono text-[11.5px] font-semibold text-well hover:bg-signal-bright disabled:opacity-50"
                >
                  {validatingSettings && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  <span>
                    {validatingSettings
                      ? 'Validating…'
                      : settingsValidationFailed
                        ? 'Retry Save'
                        : 'Save'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Download Confirmation Popup when saving Settings or clicking Titlebar download pill */}
      {pendingSettingsDownloads && (
        <DownloadConfirmModal
          models={pendingSettingsDownloads}
          confirmLabel={showSettingsModal ? 'Download & Save' : 'Start Download'}
          onCancel={() => setPendingSettingsDownloads(null)}
          onConfirm={() => {
            if (showSettingsModal) {
              persistSettingsModal(pendingSettingsDownloads.map((m) => m.id))
            } else {
              handleDownloadModels(pendingSettingsDownloads.map((m) => m.id))
              setPendingSettingsDownloads(null)
            }
          }}
        />
      )}

      {/* Paper-Style "Connect your agent" MCP Modal */}
      {showMcpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] p-4">
          <div className="w-full max-w-2xl rounded-[6px] border border-rail bg-well shadow-xl overflow-hidden flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-rail bg-strip px-5 py-3.5">
              <span className="text-[15px] font-semibold tracking-[-0.015em] text-ink">
                Connect your agent
              </span>
              <button
                onClick={() => setShowMcpModal(false)}
                className="text-muted hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Two-Pane Body */}
            <div className="flex min-h-[380px]">
              {/* Left Agent Selector List with Brand Icons */}
              <div className="w-48 shrink-0 border-r border-rail bg-chassis p-2.5 space-y-1">
                {(
                  [
                    { id: 'claude', label: 'Claude' },
                    { id: 'codex', label: 'Codex' },
                    { id: 'cursor', label: 'Cursor' },
                    { id: 'copilot', label: 'GitHub Copilot' },
                    { id: 'vscode', label: 'VS Code' },
                    { id: 'other', label: 'Other agents' },
                  ] as const
                ).map((agent) => {
                  const active = selectedMcpAgent === agent.id
                  const isConnected =
                    agent.id !== 'other' && Boolean(state.mcp.installed?.[agent.id])
                  return (
                    <button
                      key={agent.id}
                      onClick={() => {
                        setSelectedMcpAgent(agent.id)
                        setShowManualMcp(agent.id === 'other')
                      }}
                      className={`flex w-full items-center justify-between rounded-[4px] px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors ${
                        active
                          ? 'bg-well text-ink shadow-2xs border border-rail'
                          : 'text-muted hover:bg-recessed hover:text-ink border border-transparent'
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <AgentIcon agent={agent.id} className="h-4 w-4 shrink-0" />
                        <span className="truncate">{agent.label}</span>
                      </span>
                      {isConnected && (
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 shrink-0" />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Right Steps Pane */}
              <div className="flex-1 p-6 space-y-5 overflow-y-auto bg-well">
                {(() => {
                  const agentLabels: Record<McpAgentId, string> = {
                    claude: 'Claude',
                    codex: 'Codex',
                    cursor: 'Cursor',
                    copilot: 'GitHub Copilot',
                    vscode: 'VS Code',
                    other: 'your agent',
                  }
                  const label = agentLabels[selectedMcpAgent]
                  const isInstalled =
                    selectedMcpAgent !== 'other' &&
                    Boolean(state.mcp.installed?.[selectedMcpAgent])

                  return (
                    <>
                      {/* Step 1: Nectar Desktop Running */}
                      <div className="flex items-center gap-3">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-signal text-white">
                          <Check className="h-3 w-3 stroke-[2.5]" />
                        </span>
                        <span className="text-[13.5px] font-medium text-ink">
                          Nectar MCP server active ({state.mcp.url})
                        </span>
                      </div>

                      {/* Step 2: Connect to Agent */}
                      <div className="space-y-2.5">
                        <div className="flex items-center gap-3">
                          {isInstalled ? (
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-signal text-white">
                              <Check className="h-3 w-3 stroke-[2.5]" />
                            </span>
                          ) : (
                            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-strip font-mono text-[11px] font-semibold text-ink">
                              2
                            </span>
                          )}
                          <span className="text-[13.5px] font-medium text-ink">
                            Connect to {label}
                          </span>
                        </div>

                        <div className="pl-8 space-y-2">
                          {selectedMcpAgent !== 'other' && (
                            <div className="flex items-center justify-between rounded-[4px] border border-rail bg-recessed px-3.5 py-2.5">
                              <span className="text-[12.5px] text-muted">
                                Add Nectar to {label} as an MCP server
                              </span>
                              <button
                                onClick={async () => {
                                  const res = await window.nectar.installMcp(
                                    selectedMcpAgent,
                                  )
                                  setState((prev) =>
                                    prev
                                      ? {
                                          ...prev,
                                          mcp: {
                                            ...prev.mcp,
                                            installed: res.installed,
                                          },
                                        }
                                      : prev,
                                  )
                                }}
                                className={`inline-flex items-center gap-2 rounded-[4px] border px-3 py-1.5 font-mono text-[11.5px] font-semibold transition-colors ${
                                  isInstalled
                                    ? 'border-emerald-700/40 bg-emerald-950/10 text-emerald-800'
                                    : 'border-rail bg-well text-ink hover:border-ink'
                                }`}
                              >
                                <AgentIcon
                                  agent={selectedMcpAgent}
                                  className="h-3.5 w-3.5"
                                />
                                <span>
                                  {isInstalled
                                    ? `Connected to ${label}`
                                    : `Add to ${label}`}
                                </span>
                              </button>
                            </div>
                          )}

                          {/* Manual Install Accordion */}
                          <div className="rounded-[4px] border border-rail bg-recessed">
                            <button
                              type="button"
                              onClick={() => setShowManualMcp(!showManualMcp)}
                              className="flex w-full items-center justify-between px-3.5 py-2.5 text-[12.5px] text-muted hover:text-ink"
                            >
                              <span>Or, install manually</span>
                              <span className="font-mono text-sm">
                                {showManualMcp ? '−' : '+'}
                              </span>
                            </button>

                            {showManualMcp && (
                              <div className="border-t border-rail p-3.5 space-y-2.5 bg-chassis">
                                <div className="flex items-center justify-between font-mono text-[10.5px]">
                                  <span className="text-muted">
                                    HTTP MCP Endpoint:
                                  </span>
                                  <button
                                    onClick={() =>
                                      copyText('mcp-url', state.mcp.url)
                                    }
                                    className="inline-flex items-center gap-1 text-ink hover:text-signal"
                                  >
                                    {copiedKey === 'mcp-url' ? (
                                      <>
                                        <Check className="h-3 w-3 text-signal" />
                                        <span className="text-signal">Copied</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="h-3 w-3" />
                                        <span>Copy URL</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                                <div className="rounded-[3px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11px] text-ink">
                                  {state.mcp.url}
                                </div>

                                <div className="flex items-center justify-between font-mono text-[10.5px] pt-1">
                                  <span className="text-muted">
                                    Stdio configuration (mcp.json):
                                  </span>
                                  <button
                                    onClick={() => copyText('mcp', mcpClaudeConfig)}
                                    className="inline-flex items-center gap-1 text-ink hover:text-signal"
                                  >
                                    {copiedKey === 'mcp' ? (
                                      <>
                                        <Check className="h-3 w-3 text-signal" />
                                        <span className="text-signal">Copied</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="h-3 w-3" />
                                        <span>Copy JSON</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                                <pre className="rounded-[3px] border border-rail bg-well p-2.5 font-mono text-[10.5px] text-ink overflow-x-auto">
                                  {mcpClaudeConfig}
                                </pre>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Step 3: Run Your First Prompt */}
                      <div className="space-y-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-strip font-mono text-[11px] font-semibold text-ink">
                            3
                          </span>
                          <span className="text-[13.5px] font-medium text-ink">
                            Run your first prompt
                          </span>
                        </div>

                        <div className="pl-8 space-y-2">
                          <p className="text-[12px] text-muted">
                            Run one of these example prompts in {label} to test the
                            connection:
                          </p>
                          <div className="space-y-1.5">
                            {[
                              'List my recent meetings in Nectar and summarize the latest one',
                              'Find in Nectar memory: Who owns checkout-service right now?',
                              'What action items were assigned in the Q4 On-Call meeting?',
                            ].map((prompt, idx) => (
                              <button
                                key={idx}
                                onClick={() => copyText(`prompt-${idx}`, prompt)}
                                className="flex items-center gap-2 rounded-full border border-rail bg-recessed px-3 py-1.5 text-left text-[12px] text-ink hover:border-ink/40 transition-colors"
                              >
                                {copiedKey === `prompt-${idx}` ? (
                                  <Check className="h-3.5 w-3.5 text-signal shrink-0" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5 text-muted shrink-0" />
                                )}
                                <span className="truncate">{prompt}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </>
                  )
                })()}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-rail bg-strip px-5 py-3">
              <span className="font-mono text-[11px] text-muted">
                Tools: list_meetings · get_meeting · find_memory
              </span>
              <button
                onClick={() => setShowMcpModal(false)}
                className="rounded-[4px] bg-ink px-4 py-1.5 font-mono text-[11.5px] font-semibold text-well hover:bg-signal-bright"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      {/* First-Run Onboarding Wizard */}
      {showOnboarding && (
        <OnboardingWizard
          state={state}
          onSaveSettings={async (patch) => {
            const next = await window.nectar.saveSettings(patch)
            setState(next)
            setSettingsDraft(next.settings)
          }}
          onComplete={async () => {
            const next = await window.nectar.completeOnboarding()
            setState(next)
            setSettingsDraft(next.settings)
            setShowOnboarding(false)
          }}
          onCheckPermissions={async (prompt) => {
            const perms = await window.nectar.checkPermissions(prompt)
            setState((prev) => (prev ? { ...prev, permissions: perms } : prev))
          }}
          onRefreshModels={handleRefreshModels}
          onRestartCortex={handleRestartCortex}
          onDownloadModel={handleDownloadModel}
          onDownloadModels={handleDownloadModels}
          onCancelDownload={handleCancelDownload}
          onOpenModelsFolder={handleOpenModelsFolder}
        />
      )}
    </div>
  )
}
