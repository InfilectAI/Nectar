import type { Participant } from '@infilectai/aira'

export interface SpeakerResolution {
  speaker: string
  participantId: string | null
  relabelCluster?: {
    clusterId: string
    speaker: string
    participantId: string | null
  }
}

interface VisualSpan {
  participantId: string
  name: string
  start: number
  end: number // Infinity while still active
}

interface AudioEnergySample {
  t: number
  sysRMS: number
  micRMS: number
  micActive: boolean
}

export function formatClusterFallback(clusterId: string): string {
  const m = clusterId.match(/^speaker_(\d+)$/i)
  if (m) {
    return `Speaker ${Number(m[1]) + 1}`
  }
  return clusterId || 'Speaker 1'
}

export function isGenericSpeakerLabel(label: string): boolean {
  return /^(?:speaker[_ ]\d+|speaker)$/i.test(label.trim())
}

/**
 * Maps anonymous diarization cluster labels (`speaker_0`, `speaker_1`, ...)
 * emitted by streaming WebSocket STT servers onto real participant names from
 * Aira's visual Accessibility scraper (`roster`, `speaker_change`) and local
 * microphone energy (`micActive`, `micRMS`, `sysRMS`), aligned to the WebSocket
 * audio timeline (`sentAudioSeconds`).
 */
export class StreamingSpeakerResolver {
  private roster: Participant[] = []
  private localUserName = 'You'
  private spans: VisualSpan[] = []
  private audioSamples: AudioEnergySample[] = []
  private clusterVotes = new Map<string, Map<string, { score: number; participantId: string }>>()
  private clusterResolved = new Map<string, { name: string; participantId: string }>()
  private lockedClusters = new Map<string, string>()
  private currentVisual: { participantId: string; name: string; updatedAtMs: number } | null = null

  /**
   * Permanently binds a diarization cluster (e.g. `speaker_0`) to a user-chosen
   * speaker name so all future turns and partials for that voice stay attributed.
   */
  lockCluster(clusterId: string, speaker: string): void {
    const cleanCluster = clusterId.trim()
    const cleanName = speaker.trim()
    if (!cleanCluster || !cleanName) return
    this.lockedClusters.set(cleanCluster, cleanName)
    this.clusterResolved.set(cleanCluster, {
      name: cleanName,
      participantId: cleanCluster,
    })
  }

  recordRoster(participants: Participant[], localUserName?: string): void {
    if (participants.length > 0) {
      this.roster = participants
    }
    if (localUserName && localUserName.trim()) {
      this.localUserName = localUserName.trim()
    }
  }

  recordSpeakerChange(
    participantId: string,
    name: string,
    wsSec: number,
    source?: string,
  ): void {
    // Local microphone activity is handled directly by `recordAudio` +
    // `isLocalMicDominant` so brief mic bleed never closes an active remote
    // visual speaker's span.
    if (source === 'mic' || participantId === 'local') return

    const cleanName = name.trim()
    if (!cleanName || isGenericSpeakerLabel(cleanName)) return

    const t = Math.max(0, wsSec)
    const last = this.spans[this.spans.length - 1]
    if (last && last.end === Infinity) {
      if (last.name === cleanName) {
        this.currentVisual = { participantId, name: cleanName, updatedAtMs: Date.now() }
        return
      }
      last.end = Math.max(last.start + 0.1, t)
    }

    this.spans.push({
      participantId: participantId || cleanName,
      name: cleanName,
      start: Math.max(0, t - 0.25), // compensate for ~250ms AX poll lag
      end: Infinity,
    })
    if (this.spans.length > 600) {
      this.spans.splice(0, this.spans.length - 600)
    }
    this.currentVisual = {
      participantId: participantId || cleanName,
      name: cleanName,
      updatedAtMs: Date.now(),
    }
  }

  recordAudio(wsSec: number, sysRMS: number, micRMS: number, micActive: boolean): void {
    this.audioSamples.push({ t: Math.max(0, wsSec), sysRMS, micRMS, micActive })
    if (this.audioSamples.length > 1500) {
      this.audioSamples.splice(0, this.audioSamples.length - 1500)
    }
  }

  private isLocalMicDominant(start: number, end: number): boolean {
    const slice = this.audioSamples.filter(
      (s) => s.t >= start - 0.35 && s.t <= end + 0.35,
    )
    if (slice.length === 0) return false
    let sumSys = 0
    let sumMic = 0
    let activeCount = 0
    for (const s of slice) {
      sumSys += s.sysRMS
      sumMic += s.micRMS
      if (s.micActive || s.micRMS > 0.022) activeCount += 1
    }
    const meanSys = sumSys / slice.length
    const meanMic = sumMic / slice.length
    const activeRatio = activeCount / slice.length
    const micActive = activeRatio >= 0.35 || meanMic > 0.022
    return micActive && (meanSys < 0.015 || meanMic > meanSys * 1.8)
  }

