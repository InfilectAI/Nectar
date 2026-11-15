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

        {/* Center Live Call Banner (Only shows when a call is detected or recording) */}
        <div className="app-no-drag flex items-center">
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

        {/* Right Controls: Local/Cloud Toggle & Settings */}
        <div className="app-no-drag flex items-center gap-2">
          <div className="inline-flex rounded-[4px] border border-rail bg-well p-0.5 font-mono text-[10.5px]">
            <button
              onClick={() => handleToggleMode('local')}
              className={`inline-flex items-center gap-1 rounded-[3px] px-2 py-0.5 transition-colors ${
                state.settings.mode === 'local'
                  ? 'bg-ink text-well font-semibold'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Cpu className="h-3 w-3" />
              Local
            </button>
            <button
              onClick={() => handleToggleMode('cloud')}
              className={`inline-flex items-center gap-1 rounded-[3px] px-2 py-0.5 transition-colors ${
                state.settings.mode === 'cloud'
                  ? 'bg-signal text-white font-semibold'
                  : 'text-muted hover:text-ink'
              }`}
            >
              <Cloud className="h-3 w-3" />
              Cloud
            </button>
          </div>

          <button
            onClick={() => setShowSettingsModal(true)}
            title="Settings & MCP"
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-2.5 py-1 font-mono text-[10.5px] text-muted hover:border-ink/40 hover:text-ink"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
            <span>Settings</span>
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
                      <div className="p-6 text-center text-[12.5px] text-muted">
                        Transcript segments appear here during a meeting.
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

      {/* Settings & MCP Modal */}
      {showSettingsModal && settingsDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] p-4">
          <div className="w-full max-w-2xl rounded-[4px] border border-rail bg-well shadow-xl overflow-hidden">
            <div className="flex items-center justify-between border-b border-rail bg-strip px-5 py-3">
              <span className="font-mono text-[11.5px] font-semibold text-ink uppercase">
                Model Endpoints &amp; MCP Server
              </span>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="text-muted hover:text-ink"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
              {/* 1. Speech-to-Text (STT) */}
              <div className="rounded-[4px] border border-rail bg-recessed p-3.5 space-y-2.5">
                <div className="font-mono text-[11px] font-semibold text-ink uppercase">
                  1 · Speech-to-Text (STT)
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="col-span-2">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Endpoint URL
                    </label>
                    <input
                      type="text"
                      value={settingsDraft.sttUrl}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, sttUrl: e.target.value })
                      }
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Model
                    </label>
                    <input
                      type="text"
                      value={settingsDraft.sttModel}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, sttModel: e.target.value })
                      }
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      API Key (optional for local)
                    </label>
                    <input
                      type="password"
                      value={settingsDraft.sttApiKey}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, sttApiKey: e.target.value })
                      }
                      placeholder="sk-..."
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                </div>
              </div>

              {/* 2. Speaker Diarization */}
              <div className="rounded-[4px] border border-rail bg-recessed p-3.5 space-y-2.5">
                <div className="font-mono text-[11px] font-semibold text-ink uppercase">
                  2 · Speaker Diarization
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="col-span-2">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Endpoint URL
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
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Model
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
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      API Key (optional for local)
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
                      placeholder="sk-..."
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                </div>
              </div>

              {/* 3. LLM (Note Enhancement & Memory) */}
              <div className="rounded-[4px] border border-rail bg-recessed p-3.5 space-y-2.5">
                <div className="font-mono text-[11px] font-semibold text-ink uppercase">
                  3 · LLM (Note Enhancement &amp; Memory)
                </div>
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="col-span-2">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Base URL (OpenAI-compatible)
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
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Model
                    </label>
                    <input
                      type="text"
                      value={settingsDraft.llmModel}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, llmModel: e.target.value })
                      }
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      API Key (optional for local)
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
                      placeholder="sk-..."
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                </div>
              </div>

              {/* 4. Embedding (Memory Vector Index) */}
              <div className="rounded-[4px] border border-rail bg-recessed p-3.5 space-y-2.5">
                <div className="font-mono text-[11px] font-semibold text-ink uppercase">
                  4 · Embedding (Memory Index)
                </div>
                <div className="grid grid-cols-4 gap-2.5">
                  <div className="col-span-2">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Base URL (OpenAI-compatible)
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
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Model
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
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div>
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      Dims
                    </label>
                    <input
                      type="number"
                      value={settingsDraft.embeddingDimensions}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settingsDraft,
                          embeddingDimensions: Number(e.target.value),
                        })
                      }
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                  <div className="col-span-4">
                    <label className="block font-mono text-[10px] text-muted mb-1">
                      API Key (optional for local)
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
                      placeholder="sk-..."
                      className="w-full rounded-[4px] border border-rail bg-well px-2.5 py-1.5 font-mono text-[11.5px]"
                    />
                  </div>
                </div>
              </div>

              {/* Local MCP Server */}
              <div className="pt-3 border-t border-rail space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-semibold text-muted uppercase">
                    Local MCP Server ({state.mcp.url})
                  </span>
                  <button
                    onClick={() => copyText('mcp', mcpClaudeConfig)}
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-ink hover:text-signal"
                  >
                    {copiedKey === 'mcp' ? (
                      <>
                        <Check className="h-3 w-3 text-signal" />
                        <span className="text-signal">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy Config</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-[12px] text-muted">
                  Tools: <code className="font-mono text-ink">list_meetings</code>,{' '}
                  <code className="font-mono text-ink">get_meeting</code>,{' '}
                  <code className="font-mono text-ink">find_memory</code>
                </p>
                <pre className="rounded-[4px] border border-rail bg-chassis p-3 font-mono text-[11px] text-ink overflow-x-auto">
                  {mcpClaudeConfig}
                </pre>
              </div>

              <div className="flex justify-end gap-2 pt-2">
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
      )}
    </div>
  )
}
