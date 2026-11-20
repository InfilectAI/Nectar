import { useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-react'
import type {
  AuthScheme,
  CloudAiProvider,
  CloudSttProvider,
  CortexRuntimeStatus,
  LocalModelId,
  LocalModelInfo,
  NectarSettings,
  ServiceMode,
} from '../types'
import { formatBytes, formatSpeed } from '../utils/format'

interface ServiceStackEditorProps {
  draft: NectarSettings
  onChange: (next: NectarSettings) => void
  cortexStatus: CortexRuntimeStatus
  cortexError: string | null
  localModels: LocalModelInfo[]
  onRefreshModels: () => void
  onRestartCortex: () => void
  onDownloadModel: (id: LocalModelId) => void
  onCancelDownload: (id: LocalModelId) => void
  onOpenModelsFolder: () => void
}

function ModeToggle({
  value,
  onChange,
}: {
  value: ServiceMode
  onChange: (v: ServiceMode) => void
}) {
  return (
    <div className="inline-flex rounded-[3px] border border-rail bg-strip p-0.5 font-mono text-[10px]">
      <button
        type="button"
        onClick={() => onChange('local')}
        className={`rounded-[2px] px-2 py-0.5 transition-colors ${
          value === 'local'
            ? 'bg-ink text-well font-semibold'
            : 'text-muted hover:text-ink'
        }`}
      >
        Local
      </button>
      <button
        type="button"
        onClick={() => onChange('cloud')}
        className={`rounded-[2px] px-2 py-0.5 transition-colors ${
          value === 'cloud'
            ? 'bg-signal text-white font-semibold'
            : 'text-muted hover:text-ink'
        }`}
      >
        Cloud
      </button>
    </div>
  )
}

function LocalModelInlineRow({
  model,
  onDownload,
  onCancel,
}: {
  model: LocalModelInfo | undefined
  onDownload: (id: LocalModelId) => void
  onCancel: (id: LocalModelId) => void
}) {
  if (!model) return null
  const isWorking = model.status === 'downloading' || model.status === 'loading'
  const isInstalled = model.status === 'ready' || model.status === 'downloaded'
  const pct =
    model.progress !== null
      ? Math.max(2, Math.min(100, Math.round(model.progress * 100)))
      : null
  const speed = formatSpeed(model.bytesPerSec)

  const badgeClass =
    model.status === 'ready' || model.status === 'downloaded'
      ? 'bg-emerald-950/10 text-emerald-800 border-emerald-700/30'
      : model.status === 'downloading'
        ? 'bg-signal-tint text-signal border-signal/40'
        : model.status === 'loading'
          ? 'bg-amber-tint text-amber border-amber/40'
          : model.status === 'error'
            ? 'bg-signal-tint text-signal border-signal/40'
            : 'bg-strip text-muted border-rail'

  const badgeLabel =
    model.status === 'ready'
      ? 'Loaded'
      : model.status === 'downloaded'
        ? 'Downloaded'
        : model.status === 'downloading'
          ? `Downloading${model.progress !== null ? ` ${Math.round(model.progress * 100)}%` : ''}`
          : model.status === 'loading'
            ? 'Compiling…'
            : model.status === 'error'
              ? 'Error'
              : 'Not Downloaded'

  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10.5px] text-muted">
          <span className="font-semibold text-ink">{model.name}</span> · {model.engine}{' '}
          {model.totalBytes ? `· ~${formatBytes(model.totalBytes)}` : ''}
        </div>

        <div className="flex items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-[3px] border px-2 py-0.5 font-mono text-[10px] font-semibold ${badgeClass}`}
          >
            {isWorking && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
            {isInstalled && <CheckCircle2 className="h-2.5 w-2.5" />}
            {model.status === 'error' && <AlertCircle className="h-2.5 w-2.5" />}
            {badgeLabel}
          </span>

          {(model.status === 'not_downloaded' || model.status === 'error') && (
            <button
              type="button"
              onClick={() => onDownload(model.id)}
              className="inline-flex items-center gap-1 rounded-[3px] border border-rail bg-well px-2 py-0.5 font-mono text-[10px] font-semibold text-ink hover:border-ink hover:bg-ink hover:text-well transition-colors"
            >
              <Download className="h-2.5 w-2.5" />
              {model.status === 'error' ? 'Retry' : 'Download'}
            </button>
          )}

          {isWorking && model.canCancel && (
            <button
              type="button"
              onClick={() => onCancel(model.id)}
              title="Cancel download"
              className="inline-flex items-center justify-center rounded-[3px] border border-rail bg-well p-1 text-muted hover:text-signal hover:border-signal/40"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {isWorking && (
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-strip">
            {pct !== null && model.status === 'downloading' ? (
              <div
                className="h-full rounded-full bg-signal transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <div className="h-full w-2/5 rounded-full bg-amber animate-pulse" />
            )}
          </div>
          <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
            <span className="truncate">{model.detail ?? 'Working…'}</span>
            <span className="shrink-0 tabular-nums">
              {model.downloadedBytes > 0 && model.totalBytes
                ? `${formatBytes(model.downloadedBytes)} / ${formatBytes(model.totalBytes)}`
                : null}
              {speed ? ` · ${speed}` : null}
            </span>
          </div>
        </div>
      )}

      {!isWorking && model.error && (
        <div className="font-mono text-[10px] text-signal">{model.error}</div>
      )}
    </div>
  )
}

export function ServiceStackEditor({
  draft,
  onChange,
  cortexStatus,
  cortexError,
  localModels,
  onRefreshModels,
  onRestartCortex,
  onDownloadModel,
  onCancelDownload,
  onOpenModelsFolder,
}: ServiceStackEditorProps) {
  const [testingWs, setTestingWs] = useState(false)
  const [wsTestResult, setWsTestResult] = useState<{
    ok: boolean
    message: string
  } | null>(null)

  const byId = Object.fromEntries(localModels.map((m) => [m.id, m])) as Partial<
    Record<LocalModelId, LocalModelInfo>
  >

  const diarizeBundled = draft.sttMode === 'cloud' && draft.sttIncludesDiarization
  const anyLocal =
    draft.sttMode === 'local' ||
    (!diarizeBundled && draft.diarizeMode === 'local') ||
    draft.llmMode === 'local' ||
    draft.embeddingMode === 'local'

  const patch = (next: Partial<NectarSettings>) => {
    onChange({ ...draft, ...next })
  }

  const handleTestWs = async () => {
    setTestingWs(true)
    setWsTestResult(null)
    try {
      const res = await window.nectar.testSttConnection({
        url: draft.sttUrl,
        apiKey: draft.sttApiKey,
        authScheme: draft.sttAuthScheme,
        language: draft.sttLanguage,
        mode: draft.sttWsMode,
      })
      setWsTestResult({ ok: res.ok, message: res.message })
    } catch (err) {
      setWsTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTestingWs(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Show local Cortex runtime status bar whenever at least 1 service uses Local */}
      {anyLocal && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-rail bg-chassis px-3 py-2">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-[3px] border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  cortexStatus === 'running'
                    ? 'bg-emerald-950/10 text-emerald-800 border-emerald-700/30'
                    : cortexStatus === 'starting'
                      ? 'bg-amber-tint text-amber border-amber/40'
                      : cortexStatus === 'error'
                        ? 'bg-signal-tint text-signal border-signal/40'
                        : 'bg-strip text-muted border-rail'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    cortexStatus === 'running'
                      ? 'bg-emerald-600'
                      : cortexStatus === 'starting'
                        ? 'bg-amber animate-pulse'
                        : cortexStatus === 'error'
                          ? 'bg-signal'
                          : 'bg-dim'
                  }`}
                />
                {cortexStatus === 'running'
                  ? 'Local Runtime Online'
                  : cortexStatus === 'starting'
                    ? 'Starting Local Runtime…'
                    : cortexStatus === 'error'
                      ? 'Local Runtime Error'
                      : 'Local Runtime Offline'}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {(cortexStatus === 'stopped' || cortexStatus === 'error') && (
                <button
                  type="button"
                  onClick={onRestartCortex}
                  className="inline-flex items-center gap-1 rounded-[3px] border border-signal/40 bg-signal-tint px-2 py-1 font-mono text-[10px] font-semibold text-signal hover:bg-signal hover:text-white"
                >
                  <RotateCw className="h-3 w-3" />
                  Start Runtime
                </button>
              )}
              <button
                type="button"
                onClick={onOpenModelsFolder}
                title="Open ~/.cortex/models in Finder"
                className="inline-flex items-center gap-1 rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[10px] text-muted hover:text-ink hover:border-ink/40"
              >
                <FolderOpen className="h-3 w-3" />
                <span>Folder</span>
              </button>
              <button
                type="button"
                onClick={onRefreshModels}
                title="Re-check local runtime & model files"
                className="inline-flex items-center gap-1 rounded-[3px] border border-rail bg-well px-2 py-1 font-mono text-[10px] text-muted hover:text-ink hover:border-ink/40"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {cortexStatus === 'error' && cortexError && (
            <div className="flex items-start gap-2 rounded-[4px] border border-signal/40 bg-signal-tint px-3 py-2 font-mono text-[10.5px] text-signal">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span className="break-words">{cortexError}</span>
            </div>
          )}
        </div>
      )}

      {/* 1 · STT (Transcription) */}
      <div
        className={`rounded-[4px] border px-3.5 py-3 space-y-2.5 ${
          draft.sttMode === 'local' && byId.stt?.status === 'downloading'
            ? 'border-signal/50 bg-well'
            : 'border-rail bg-recessed'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-ink">1 · STT</span>
            <span className="text-[12px] text-muted">Live Transcription</span>
          </div>
          <div className="flex items-center gap-2">
            {draft.sttMode === 'cloud' && draft.cloudSttProvider === 'websocket' && (
              <button
                type="button"
                disabled={testingWs || !draft.sttUrl.trim()}
                onClick={handleTestWs}
                className="inline-flex items-center gap-1 rounded-[3px] border border-rail bg-well px-2 py-0.5 font-mono text-[10px] font-semibold text-ink hover:border-ink disabled:opacity-50"
              >
                {testingWs && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                <span>{testingWs ? 'Testing…' : 'Test'}</span>
              </button>
            )}
            <ModeToggle
              value={draft.sttMode}
              onChange={(sttMode) => patch({ sttMode })}
            />
          </div>
        </div>

        {draft.sttMode === 'local' ? (
          <LocalModelInlineRow
            model={byId.stt}
            onDownload={onDownloadModel}
            onCancel={onCancelDownload}
          />
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-5">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Provider
                </label>
                <select
                  value={draft.cloudSttProvider}
                  onChange={(e) => {
                    const p = e.target.value as CloudSttProvider
                    const autoBundle =
                      p === 'websocket' || p === 'deepgram' || p === 'assemblyai'
                    patch({
                      cloudSttProvider: p,
                      sttIncludesDiarization: autoBundle
                        ? true
                        : draft.sttIncludesDiarization,
                    })
                  }}
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px] font-semibold text-ink"
                >
                  <option value="websocket">WebSocket (Streaming)</option>
                  <option value="deepgram">Deepgram</option>
                  <option value="assemblyai">AssemblyAI</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="custom">Custom HTTP</option>
                </select>
              </div>

              {draft.cloudSttProvider === 'websocket' ||
              draft.cloudSttProvider === 'custom' ? (
                <div className="col-span-7">
                  <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                    {draft.cloudSttProvider === 'websocket'
                      ? 'WebSocket URL'
                      : 'Endpoint URL'}
                  </label>
                  <input
                    type="text"
                    value={draft.sttUrl}
                    onChange={(e) => patch({ sttUrl: e.target.value })}
                    placeholder={
                      draft.cloudSttProvider === 'websocket'
                        ? 'wss://.../websocket'
                        : 'https://.../v1/audio/transcriptions'
                    }
                    className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                  />
                </div>
              ) : (
                <div className="col-span-7">
                  <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                    Model (optional)
                  </label>
                  <input
                    type="text"
                    value={draft.sttModel}
                    onChange={(e) => patch({ sttModel: e.target.value })}
                    placeholder="e.g. nova-3, gpt-4o-transcribe"
                    className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-12 gap-2">
              {(draft.cloudSttProvider === 'websocket' ||
                draft.cloudSttProvider === 'custom') && (
                <div className="col-span-3">
                  <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                    Auth
                  </label>
                  <select
                    value={draft.sttAuthScheme}
                    onChange={(e) =>
                      patch({ sttAuthScheme: e.target.value as AuthScheme })
                    }
                    className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                  >
                    <option value="Api-Key">Api-Key</option>
                    <option value="Bearer">Bearer</option>
                    <option value="Token">Token</option>
                    <option value="none">None</option>
                  </select>
                </div>
              )}

              <div
                className={
                  draft.cloudSttProvider === 'websocket'
                    ? 'col-span-5'
                    : draft.cloudSttProvider === 'custom'
                      ? 'col-span-9'
                      : 'col-span-12'
                }
              >
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  API Key
                </label>
                <input
                  type="password"
                  value={draft.sttApiKey}
                  onChange={(e) => patch({ sttApiKey: e.target.value })}
                  placeholder="Enter API key…"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>

              {draft.cloudSttProvider === 'websocket' && (
                <>
                  <div className="col-span-2">
                    <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                      Mode
                    </label>
                    <select
                      value={draft.sttWsMode}
                      onChange={(e) =>
                        patch({ sttWsMode: e.target.value as 'meeting' | 'call' })
                      }
                      className="w-full rounded-[4px] border border-rail bg-well px-1.5 py-1 font-mono text-[11px]"
                    >
                      <option value="meeting">meeting</option>
                      <option value="call">call</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                      Lang
                    </label>
                    <input
                      type="text"
                      value={draft.sttLanguage}
                      onChange={(e) => patch({ sttLanguage: e.target.value })}
                      placeholder="auto"
                      className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                    />
                  </div>
                </>
              )}
            </div>

            {wsTestResult && (
              <div
                className={`rounded-[3px] border px-2.5 py-1 font-mono text-[10px] ${
                  wsTestResult.ok
                    ? 'border-emerald-700/30 bg-emerald-950/10 text-emerald-800'
                    : 'border-signal/40 bg-signal-tint text-signal'
                }`}
              >
                {wsTestResult.message}
              </div>
            )}

            {/* Combine STT + Diarization Checkbox */}
            <label className="flex items-center gap-2 pt-0.5 cursor-pointer select-none">
              <button
                type="button"
                role="checkbox"
                aria-checked={draft.sttIncludesDiarization}
                onClick={() =>
                  patch({ sttIncludesDiarization: !draft.sttIncludesDiarization })
                }
                className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition-colors ${
                  draft.sttIncludesDiarization
                    ? 'border-ink bg-ink text-well'
                    : 'border-rail-strong bg-well text-transparent'
                }`}
              >
                <Check className="h-2.5 w-2.5 stroke-[3]" />
              </button>
              <span className="text-[11.5px] font-medium text-ink">
                Include speaker diarization on this STT endpoint
              </span>
            </label>
          </div>
        )}
      </div>

      {/* 2 · DIARIZE (Speakers) */}
      {diarizeBundled ? (
        <div className="flex items-center justify-between rounded-[4px] border border-dashed border-rail-strong bg-chassis px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-muted">
              2 · DIARIZE
            </span>
            <span className="text-[11.5px] text-muted">
              Bundled with STT endpoint above
            </span>
          </div>
          <button
            type="button"
            onClick={() => patch({ sttIncludesDiarization: false })}
            className="rounded-[3px] border border-rail bg-well px-2 py-0.5 font-mono text-[10px] text-muted hover:text-ink hover:border-ink/40"
          >
            Separate
          </button>
        </div>
      ) : (
        <div
          className={`rounded-[4px] border px-3.5 py-3 space-y-2.5 ${
            draft.diarizeMode === 'local' && byId.diarize?.status === 'downloading'
              ? 'border-signal/50 bg-well'
              : 'border-rail bg-recessed'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] font-bold text-ink">
                2 · DIARIZE
              </span>
              <span className="text-[12px] text-muted">Speaker Diarization</span>
            </div>
            <ModeToggle
              value={draft.diarizeMode}
              onChange={(diarizeMode) => patch({ diarizeMode })}
            />
          </div>

          {draft.diarizeMode === 'local' ? (
            <LocalModelInlineRow
              model={byId.diarize}
              onDownload={onDownloadModel}
              onCancel={onCancelDownload}
            />
          ) : (
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-6">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Diarize Endpoint URL
                </label>
                <input
                  type="text"
                  value={draft.diarizeUrl}
                  onChange={(e) => patch({ diarizeUrl: e.target.value })}
                  placeholder="https://.../v1/audio/diarize"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
              <div className="col-span-2">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Auth
                </label>
                <select
                  value={draft.diarizeAuthScheme}
                  onChange={(e) =>
                    patch({ diarizeAuthScheme: e.target.value as AuthScheme })
                  }
                  className="w-full rounded-[4px] border border-rail bg-well px-1.5 py-1 font-mono text-[11px]"
                >
                  <option value="Api-Key">Api-Key</option>
                  <option value="Bearer">Bearer</option>
                  <option value="Token">Token</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div className="col-span-4">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  API Key
                </label>
                <input
                  type="password"
                  value={draft.diarizeApiKey}
                  onChange={(e) => patch({ diarizeApiKey: e.target.value })}
                  placeholder="Optional if same as STT…"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3 · LLM (Note Enhancement) */}
      <div
        className={`rounded-[4px] border px-3.5 py-3 space-y-2.5 ${
          draft.llmMode === 'local' && byId.chat?.status === 'downloading'
            ? 'border-signal/50 bg-well'
            : 'border-rail bg-recessed'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-ink">3 · LLM</span>
            <span className="text-[12px] text-muted">Note Enhancement</span>
          </div>
          <ModeToggle
            value={draft.llmMode}
            onChange={(llmMode) => patch({ llmMode })}
          />
        </div>

        {draft.llmMode === 'local' ? (
          <LocalModelInlineRow
            model={byId.chat}
            onDownload={onDownloadModel}
            onCancel={onCancelDownload}
          />
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-4">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Provider
                </label>
                <select
                  value={draft.cloudAiProvider}
                  onChange={(e) =>
                    patch({ cloudAiProvider: e.target.value as CloudAiProvider })
                  }
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px] font-semibold text-ink"
                >
                  <option value="openai-compatible">OpenAI-Compatible</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                </select>
              </div>

              {draft.cloudAiProvider === 'openai-compatible' ||
              draft.cloudAiProvider === 'custom' ? (
                <div className="col-span-4">
                  <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={draft.llmBaseUrl}
                    onChange={(e) => patch({ llmBaseUrl: e.target.value })}
                    placeholder="https://.../v1"
                    className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                  />
                </div>
              ) : null}

              <div
                className={
                  draft.cloudAiProvider === 'openai-compatible' ||
                  draft.cloudAiProvider === 'custom'
                    ? 'col-span-4'
                    : 'col-span-8'
                }
              >
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Model
                </label>
                <input
                  type="text"
                  value={draft.llmModel}
                  onChange={(e) => patch({ llmModel: e.target.value })}
                  placeholder="e.g. zai-org/GLM-5.3-Flash, gpt-4o-mini"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-3">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Auth
                </label>
                <select
                  value={draft.llmAuthScheme}
                  onChange={(e) =>
                    patch({ llmAuthScheme: e.target.value as AuthScheme })
                  }
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                >
                  <option value="Bearer">Bearer</option>
                  <option value="Api-Key">Api-Key</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div className="col-span-9">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  API Key
                </label>
                <input
                  type="password"
                  value={draft.llmApiKey}
                  onChange={(e) => patch({ llmApiKey: e.target.value })}
                  placeholder="Enter LLM API key…"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4 · EMBEDDING (Memory Vectors) */}
      <div
        className={`rounded-[4px] border px-3.5 py-3 space-y-2.5 ${
          draft.embeddingMode === 'local' && byId.embed?.status === 'downloading'
            ? 'border-signal/50 bg-well'
            : 'border-rail bg-recessed'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-ink">
              4 · EMBEDDING
            </span>
            <span className="text-[12px] text-muted">Memory Vectors</span>
          </div>
          <ModeToggle
            value={draft.embeddingMode}
            onChange={(embeddingMode) => patch({ embeddingMode })}
          />
        </div>

        {draft.embeddingMode === 'local' ? (
          <LocalModelInlineRow
            model={byId.embed}
            onDownload={onDownloadModel}
            onCancel={onCancelDownload}
          />
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-8">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Base URL (defaults to LLM URL if blank)
                </label>
                <input
                  type="text"
                  value={draft.embeddingBaseUrl}
                  onChange={(e) => patch({ embeddingBaseUrl: e.target.value })}
                  placeholder="https://.../sync/v1"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
              <div className="col-span-4">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Model
                </label>
                <input
                  type="text"
                  value={draft.embeddingModel}
                  onChange={(e) => patch({ embeddingModel: e.target.value })}
                  placeholder="default"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-3">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  Auth
                </label>
                <select
                  value={draft.embeddingAuthScheme}
                  onChange={(e) =>
                    patch({ embeddingAuthScheme: e.target.value as AuthScheme })
                  }
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                >
                  <option value="Api-Key">Api-Key</option>
                  <option value="Bearer">Bearer</option>
                  <option value="none">None</option>
                </select>
              </div>
              <div className="col-span-9">
                <label className="block font-mono text-[9.5px] text-muted mb-0.5">
                  API Key (optional — uses LLM key if blank)
                </label>
                <input
                  type="password"
                  value={draft.embeddingApiKey}
                  onChange={(e) => patch({ embeddingApiKey: e.target.value })}
                  placeholder="Separate embedding API key (optional)…"
                  className="w-full rounded-[4px] border border-rail bg-well px-2 py-1 font-mono text-[11px]"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