  private bestVisualOverlap(
    start: number,
    end: number,
    wsNowSec: number,
  ): { participantId: string; name: string; overlap: number } | null {
    if (this.spans.length === 0) return null
    const q0 = Math.max(0, start - 0.5)
    const q1 = Math.max(q0 + 0.2, end + 0.5)
    const scores = new Map<string, { participantId: string; overlap: number }>()

    for (const span of this.spans) {
      const spanEnd = span.end === Infinity ? Math.max(wsNowSec + 0.5, q1) : span.end
      const ov = Math.min(q1, spanEnd) - Math.max(q0, span.start)
      if (ov > 0) {
        const prev = scores.get(span.name)
        scores.set(span.name, {
          participantId: span.participantId,
          overlap: (prev?.overlap ?? 0) + ov,
        })
      }
    }

    let best: { participantId: string; name: string; overlap: number } | null = null
    for (const [name, entry] of scores.entries()) {
      if (!best || entry.overlap > best.overlap) {
        best = { name, participantId: entry.participantId, overlap: entry.overlap }
      }
    }
    return best
  }

  private addVote(
    clusterId: string,
    name: string,
    participantId: string,
    weight: number,
  ): boolean {
    if (!clusterId || !name || isGenericSpeakerLabel(name)) return false
    let bucket = this.clusterVotes.get(clusterId)
    if (!bucket) {
      bucket = new Map()
      this.clusterVotes.set(clusterId, bucket)
    }
    const prev = bucket.get(name)
    bucket.set(name, {
      score: (prev?.score ?? 0) + Math.max(0.2, weight),
      participantId,
    })

    let winner: { name: string; participantId: string; score: number } | null = null
    for (const [candidate, info] of bucket.entries()) {
      if (!winner || info.score > winner.score) {
        winner = { name: candidate, participantId: info.participantId, score: info.score }
      }
    }

    if (!winner) return false
    const existing = this.clusterResolved.get(clusterId)
    if (!existing || existing.name !== winner.name) {
      this.clusterResolved.set(clusterId, {
        name: winner.name,
        participantId: winner.participantId,
      })
      return true
    }
    return false
  }

  resolve(
    rawClusterId: string,
    start: number,
    end: number,
    wsNowSec: number,
    recordVotes: boolean = true,
  ): SpeakerResolution {
    const clusterId = (rawClusterId || 'speaker_0').trim()
    const locked = this.lockedClusters.get(clusterId)
    if (locked) {
      return {
        speaker: locked,
        participantId: clusterId,
      }
    }
    const duration = Math.max(0.5, end - start)

    // 1. Local mic clearly active and dominant -> local user
    if (this.isLocalMicDominant(start, end)) {
      const changed = recordVotes
        ? this.addVote(clusterId, this.localUserName, 'local', duration)
        : false
      return {
        speaker: this.localUserName,
        participantId: clusterId,
        relabelCluster: changed
          ? { clusterId, speaker: this.localUserName, participantId: clusterId }
          : undefined,
      }
    }

    // 2. Direct visual active-speaker overlap from Zoom / Meet / Teams AX scraper
    const visual = this.bestVisualOverlap(start, end, wsNowSec)
    if (visual) {
      const changed = recordVotes
        ? this.addVote(clusterId, visual.name, visual.participantId, visual.overlap)
        : false
      return {
        speaker: visual.name,
        participantId: clusterId,
        relabelCluster: changed
          ? { clusterId, speaker: visual.name, participantId: clusterId }
          : undefined,
      }
    }

    // 3. Previously learned mapping for this diarizer cluster
    const mapped = this.clusterResolved.get(clusterId)
    if (mapped) {
      return {
        speaker: mapped.name,
        participantId: clusterId,
      }
    }

    // 4. Recent visual speaker within 4 seconds
    if (this.currentVisual && Date.now() - this.currentVisual.updatedAtMs < 4000) {
      const changed = recordVotes
        ? this.addVote(
            clusterId,
            this.currentVisual.name,
            this.currentVisual.participantId,
            0.5,
          )
        : false
      return {
        speaker: this.currentVisual.name,
        participantId: clusterId,
        relabelCluster: changed
          ? {
              clusterId,
              speaker: this.currentVisual.name,
              participantId: clusterId,
            }
          : undefined,
      }
    }

    // 5. 2-person call fallback when local mic is silent
    const remotes = this.roster.filter(
      (p) =>
        p.name &&
        p.name.toLowerCase() !== this.localUserName.toLowerCase() &&
        !isGenericSpeakerLabel(p.name),
    )
    if (remotes.length === 1) {
      const remote = remotes[0]!
      const changed = recordVotes
        ? this.addVote(clusterId, remote.name, remote.id, 0.5)
        : false
      return {
        speaker: remote.name,
        participantId: clusterId,
        relabelCluster: changed
          ? { clusterId, speaker: remote.name, participantId: clusterId }
          : undefined,
      }
    }

    return {
      speaker: formatClusterFallback(clusterId),
      participantId: clusterId,
    }
  }
}
