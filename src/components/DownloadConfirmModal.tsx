import { Download, X } from 'lucide-react'
import type { LocalModelId, LocalModelInfo, NectarSettings } from '../types'
import { formatBytes } from '../utils/format'

export function getSelectedLocalModelIds(settings: NectarSettings): LocalModelId[] {
  const ids: LocalModelId[] = []
  if (settings.sttMode === 'local') ids.push('stt')
  const diarizeBundled =
    settings.sttMode === 'cloud' && settings.sttIncludesDiarization
  if (!diarizeBundled && settings.diarizeMode === 'local') ids.push('diarize')
  if (settings.llmMode === 'local') ids.push('chat')
  if (settings.embeddingMode === 'local') ids.push('embed')
  return ids
}

export function getMissingSelectedLocalModels(
  settings: NectarSettings,
  localModels: LocalModelInfo[],
): LocalModelInfo[] {
  const selected = new Set(getSelectedLocalModelIds(settings))
  return localModels.filter(
    (m) =>
      selected.has(m.id) &&
      (m.status === 'not_downloaded' || m.status === 'error'),
  )
}

interface DownloadConfirmModalProps {
  models: LocalModelInfo[]
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}

export function DownloadConfirmModal({
  models,
  confirmLabel = 'Download & Continue',
  onCancel,
  onConfirm,
}: DownloadConfirmModalProps) {
  const totalBytes = models.reduce((sum, m) => sum + (m.totalBytes ?? 0), 0)
  const countLabel =
    models.length === 1 ? '1 local model' : `${models.length} local models`

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/50 backdrop-blur-[2px] p-4">
      <div className="w-full max-w-[490px] rounded-[6px] border border-rail bg-well shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-rail bg-strip px-4.5 py-3.5">
          <div className="flex items-center gap-2">
            <Download className="h-4 w-4 text-signal" />
            <span className="text-[14px] font-semibold tracking-[-0.015em] text-ink">
              Download local models?
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-muted hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3.5">
          <p className="text-[12.5px] text-muted leading-relaxed">
            Your current setup uses{' '}
            <strong className="font-semibold text-ink">{countLabel}</strong> that{' '}
            {models.length === 1 ? "isn't" : "aren't"} on this Mac yet. Confirm to
            download {models.length === 1 ? 'it' : 'them'} in the background:
          </p>

          <div className="space-y-2">
            {models.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between gap-3 rounded-[4px] border border-rail bg-recessed px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold text-ink">
                      {model.name}
                    </span>
                    <span className="font-mono text-[10px] text-muted">
                      · {model.role}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] text-dim mt-0.5">
                    {model.engine}
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] font-semibold text-ink tabular-nums">
                  ~{formatBytes(model.totalBytes)}
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between rounded-[4px] border border-rail bg-chassis px-3 py-2 font-mono text-[10.5px]">
            <span className="text-muted">
              Total download size ({models.length}{' '}
              {models.length === 1 ? 'model' : 'models'})
            </span>
            <span className="font-bold text-ink tabular-nums">
              ~{formatBytes(totalBytes)}
            </span>
          </div>

          <p className="font-mono text-[10px] text-dim leading-relaxed">
            Saved locally under ~/.cortex/models &amp; Core ML cache · You can keep
            using Nectar while downloading.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-rail bg-strip px-4.5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[4px] border border-rail bg-well px-3.5 py-1.5 font-mono text-[11px] text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-[4px] bg-signal px-3.5 py-1.5 font-mono text-[11px] font-semibold text-white hover:bg-signal-bright"
          >
            <Download className="h-3.5 w-3.5" />
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
