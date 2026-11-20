import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import type {
  AppState,
  CloudServiceKey,
  LocalModelId,
  LocalModelInfo,
  NectarSettings,
  ServiceValidationResult,
} from '../types'
import {
  DownloadConfirmModal,
  getMissingSelectedLocalModels,
  getSelectedLocalModelIds,
} from './DownloadConfirmModal'
import { ServiceStackEditor } from './ServiceStackEditor'

interface OnboardingWizardProps {
  state: AppState
  onSaveSettings: (patch: Partial<NectarSettings>) => Promise<void>
  onComplete: () => Promise<void>
  onCheckPermissions: (prompt: boolean) => Promise<void>
  onRefreshModels: () => void
  onRestartCortex: () => void
  onDownloadModel: (id: LocalModelId) => void
  onDownloadModels: (ids: LocalModelId[]) => void
  onCancelDownload: (id: LocalModelId) => void
  onOpenModelsFolder: () => void
}

export function OnboardingWizard({
  state,
  onSaveSettings,
  onComplete,
  onCheckPermissions,
  onRefreshModels,
  onRestartCortex,
  onDownloadModel,
  onDownloadModels,
  onCancelDownload,
  onOpenModelsFolder,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<1 | 2>(1)
  const [draft, setDraft] = useState<NectarSettings>(state.settings)
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validationResults, setValidationResults] = useState<
    Partial<Record<CloudServiceKey, ServiceValidationResult>>
  >({})
  const [validationFailed, setValidationFailed] = useState(false)
  const [pendingDownloads, setPendingDownloads] = useState<LocalModelInfo[] | null>(
    null,
  )

  const selectedLocalIds = getSelectedLocalModelIds(draft)
  const localCount = selectedLocalIds.length
  const cloudCount = 4 - localCount
  const anyDownloading = state.localModels.some(
    (m) => m.status === 'downloading' || m.status === 'loading',
  )

  const micGranted = state.permissions?.microphone === 'granted'
  const axGranted = state.permissions?.accessibility === 'granted'

  const handleDraftChange = (next: NectarSettings) => {
    setDraft(next)
    setValidationFailed(false)
  }

  const persistAndAdvance = async (startModelIds?: LocalModelId[]) => {
    setSaving(true)
    try {
      await onSaveSettings(draft)
      if (startModelIds && startModelIds.length > 0) {
        onDownloadModels(startModelIds)
      }
      setPendingDownloads(null)
      setStep(2)
    } finally {
      setSaving(false)
    }
  }

  const proceedAfterValidation = async () => {
    const missing = getMissingSelectedLocalModels(draft, state.localModels)
    if (missing.length > 0) {
      setPendingDownloads(missing)
      return
    }
    await persistAndAdvance()
  }

  const handleContinueFromStep1 = async (skipValidation = false) => {
    if (!skipValidation && cloudCount > 0) {
      setValidating(true)
      setValidationFailed(false)
      try {
        const res = await window.nectar.validateCloudSettings(draft)
        const map: Partial<Record<CloudServiceKey, ServiceValidationResult>> = {}
        for (const r of res.results) {
          map[r.service] = r
        }
        setValidationResults(map)
        if (!res.ok) {
          setValidationFailed(true)
          return
        }
      } finally {
        setValidating(false)
      }
    }
    await proceedAfterValidation()
  }

  const steps = [
    { num: 1 as const, label: 'Services' },
    { num: 2 as const, label: 'Permissions' },
  ]

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 backdrop-blur-[2px] p-4">
        <div className="w-full max-w-2xl rounded-[6px] border border-rail bg-well shadow-2xl overflow-hidden flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-rail bg-strip px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <Sparkles className="h-4 w-4 text-signal" />
              <span className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">
                Welcome to Nectar
              </span>
              <span className="rounded-[3px] border border-rail bg-well px-1.5 py-0.5 font-mono text-[10px] text-muted">
                Step {step} of 2
              </span>
            </div>

            <button
              type="button"
              onClick={onComplete}
              title="Skip setup for now"
              className="inline-flex items-center gap-1 rounded-[3px] px-2 py-1 font-mono text-[10.5px] text-muted hover:text-ink"
            >
              <span>Skip</span>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Stepper */}
          <div className="flex items-center gap-2 border-b border-rail bg-chassis px-5 py-2.5 font-mono text-[11px]">
            {steps.map((s, idx) => {
              const done = step > s.num
              const current = step === s.num
              return (
                <div key={s.num} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(s.num)}
                    className={`inline-flex items-center gap-1.5 rounded-[3px] px-2 py-0.5 transition-colors ${
                      current
                        ? 'bg-well text-ink font-semibold border border-rail'
                        : done
                          ? 'text-emerald-800'
                          : 'text-dim hover:text-muted'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full text-[9.5px] font-semibold ${
                        done
                          ? 'bg-emerald-700 text-white'
                          : current
                            ? 'bg-signal text-white'
                            : 'bg-strip text-muted'
                      }`}
                    >
                      {done ? <Check className="h-2.5 w-2.5 stroke-[2.5]" /> : s.num}
                    </span>
                    <span>{s.label}</span>
                  </button>
                  {idx < steps.length - 1 && (
                    <span className="text-rail-strong">/</span>
                  )}
                </div>
              )
            })}
          </div>

          {/* Body */}
          <div className="p-5 max-h-[72vh] overflow-y-auto space-y-4">
            {/* STEP 1: CONFIGURE YOUR 4 SERVICES */}
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-[16.5px] font-semibold tracking-[-0.02em] text-ink">
                    Configure your 4 services
                  </h2>
                  <p className="mt-0.5 text-[12.5px] text-muted leading-relaxed">
                    Mix and match Local and Cloud per service. Combine STT &amp;
                    diarization on a single endpoint whenever your provider supports it.
                  </p>
                </div>

                <ServiceStackEditor
                  draft={draft}
                  onChange={handleDraftChange}
                  cortexStatus={state.cortexStatus}
                  cortexError={state.cortexError}
                  localModels={state.localModels}
                  validationResults={validationResults}
                  onRefreshModels={onRefreshModels}
                  onRestartCortex={onRestartCortex}
                  onDownloadModel={onDownloadModel}
                  onCancelDownload={onCancelDownload}
                  onOpenModelsFolder={onOpenModelsFolder}
                />
              </div>
            )}

            {/* STEP 2: MACOS PERMISSIONS */}
            {step === 2 && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-[16.5px] font-semibold tracking-[-0.02em] text-ink">
                    Grant macOS capture permissions
                  </h2>
                  <p className="mt-1 text-[12.5px] text-muted leading-relaxed">
                    Nectar uses Microphone and Accessibility (never Screen Recording) to
                    detect calls and attribute speakers accurately.
                  </p>
                </div>

                <div className="space-y-2.5">
                  <div className="flex items-center justify-between rounded-[4px] border border-rail bg-recessed px-4 py-3">
                    <div>
                      <div className="text-[13px] font-semibold text-ink">
                        Microphone Access
                      </div>
                      <div className="text-[11.5px] text-muted">
                        Captures and attributes your voice during meetings.
                      </div>
                    </div>
                    <span
                      className={`rounded-[3px] border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${
                        micGranted
                          ? 'border-emerald-700/30 bg-emerald-950/10 text-emerald-800'
                          : 'border-amber/40 bg-amber-tint text-amber'
                      }`}
                    >
                      {state.permissions?.microphone ?? 'unknown'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-[4px] border border-rail bg-recessed px-4 py-3">
                    <div>
                      <div className="text-[13px] font-semibold text-ink">
                        Accessibility Access
                      </div>
                      <div className="text-[11.5px] text-muted">
                        Detects active Google Meet, Zoom, and Teams windows &amp; speaker
                        names.
                      </div>
                    </div>
                    <span
                      className={`rounded-[3px] border px-2 py-0.5 font-mono text-[10.5px] font-semibold ${
                        axGranted
                          ? 'border-emerald-700/30 bg-emerald-950/10 text-emerald-800'
                          : 'border-amber/40 bg-amber-tint text-amber'
                      }`}
                    >
                      {state.permissions?.accessibility ?? 'unknown'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onCheckPermissions(true)}
                    className="inline-flex items-center gap-1.5 rounded-[4px] bg-ink px-3.5 py-1.5 font-mono text-[11px] font-semibold text-well hover:bg-signal-bright"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Grant Permissions
                  </button>
                  <button
                    type="button"
                    onClick={() => onCheckPermissions(false)}
                    className="rounded-[4px] border border-rail bg-well px-3 py-1.5 font-mono text-[11px] text-muted hover:text-ink"
                  >
                    Re-check
                  </button>
                </div>

                {anyDownloading && (
                  <div className="rounded-[4px] border border-signal/35 bg-signal-tint px-3.5 py-2.5 font-mono text-[11px] text-signal">
                    Local model downloads are running in the background — you can track
                    live progress in the top bar anytime.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-rail bg-strip px-5 py-3">
            <div>
              {step === 2 ? (
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="inline-flex items-center gap-1.5 rounded-[4px] border border-rail bg-well px-3 py-1.5 font-mono text-[11px] text-ink hover:border-ink/40"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
              ) : (
                <span className="font-mono text-[10.5px] text-muted">
                  {localCount} Local · {cloudCount} Cloud selected
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {step === 1 && validationFailed && (
                <button
                  type="button"
                  disabled={saving || validating}
                  onClick={() => handleContinueFromStep1(true)}
                  className="rounded-[4px] border border-rail bg-well px-3 py-1.5 font-mono text-[11px] text-muted hover:text-ink disabled:opacity-50"
                >
                  Continue Anyway
                </button>
              )}

              {step === 1 && (
                <button
                  type="button"
                  disabled={saving || validating}
                  onClick={() => handleContinueFromStep1(false)}
                  className="inline-flex items-center gap-1.5 rounded-[4px] bg-ink px-4 py-1.5 font-mono text-[11.5px] font-semibold text-well hover:bg-signal-bright disabled:opacity-50"
                >
                  {validating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>
                    {validating
                      ? 'Validating…'
                      : validationFailed
                        ? 'Retry & Continue'
                        : 'Continue'}
                  </span>
                  {!validating && <ArrowRight className="h-3.5 w-3.5" />}
                </button>
              )}

              {step === 2 && (
                <button
                  type="button"
                  onClick={onComplete}
                  className="inline-flex items-center gap-1.5 rounded-[4px] bg-signal px-4 py-1.5 font-mono text-[11.5px] font-semibold text-white hover:bg-signal-bright"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Start Using Nectar</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation popup whenever >=1 selected Local model isn't on disk yet */}
      {pendingDownloads && (
        <DownloadConfirmModal
          models={pendingDownloads}
          confirmLabel="Download & Continue"
          onCancel={() => setPendingDownloads(null)}
          onConfirm={() =>
            persistAndAdvance(pendingDownloads.map((m) => m.id))
          }
        />
      )}
    </>
  )
}
