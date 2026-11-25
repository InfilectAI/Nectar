export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let val = bytes
  let idx = 0
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024
    idx += 1
  }
  return `${val >= 100 || idx < 2 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`
}

export function formatSpeed(bytesPerSec: number | null | undefined): string | null {
  if (!bytesPerSec || bytesPerSec <= 0) return null
  return `${formatBytes(bytesPerSec)}/s`
}

export interface GroupableTurn {
  id: string
  speaker: string
  participantId: string | null
  text: string
  t0: number
  t1: number
}

export interface GroupedTranscriptBlock {
  id: string
  speaker: string
  participantId: string | null
  clusterKeys: string[]
  text: string
  t0: number
  t1: number
  turnIds: string[]
}

/**
 * Merges consecutive transcript turns spoken by the same speaker into a single
 * display block while preserving the start/end timecodes and cluster keys.
 */
export function groupConsecutiveTurns<T extends GroupableTurn>(
  turns: readonly T[],
): GroupedTranscriptBlock[] {
  const blocks: GroupedTranscriptBlock[] = []

  for (const turn of turns) {
    const cleanText = turn.text.trim()
    if (!cleanText) continue
    const speaker = turn.speaker.trim() || 'Speaker'
    const normalizedSpeaker = speaker.toLowerCase()
    const clusterKey = (turn.participantId || speaker).trim()
    const prev = blocks[blocks.length - 1]

    if (prev && prev.speaker.toLowerCase() === normalizedSpeaker) {
      prev.text = `${prev.text} ${cleanText}`
      prev.t1 = Math.max(prev.t1, turn.t1)
      prev.turnIds.push(turn.id)
      if (!prev.participantId && turn.participantId) {
        prev.participantId = turn.participantId
      }
      if (clusterKey && !prev.clusterKeys.includes(clusterKey)) {
        prev.clusterKeys.push(clusterKey)
      }
    } else {
      blocks.push({
        id: turn.id,
        speaker,
        participantId: turn.participantId,
        clusterKeys: clusterKey ? [clusterKey] : [],
        text: cleanText,
        t0: turn.t0,
        t1: turn.t1,
        turnIds: [turn.id],
      })
    }
  }

  return blocks
}

export interface ActionItemLike {
  owner: string
  task: string
  status: 'open' | 'done'
}

export interface ActionItemGroup {
  owner: string
  items: ActionItemLike[]
}

/**
 * Groups action items by normalized owner name and deduplicates identical tasks
 * within each owner's list.
 */
export function groupActionItemsByOwner<T extends ActionItemLike>(
  items: readonly T[],
): ActionItemGroup[] {
  const byKey = new Map<string, { owner: string; items: ActionItemLike[]; seen: Set<string> }>()

  for (const item of items) {
    const owner = (item.owner || 'Unassigned').replace(/^@+/, '').trim() || 'Unassigned'
    const task = item.task.trim()
    if (!task) continue
    const ownerKey = owner.toLowerCase()
    let group = byKey.get(ownerKey)
    if (!group) {
      group = { owner, items: [], seen: new Set() }
      byKey.set(ownerKey, group)
    }
    const taskKey = task.toLowerCase()
    if (group.seen.has(taskKey)) continue
    group.seen.add(taskKey)
    group.items.push({ owner: group.owner, task, status: item.status })
  }

  return Array.from(byKey.values())
    .map(({ owner, items: groupItems }) => ({ owner, items: groupItems }))
    .sort((a, b) => {
      if (a.owner.toLowerCase() === 'unassigned') return 1
      if (b.owner.toLowerCase() === 'unassigned') return -1
      return b.items.length - a.items.length || a.owner.localeCompare(b.owner)
    })
}

export function stripMarkdownActionItemsSection(markdown: string): string {
  if (!markdown) return ''
  return markdown
    .replace(
      /(?:^|\n)#{2,3}\s+Action\s+Items[^\n]*\n[\s\S]*?(?=\n#{2,3}\s+|\s*$)/gi,
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}


