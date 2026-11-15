import { useEffect, useState } from 'react'
import {
  Check,
  Cloud,
  Copy,
  Cpu,
  MessageSquareText,
  Mic,
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
import type {
  AppState,
  MeetingRecord,
  NectarSettings,
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
  const [noteTab, setNoteTab] = useState<'notes' | 'summary'>('notes')
  const [showTranscript, setShowTranscript] = useState(true)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'local' | 'cloud'>('local')
  const [showCustomCloud, setShowCustomCloud] = useState(false)
  const [showMcpModal, setShowMcpModal] = useState(false)
  const [selectedMcpAgent, setSelectedMcpAgent] = useState<McpAgentId>('claude')
  const [showManualMcp, setShowManualMcp] = useState(false)
  const [isDistilling, setIsDistilling] = useState(false)
  const [livePartial, setLivePartial] = useState<{ speaker: string; text: string } | null>(
    null,
  )
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<NectarSettings | null>(null)

  useEffect(() => {
    window.nectar.getState().then((initial) => {
      setState(initial)
      setSettingsDraft(initial.settings)
      if (initial.meetings.length > 0) {
        setSelectedMeetingId(initial.meetings[0]!.id)
      }
    })

    const unsub = window.nectar.onEvent((ev) => {
      if (ev.type === 'state:refresh') {
        const next = ev as unknown as AppState
        setState(next)
        setSettingsDraft(next.settings)
      } else if (ev.type === 'meetings:changed') {
        const meetings = ev.meetings as MeetingRecord[]
        setState((prev) => (prev ? { ...prev, meetings } : prev))
      } else if (ev.type === 'meetings:detected') {
        const detectedMeetings = ev.detectedMeetings as AppState['detectedMeetings']
        setState((prev) => (prev ? { ...prev, detectedMeetings } : prev))
      } else if (ev.type === 'primitives:changed') {
        const cortexPrimitives = ev.cortexPrimitives as Record<string, string>
        const cortexStatus = (ev.cortexStatus as AppState['cortexStatus']) ?? 'running'
        setState((prev) => (prev ? { ...prev, cortexPrimitives, cortexStatus } : prev))
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
      } else if (ev.type === 'meeting:partial') {
        setLivePartial({
          speaker: String(ev.speaker ?? 'Speaker'),
          text: String(ev.text ?? ''),
        })
      }
    })

    return () => unsub()
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

  const handleToggleMode = async (mode: 'local' | 'cloud') => {
    const port = state.settings.localPort || 8000
    const preset: Partial<NectarSettings> =
      mode === 'local'
        ? {
            mode: 'local',
            sttUrl: `http://127.0.0.1:${port}/v1/audio/transcriptions`,
            sttModel: 'whisper-large-v3',
            diarizeUrl: `http://127.0.0.1:${port}/v1/audio/diarize`,
            diarizeModel: 'pyannote-speakerkit',
            llmBaseUrl: `http://127.0.0.1:${port}/v1`,
            llmModel: 'gemma-4-E2B-it',
            embeddingBaseUrl: `http://127.0.0.1:${port}/v1`,
            embeddingModel: 'embeddinggemma-300M',
            embeddingDimensions: 768,
          }
        : {
            mode: 'cloud',
            sttUrl: 'https://api.openai.com/v1/audio/transcriptions',
            sttModel: 'whisper-1',
            diarizeUrl: `http://127.0.0.1:${port}/v1/audio/diarize`,
            diarizeModel: 'pyannote-speakerkit',
            llmBaseUrl: 'https://api.openai.com/v1',
            llmModel: 'gpt-4o-mini',
            embeddingBaseUrl: 'https://api.openai.com/v1',
            embeddingModel: 'text-embedding-3-small',
            embeddingDimensions: 1536,
          }
    const next = await window.nectar.saveSettings(preset)
    setState(next)
    setSettingsDraft(next.settings)
  }

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
    const started = await window.nectar.startCapture(target, selectedMeeting?.id)
    setSelectedMeetingId(started.id)
    setShowTranscript(true)
  }

  const handleStopCapture = async () => {
    const next = await window.nectar.stopCapture()
    setState(next)
    if (selectedMeeting) {
      await handleDistill(selectedMeeting.id)
    }
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

  return (
    <div className="flex h-screen w-screen flex-col bg-chassis text-ink font-sans select-text">
      {/* Minimal macOS Titlebar */}
      <header className="app-drag flex h-11 shrink-0 items-center justify-between border-b border-rail bg-strip pl-20 pr-3.5">
        <div className="flex items-center gap-2">
          <SignalInflectionMark className="h-4 w-4" />
          <span className="font-semibold tracking-[-0.02em] text-[13.5px] text-ink">
            Nectar
          </span>
        </div>

        {/* Center Live Call / Permission / Model Loading Banner */}
        <div className="app-no-drag flex items-center gap-2">
          {(state.permissions?.accessibility === 'denied' ||
            state.permissions?.microphone === 'denied') && (
            <div className="flex items-center gap-2 rounded-[4px] border border-amber bg-amber-tint px-2.5 py-0.5">
              <span className="font-mono text-[10.5px] font-medium text-ink">
                Permissions needed:{' '}
                {state.permissions?.accessibility === 'denied' ? 'Accessibility ' : ''}
                {state.permissions?.microphone === 'denied' ? 'Microphone' : ''}
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

          {(state.cortexPrimitives?.stt === 'loading' ||
            state.cortexPrimitives?.diarize === 'loading') && (
            <div className="flex items-center gap-2 rounded-[4px] border border-rail bg-well px-2.5 py-0.5 font-mono text-[10.5px] text-amber">
              <span className="h-1.5 w-1.5 rounded-full bg-amber animate-ping" />
              <span>Loading speech models…</span>
            </div>
          )}

          {state.activeCaptureMeetingId ? (
            <div className="flex items-center gap-2.5 rounded-[4px] border border-signal bg-signal-tint px-3 py-1">
              <span className="h-2 w-2 rounded-full bg-signal-bright animate-pulse" />
              <span className="font-mono text-[11px] font-semibold text-signal">
                Recording meeting
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
            onClick={() => {
              setSettingsTab(state.settings.mode === 'cloud' ? 'cloud' : 'local')
              setShowSettingsModal(true)
            }}
            title="Settings"
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
        {/* Left Sidebar: Meetings Only */}
        <aside className="flex w-68 shrink-0 flex-col border-r border-rail bg-chassis">
          <div className="p-3 space-y-2 border-b border-rail">
            <div className="flex gap-1.5">
              <button
                onClick={handleCreateNote}
                className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-[4px] bg-ink px-3 py-1.5 text-[12.5px] font-medium text-well hover:bg-signal-bright transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                New Note
              </button>
              <button
                onClick={handleSimulateLive}
                title="Simulate a live call"
                className="inline-flex items-center justify-center gap-1 rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11px] font-medium text-ink hover:border-ink/40"
              >
                <Play className="h-3 w-3 text-signal fill-current" />
                Demo
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
                  onClick={() => setSelectedMeetingId(m.id)}
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

        {/* Center Granola-Style Notepad */}
        <main className="flex flex-1 overflow-hidden bg-well">
          {selectedMeeting ? (
            <div className="flex flex-1 overflow-hidden">
              <div className="flex flex-1 flex-col overflow-hidden">
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
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Notes vs Summary toggle */}
                    <div className="inline-flex rounded-[4px] border border-rail bg-chassis p-0.5 font-mono text-[11px]">
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
                    </div>

                    {!isRecordingThisMeeting ? (
                      <button
                        onClick={() =>
                          window.nectar.startCapture(undefined, selectedMeeting.id)
                        }
                        className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-3 py-1.5 font-mono text-[11px] font-medium text-ink hover:border-ink/40"
                      >
                        <Mic className="h-3.5 w-3.5 text-signal" />
                        Record
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
                  <div className="flex flex-1 flex-col overflow-y-auto drafting-grid p-8">
                    <div className="mx-auto w-full max-w-3xl space-y-5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold text-muted uppercase">
                          Enhanced Meeting Notes
                        </span>
                        <button
                          onClick={() =>
                            copyText(
                              'summary',
                              selectedMeeting.distilledNotes ||
                                selectedMeeting.roughNotes,
                            )
                          }
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

                      {selectedMeeting.actionItems.length > 0 && (
                        <div className="rounded-[4px] border border-rail bg-well p-4">
                          <div className="font-mono text-[10.5px] font-semibold text-signal uppercase tracking-wider mb-2.5">
                            Action Items
                          </div>
                          <div className="space-y-2">
                            {selectedMeeting.actionItems.map((item, i) => (
                              <div
                                key={i}
                                className="flex items-start gap-2.5 text-[13.5px]"
                              >
                                <span className="rounded-[3px] bg-ink px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-well">
                                  @{item.owner}
                                </span>
                                <span className="text-ink">{item.task}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="rounded-[4px] border border-rail bg-well p-6">
                        <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink">
                          {selectedMeeting.distilledNotes ||
                            'No summary generated yet. Click "Enhance Notes" above.'}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Collapsible Right Drawer: Live Speaker Transcript */}
              {showTranscript && (
                <div className="flex w-84 shrink-0 flex-col border-l border-rail bg-chassis">
                  <div className="flex items-center justify-between border-b border-rail bg-strip px-4 py-2.5 font-mono text-[11px] font-semibold text-muted">
                    <span>TRANSCRIPT ({selectedMeeting.turns.length})</span>
                    <button
                      onClick={() => setShowTranscript(false)}
                      className="text-muted hover:text-ink"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5">
                    {selectedMeeting.turns.map((turn) => (
                      <div
                        key={turn.id}
                        className="rounded-[4px] border border-rail bg-well p-3"
                      >
                        <div className="flex items-center justify-between font-mono text-[10.5px]">
                          <span className="font-semibold text-signal">
                            {turn.speaker}
                          </span>
                          <span className="text-dim">{formatTimecode(turn.t0)}</span>
                        </div>
                        <p className="mt-1 text-[13px] leading-relaxed text-ink">
                          {turn.text}
                        </p>
                      </div>
                    ))}

                    {livePartial && (
                      <div className="rounded-[4px] border border-dashed border-signal bg-signal-tint p-3">
                        <div className="flex items-center justify-between font-mono text-[10.5px]">
                          <span className="font-semibold text-signal">
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
                      <div className="p-6 text-center text-[12.5px] text-muted space-y-2">
                        {state.cortexPrimitives?.stt === 'loading' ||
                        state.cortexPrimitives?.diarize === 'loading' ? (
                          <div className="rounded-[4px] border border-amber bg-amber-tint p-3 font-mono text-[11px] text-ink">
                            Loading local WhisperKit &amp; SpeakerKit models into Apple
                            Neural Engine… (first run takes ~20s)
                          </div>
                        ) : isRecordingThisMeeting ? (
                          <div className="font-mono text-[11.5px] text-signal">
                            Listening for speech…
                          </div>
                        ) : (
                          <div>Transcript segments appear here during a meeting.</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted text-sm">
              Select a meeting or create a new note.
            </div>
          )}
        </main>
      </div>

      {/* Settings Modal with Local / Cloud Tabs */}
      {showSettingsModal && settingsDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] p-4">
          <div className="w-full max-w-lg rounded-[4px] border border-rail bg-well shadow-xl overflow-hidden">
            {/* Modal Header with Local / Cloud Tabs */}
            <div className="flex items-center justify-between border-b border-rail bg-strip px-4 py-2.5">
              <div className="inline-flex rounded-[4px] border border-rail bg-chassis p-0.5 font-mono text-[11px]">
                <button
                  onClick={() => {
                    setSettingsTab('local')
                    setSettingsDraft({ ...settingsDraft, mode: 'local' })
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-[3px] px-3 py-1 transition-colors ${
                    settingsTab === 'local'
                      ? 'bg-ink text-well font-semibold'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  <Cpu className="h-3 w-3" />
                  Local
                </button>
                <button
                  onClick={() => {
                    setSettingsTab('cloud')
                    setSettingsDraft({ ...settingsDraft, mode: 'cloud' })
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-[3px] px-3 py-1 transition-colors ${
                    settingsTab === 'cloud'
                      ? 'bg-signal text-white font-semibold'
                      : 'text-muted hover:text-ink'
                  }`}
                >
                  <Cloud className="h-3 w-3" />
                  Cloud
                </button>
              </div>

              <button
                onClick={() => setShowSettingsModal(false)}
                className="text-muted hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
              {/* TAB 1: LOCAL ON-DEVICE */}
              {settingsTab === 'local' && (
                <div className="space-y-4">
                  <div className="rounded-[4px] border border-rail bg-recessed p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] font-semibold text-ink uppercase">
                        On-Device Runtime
                      </span>
                      <span className="rounded-[3px] bg-emerald-950 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                        100% LOCAL
                      </span>
                    </div>
                    <p className="text-[12.5px] text-muted leading-relaxed">
                      Runs transcription, speaker diarization, note enhancement, and memory
                      embeddings locally on your Mac.
                    </p>

                    <div className="grid grid-cols-4 gap-2 pt-1 font-mono text-[10.5px]">
                      {(['stt', 'diarize', 'chat', 'embed'] as const).map((prim) => (
                        <div
                          key={prim}
                          className="rounded-[3px] border border-rail bg-well p-2 text-center"
                        >
                          <div className="text-[9.5px] text-muted uppercase">{prim}</div>
                          <div className="font-semibold text-ink mt-0.5">
                            {state.cortexPrimitives?.[prim] ?? 'ready'}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="pt-2">
                      <label className="block font-mono text-[10.5px] text-muted mb-1">
                        Local Server Port
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
                        className="w-36 rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[12px]"
                      />
                    </div>
                  </div>

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
              )}

              {/* TAB 2: CLOUD PROVIDERS */}
              {settingsTab === 'cloud' && (
                <div className="space-y-3.5">
                  {/* 1. Transcription & Diarization */}
                  <div className="rounded-[4px] border border-rail bg-recessed p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px] font-semibold text-ink uppercase">
                        Transcription &amp; Diarization
                      </span>
                      <span className="font-mono text-[10px] text-muted">
                        Diarization included
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          Provider
                        </label>
                        <select
                          value={settingsDraft.cloudSttProvider}
                          onChange={(e) => {
                            const p = e.target.value as NectarSettings['cloudSttProvider']
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudSttProvider: p,
                            })
                            if (p === 'custom') setShowCustomCloud(true)
                          }}
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        >
                          <option value="deepgram">Deepgram</option>
                          <option value="assemblyai">AssemblyAI</option>
                          <option value="openai">OpenAI</option>
                          <option value="gemini">Google Gemini</option>
                          <option value="custom">Custom API</option>
                        </select>
                      </div>

                      <div>
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          Model Name (optional)
                        </label>
                        <input
                          type="text"
                          value={settingsDraft.cloudSttModel}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudSttModel: e.target.value,
                            })
                          }
                          placeholder="e.g. nova-3, universal-2, whisper-1"
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        />
                      </div>

                      <div className="col-span-2">
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          API Key
                        </label>
                        <input
                          type="password"
                          value={settingsDraft.cloudSttApiKey}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudSttApiKey: e.target.value,
                            })
                          }
                          placeholder="Enter provider API key…"
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        />
                      </div>
                    </div>
                  </div>

                  {/* 2. LLM & Embeddings */}
                  <div className="rounded-[4px] border border-rail bg-recessed p-3.5 space-y-2.5">
                    <div className="font-mono text-[11px] font-semibold text-ink uppercase">
                      LLM &amp; Embeddings
                    </div>

                    <div className="grid grid-cols-3 gap-2.5">
                      <div>
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          Provider
                        </label>
                        <select
                          value={settingsDraft.cloudAiProvider}
                          onChange={(e) => {
                            const p = e.target.value as NectarSettings['cloudAiProvider']
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudAiProvider: p,
                            })
                            if (p === 'custom') setShowCustomCloud(true)
                          }}
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        >
                          <option value="openai">OpenAI</option>
                          <option value="gemini">Google Gemini</option>
                          <option value="custom">Custom API</option>
                        </select>
                      </div>

                      <div>
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          LLM Model
                        </label>
                        <input
                          type="text"
                          value={settingsDraft.cloudLlmModel}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudLlmModel: e.target.value,
                            })
                          }
                          placeholder="Model ID…"
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        />
                      </div>

                      <div>
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          Embedding Model
                        </label>
                        <input
                          type="text"
                          value={settingsDraft.cloudEmbeddingModel}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudEmbeddingModel: e.target.value,
                            })
                          }
                          placeholder="Model ID…"
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        />
                      </div>

                      <div className="col-span-3">
                        <label className="block font-mono text-[10px] text-muted mb-1">
                          API Key
                        </label>
                        <input
                          type="password"
                          value={settingsDraft.cloudAiApiKey}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              cloudAiApiKey: e.target.value,
                            })
                          }
                          placeholder="Enter provider API key…"
                          className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Collapsible Custom Endpoints Per Model */}
                  <div className="rounded-[4px] border border-rail bg-chassis">
                    <button
                      type="button"
                      onClick={() => setShowCustomCloud(!showCustomCloud)}
                      className="flex w-full items-center justify-between px-3.5 py-2 font-mono text-[10.5px] font-semibold text-muted hover:text-ink"
                    >
                      <span>Custom Endpoints (URL, Model &amp; Key per Primitive)</span>
                      <span>{showCustomCloud ? '−' : '+'}</span>
                    </button>

                    {showCustomCloud && (
                      <div className="border-t border-rail p-3.5 space-y-2.5 bg-recessed">
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              STT URL
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.sttUrl}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  sttUrl: e.target.value,
                                })
                              }
                              placeholder="https://.../v1/audio/transcriptions"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              STT Model
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.sttModel}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  sttModel: e.target.value,
                                })
                              }
                              placeholder="Model name…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              STT Key
                            </label>
                            <input
                              type="password"
                              value={settingsDraft.sttApiKey}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  sttApiKey: e.target.value,
                                })
                              }
                              placeholder="API Key…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>

                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              Diarize URL (optional)
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.diarizeUrl}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  diarizeUrl: e.target.value,
                                })
                              }
                              placeholder="https://.../v1/audio/diarize"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              Diarize Model
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.diarizeModel}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  diarizeModel: e.target.value,
                                })
                              }
                              placeholder="Model name…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              Diarize Key
                            </label>
                            <input
                              type="password"
                              value={settingsDraft.diarizeApiKey}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  diarizeApiKey: e.target.value,
                                })
                              }
                              placeholder="API Key…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>

                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              LLM Base URL
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.llmBaseUrl}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  llmBaseUrl: e.target.value,
                                })
                              }
                              placeholder="https://.../v1"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              LLM Model
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.llmModel}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  llmModel: e.target.value,
                                })
                              }
                              placeholder="Model name…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              LLM Key
                            </label>
                            <input
                              type="password"
                              value={settingsDraft.llmApiKey}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  llmApiKey: e.target.value,
                                })
                              }
                              placeholder="API Key…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>

                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              Embedding Base URL
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.embeddingBaseUrl}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  embeddingBaseUrl: e.target.value,
                                })
                              }
                              placeholder="https://.../v1"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              Embedding Model
                            </label>
                            <input
                              type="text"
                              value={settingsDraft.embeddingModel}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  embeddingModel: e.target.value,
                                })
                              }
                              placeholder="Model name…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                          <div>
                            <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                              Embedding Key
                            </label>
                            <input
                              type="password"
                              value={settingsDraft.embeddingApiKey}
                              onChange={(e) =>
                                setSettingsDraft({
                                  ...settingsDraft,
                                  embeddingApiKey: e.target.value,
                                })
                              }
                              placeholder="API Key…"
                              className="w-full rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-rail">
                <span className="font-mono text-[10.5px] text-muted">
                  Mode: <strong className="uppercase text-ink">{settingsDraft.mode}</strong>
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowSettingsModal(false)}
                    className="rounded-[4px] border border-rail bg-well px-3.5 py-1.5 font-mono text-[11.5px] text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      const next = await window.nectar.saveSettings(settingsDraft)
                      setState(next)
                      setShowSettingsModal(false)
                    }}
                    className="rounded-[4px] bg-ink px-4 py-1.5 font-mono text-[11.5px] font-semibold text-well hover:bg-signal-bright"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
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
    </div>
  )
}
