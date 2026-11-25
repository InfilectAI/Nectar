import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Square, X } from 'lucide-react'

export interface PillMeetingNotice {
  kind: 'started' | 'ended'
  title: string
  platform?: string
  isRecording?: boolean
}

export interface GranolaHandleProps {
  status: 'idle' | 'recording' | 'paused'
  meetingDetected?: boolean
  audioLevel?: number
  notice?: PillMeetingNotice | null
  noticeSide?: 'left' | 'right'
  onDismissNotice?: () => void
  onStart: () => void
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onOpenApp?: () => void
}

function NectarPillGlyph({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 28 28"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4" y="9" width="4.5" height="14.5" rx="1.2" fill="#E5E5E7" />
      <path d="M11 21.5L11 12L16.5 6.5L16.5 16L11 21.5Z" fill="#E5E5E7" />
      <rect x="19" y="4.5" width="4.5" height="12" rx="1.2" fill="#E5E5E7" />
      <circle cx="21.25" cy="21" r="2.5" fill="#FF5A1F" />
    </svg>
  )
}

export function GranolaHandle({
  status,
  meetingDetected = false,
  audioLevel = 0,
  notice = null,
  noticeSide = 'left',
  onDismissNotice,
  onStart,
  onPause,
  onResume,
  onStop,
  onOpenApp,
}: GranolaHandleProps) {
  const [hovered, setHovered] = useState(false)
  const [tick, setTick] = useState(0)

  const dragStateRef = useRef<{
    pointerDown: boolean
    captured: boolean
    pointerId: number
    lastScreenX: number
    lastScreenY: number
    totalMove: number
  }>({
    pointerDown: false,
    captured: false,
    pointerId: -1,
    lastScreenX: 0,
    lastScreenY: 0,
    totalMove: 0,
  })

  // Smooth organic bar animation while recording
  useEffect(() => {
    if (status !== 'recording') return
    const timer = setInterval(() => {
      setTick((t) => (t + 1) % 360)
    }, 90)
    return () => clearInterval(timer)
  }, [status])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragStateRef.current = {
      pointerDown: true,
      captured: false,
      pointerId: e.pointerId,
      lastScreenX: e.screenX,
      lastScreenY: e.screenY,
      totalMove: 0,
    }
    window.nectar.startPillDrag()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current
    if (!st.pointerDown) return
    const dx = e.screenX - st.lastScreenX
    const dy = e.screenY - st.lastScreenY
    if (dx === 0 && dy === 0) return

    st.lastScreenX = e.screenX
    st.lastScreenY = e.screenY
    st.totalMove += Math.hypot(dx, dy)

    // Only capture the pointer once movement exceeds the click threshold so child button clicks fire reliably
    if (st.totalMove > 4) {
      if (!st.captured) {
        st.captured = true
        try {
          e.currentTarget.setPointerCapture(st.pointerId)
        } catch {
          // ignore
        }
      }
      window.nectar.dragPill()
    }
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragStateRef.current
    if (st.pointerDown) {
      st.pointerDown = false
      if (st.captured) {
        st.captured = false
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          // ignore
        }
      }
    }
  }

  const wasDragged = () => dragStateRef.current.totalMove > 4

  // Compute the 3 bar heights in px (compact 6px–17px range matching Granola's small capsule)
  const computeBarHeights = (): [number, number, number] => {
    if (status === 'paused') {
      return [5, 5, 5]
    }
    if (status === 'idle') {
      return meetingDetected ? [7, 13, 10] : [6, 11, 8]
    }
    const boost = Math.min(1, Math.max(0.2, audioLevel * 3.2))
    const w1 = Math.sin(tick * 0.45) * 0.25 + 0.75
    const w2 = Math.sin(tick * 0.6 + 1.1) * 0.28 + 0.82
    const w3 = Math.sin(tick * 0.5 + 2.3) * 0.25 + 0.75

    const h1 = Math.round(5 + 8 * boost * w1)
    const h2 = Math.round(8 + 10 * boost * w2)
    const h3 = Math.round(6 + 9 * boost * w3)
    return [
      Math.max(5, Math.min(14, h1)),
      Math.max(8, Math.min(17, h2)),
      Math.max(6, Math.min(15, h3)),
    ]
  }

  const [bar1, bar2, bar3] = computeBarHeights()

  const barColor =
    status === 'recording'
      ? 'bg-[#4ADE80]'
      : status === 'paused'
        ? 'bg-[#F59E0B]'
        : meetingDetected
          ? 'bg-[#4ADE80]/85'
          : 'bg-[#71717A]'

  const noticeCard = notice ? (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="flex w-[224px] shrink-0 flex-col gap-1.5 rounded-[12px] bg-[#1C1C1E]/95 border border-white/14 px-3 py-2.5 shadow-[0_8px_22px_rgba(0,0,0,0.42)] backdrop-blur-md text-white"
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              notice.kind === 'started'
                ? 'bg-[#4ADE80] animate-pulse'
                : notice.isRecording
                  ? 'bg-[#FF5A1F] animate-pulse'
                  : 'bg-[#A1A1AA]'
            }`}
          />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-white/85 truncate">
            {notice.kind === 'started' ? 'Meeting started' : 'Meeting ended'}
          </span>
        </div>
        {onDismissNotice && (
          <button
            type="button"
            onClick={onDismissNotice}
            title="Dismiss"
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white/55 hover:bg-white/12 hover:text-white cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="text-[12px] font-medium leading-snug text-white/95 truncate">
        {notice.title}
      </div>

      {notice.kind === 'started' ? (
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => {
              onDismissNotice?.()
              onStart()
            }}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-full bg-[#4ADE80] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-[#111113] hover:bg-[#22C55E] transition-colors cursor-pointer"
          >
            <Play className="h-2.5 w-2.5 fill-current" />
            Record
          </button>
          {onOpenApp && (
            <button
              type="button"
              onClick={onOpenApp}
              className="rounded-full bg-white/12 px-2.5 py-1 font-mono text-[10.5px] font-medium text-white/85 hover:bg-white/20 transition-colors cursor-pointer"
            >
              Open
            </button>
          )}
        </div>
      ) : notice.isRecording ? (
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => {
              onDismissNotice?.()
              onStop()
            }}
            className="flex-1 inline-flex items-center justify-center gap-1 rounded-full bg-[#FF5A1F] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-white hover:bg-[#EA4C10] transition-colors cursor-pointer"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            Stop &amp; Enhance
          </button>
        </div>
      ) : null}
    </div>
  ) : null

  return (
    <div
      className={`flex items-end gap-2 select-none ${
        noticeSide === 'right' ? 'flex-row-reverse' : 'flex-row'
      }`}
    >
      {noticeCard}
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="group relative flex flex-col items-center cursor-grab active:cursor-grabbing"
      >
      <div
        className={`flex w-[36px] flex-col items-center justify-between rounded-full bg-[#1C1C1E]/95 border border-white/14 shadow-[0_6px_18px_rgba(0,0,0,0.36)] backdrop-blur-md transition-all duration-150 ease-out ${
          hovered ? 'py-2 gap-1.5' : 'h-[68px] py-2.5'
        }`}
      >
        {/* Top Emblem */}
        <button
          type="button"
          onClick={() => {
            if (wasDragged()) return
            if (onOpenApp) {
              onOpenApp()
            } else if (status === 'idle') {
              onStart()
            }
          }}
          title="Drag to move · Click to open Nectar"
          className="flex h-5 w-5 items-center justify-center rounded-full focus:outline-none cursor-inherit"
        >
          <NectarPillGlyph className="h-4 w-4" />
        </button>

        {/* Compact Transport Controls on Hover */}
        {hovered && (
          <div className="flex flex-col items-center gap-1 py-0.5">
            {status === 'idle' ? (
              <button
                type="button"
                onClick={() => {
                  if (!wasDragged()) onStart()
                }}
                title="Start recording"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-[#4ADE80] text-[#111113] hover:bg-[#22C55E] transition-colors cursor-pointer"
              >
                <Play className="h-2.5 w-2.5 fill-current ml-0.5" />
              </button>
            ) : (
              <>
                {status === 'recording' ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (!wasDragged()) onPause()
                    }}
                    title="Pause recording"
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-white/14 text-white hover:bg-white/24 transition-colors cursor-pointer"
                  >
                    <Pause className="h-2.5 w-2.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!wasDragged()) onResume()
                    }}
                    title="Resume recording"
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-[#4ADE80] text-[#111113] hover:bg-[#22C55E] transition-colors cursor-pointer"
                  >
                    <Play className="h-2.5 w-2.5 fill-current ml-0.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    if (!wasDragged()) onStop()
                  }}
                  title="Stop & Enhance Notes"
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FF5A1F] text-white hover:bg-[#EA4C10] transition-colors cursor-pointer"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                </button>
              </>
            )}
          </div>
        )}

        {/* Bottom 3 Vertical Equalizer Bars */}
        <button
          type="button"
          onClick={() => {
            if (wasDragged()) return
            if (status === 'idle') onStart()
            else if (status === 'recording') onPause()
            else onResume()
          }}
          title={
            status === 'idle'
              ? 'Click to start recording'
              : status === 'recording'
                ? 'Recording — click to pause'
                : 'Paused — click to resume'
          }
          className="flex h-5 items-center justify-center gap-[3.5px] px-1 cursor-pointer focus:outline-none"
        >
          <span
            style={{ height: `${bar1}px` }}
            className={`w-[3px] rounded-full transition-all duration-100 ${barColor}`}
          />
          <span
            style={{ height: `${bar2}px` }}
            className={`w-[3px] rounded-full transition-all duration-100 ${barColor}`}
          />
          <span
            style={{ height: `${bar3}px` }}
            className={`w-[3px] rounded-full transition-all duration-100 ${barColor}`}
          />
        </button>
      </div>
      </div>
    </div>
  )
}
