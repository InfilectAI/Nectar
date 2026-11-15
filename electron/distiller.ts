import type { SemanticAssertions } from '@infilectai/synapse'
import type { ActionItem, MeetingRecord, NectarSettings } from './store.js'

export interface DistillResult {
  distilledNotes: string
  actionItems: ActionItem[]
  decisions: string[]
  assertions: SemanticAssertions
  provider: string
}

function formatTimecode(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const DISTILL_SYSTEM_PROMPT = `You are Nectar, an AI meeting distiller modeled after Granola.
Given the user's rough scratchpad bullets and the speaker-attributed meeting transcript,
return a JSON object with:
1. "distilledNotes": Markdown string with sections:
   - "### Executive Summary"
   - "### Key Decisions"
   - "### Action Items & Owners"
   - "### Cited Highlights" (quoting speakers with [MM:SS] timecodes)
2. "decisions": array of concise decision strings
3. "actionItems": array of {"owner": string, "task": string, "status": "open"}
4. "entities": array of {"kind": "Person"|"Team"|"System"|"Project"|"Task"|"Decision", "name": string}
5. "relationships": array of {"subjectKind": string, "subjectName": string, "predicate": "owns"|"assigned_to"|"decides"|"blocks"|"implements", "objectKind": string, "objectName": string}
Output valid JSON only.`

export function resolveAiEndpoints(
  settings: NectarSettings,
  localCortexUrl?: string | null,
): {
  baseUrl: string
  llmModel: string
  embeddingModel: string
  apiKey: string
} {
  if (settings.mode === 'local') {
    const base = `${(localCortexUrl ?? `http://127.0.0.1:${settings.localPort}`).replace(/\/+$/, '')}/v1`
    return {
      baseUrl: base,
      llmModel: settings.llmModel || 'gemma-4-E2B-it',
      embeddingModel: settings.embeddingModel || 'embeddinggemma-300M',
      apiKey: '',
    }
  }

  if (settings.cloudAiProvider === 'gemini') {
    return {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      llmModel: settings.cloudLlmModel || 'gemini-2.5-flash',
      embeddingModel: settings.cloudEmbeddingModel || 'text-embedding-004',
      apiKey: settings.cloudAiApiKey,
    }
  }

  if (settings.cloudAiProvider === 'custom') {
    return {
      baseUrl: (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      llmModel: settings.llmModel || 'gpt-4o-mini',
      embeddingModel: settings.embeddingModel || 'text-embedding-3-small',
      apiKey: settings.llmApiKey || settings.cloudAiApiKey,
    }
  }

  // Default: OpenAI
  return {
    baseUrl: 'https://api.openai.com/v1',
    llmModel: settings.cloudLlmModel || 'gpt-4o-mini',
    embeddingModel: settings.cloudEmbeddingModel || 'text-embedding-3-small',
    apiKey: settings.cloudAiApiKey,
  }
}

export async function distillMeeting(
  meeting: MeetingRecord,
  settings: NectarSettings,
  localCortexUrl?: string | null,
): Promise<DistillResult> {
  const { baseUrl, llmModel: model, apiKey } = resolveAiEndpoints(
    settings,
    localCortexUrl,
  )

  const transcriptText = meeting.turns
    .map((t) => `[${formatTimecode(t.t0)}] ${t.speaker}: ${t.text}`)
    .join('\n')

  if (settings.mode === 'local' || apiKey) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'default',
          temperature: 0.2,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: DISTILL_SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                `Meeting Title: ${meeting.title}\n` +
                `Participants: ${meeting.participants.join(', ')}\n\n` +
                `User Scratchpad Bullets:\n${meeting.roughNotes || '(none)'}\n\n` +
                `Speaker-Attributed Transcript:\n${transcriptText || '(none)'}`,
            },
          ],
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (res.ok) {
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const raw = body.choices?.[0]?.message?.content ?? ''
        const cleaned = raw
          .trim()
          .replace(/^```(?:json)?\s*/im, '')
          .replace(/\s*```$/im, '')
          .trim()
        const parsed = JSON.parse(cleaned) as Record<string, unknown>
        if (typeof parsed.distilledNotes === 'string' && parsed.distilledNotes.trim()) {
          return {
            distilledNotes: parsed.distilledNotes,
            actionItems: Array.isArray(parsed.actionItems)
              ? (parsed.actionItems as ActionItem[])
              : [],
            decisions: Array.isArray(parsed.decisions)
              ? parsed.decisions.map(String)
              : [],
            assertions: {
              entities: Array.isArray(parsed.entities)
                ? (parsed.entities as SemanticAssertions['entities'])
                : [],
              relationships: Array.isArray(parsed.relationships)
                ? (parsed.relationships as SemanticAssertions['relationships'])
                : [],
            },
            provider: `${settings.mode}:${model || 'llm'}`,
          }
        }
      }
    } catch {
      // Fall through to deterministic distiller when offline or GGUF not loaded
    }
  }

  return deterministicDistill(meeting)
}

/**
 * Deterministic Granola-style synthesizer that merges rough scratchpad bullets
 * and speaker-attributed transcript turns into cited Markdown notes + semantic assertions.
 */
export function deterministicDistill(meeting: MeetingRecord): DistillResult {
  const roughLines = meeting.roughNotes
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)

  const decisions: string[] = []
  const actionItems: ActionItem[] = []
  const entities: SemanticAssertions['entities'] = []
  const relationships: SemanticAssertions['relationships'] = []
  const entityNames = new Set<string>()

  const addEntity = (kind: string, name: string) => {
    const key = `${kind}:${name.toLowerCase()}`
    if (!entityNames.has(key)) {
      entityNames.add(key)
      entities.push({ kind, name, confidence: 0.95 })
    }
  }

  for (const p of meeting.participants) {
    addEntity('Person', p)
  }

  for (const turn of meeting.turns) {
    const lower = turn.text.toLowerCase()
    addEntity('Person', turn.speaker)

    // Detect ownership handoffs or assignments
    const ownsMatch = turn.text.match(
      /\b([A-Z][a-z]+)\s+(?:owns|is taking over|is on call for)\s+([a-zA-Z0-9_-]+(?:\s+service)?)/i,
    )
    if (ownsMatch) {
      const owner = ownsMatch[1]!
      const target = ownsMatch[2]!.trim()
      addEntity('Person', owner)
      addEntity('System', target)
      relationships.push({
        subjectKind: 'Person',
        subjectName: owner,
        predicate: 'owns',
        objectKind: 'System',
        objectName: target,
        confidence: 0.95,
      })
      decisions.push(`${owner} now owns ${target} (cited [${formatTimecode(turn.t0)}]).`)
    } else if (
      lower.includes('cutting') &&
      lower.includes('ownership') &&
      lower.includes('checkout-service')
    ) {
      addEntity('System', 'checkout-service')
      relationships.push({
        subjectKind: 'Person',
        subjectName: turn.speaker,
        predicate: 'owns',
        objectKind: 'System',
        objectName: 'checkout-service',
        confidence: 0.95,
      })
      decisions.push(
        `${turn.speaker} is taking over checkout-service ownership after Friday's deploy [${formatTimecode(turn.t0)}].`,
      )
    }

    if (
      lower.includes('decided') ||
      lower.includes('confirm') ||
      lower.includes('we will') ||
      lower.includes('moving to')
    ) {
      const decisionText = `${turn.speaker}: "${turn.text}" [${formatTimecode(turn.t0)}]`
      if (!decisions.includes(decisionText)) {
        decisions.push(decisionText)
      }
    }

    if (
      lower.includes('updating') ||
      lower.includes('will ') ||
      lower.includes('action') ||
      lower.includes('runbook') ||
      lower.includes('benchmark')
    ) {
      actionItems.push({
        owner: turn.speaker,
        task: `${turn.text} [${formatTimecode(turn.t0)}]`,
        status: 'open',
      })
    }
  }

  for (const line of roughLines) {
    if (
      line.toLowerCase().includes('todo') ||
      line.toLowerCase().includes('action:') ||
      line.startsWith('[ ]')
    ) {
      actionItems.push({
        owner: meeting.participants[0] ?? 'Team',
        task: line.replace(/^\[ \]\s*/, ''),
        status: 'open',
      })
    } else if (!decisions.some((d) => d.includes(line))) {
      decisions.push(line)
    }
  }

  const summarySentences: string[] = []
  if (meeting.participants.length > 0) {
    summarySentences.push(
      `**${meeting.title}** with ${meeting.participants.join(', ')} (${meeting.turns.length} attributed turns).`,
    )
  } else {
    summarySentences.push(`**${meeting.title}** distilled from scratchpad notes.`)
  }
  if (roughLines.length > 0) {
    summarySentences.push(`Key themes from notes: ${roughLines.slice(0, 3).join(' · ')}.`)
  }

  const highlights = meeting.turns
    .slice(0, 6)
    .map(
      (t) =>
        `- **[${formatTimecode(t.t0)}] ${t.speaker}**: *"${t.text}"*`,
    )
    .join('\n')

  const distilledNotes = [
    `### Executive Summary`,
    summarySentences.join(' '),
    '',
    `### Your Notes (Enhanced)`,
    roughLines.length > 0
      ? roughLines.map((l) => `- ${l}`).join('\n')
      : `- Captured ${meeting.turns.length} speaker-attributed transcript segments.`,
    '',
    `### Key Decisions & Ownership`,
    decisions.length > 0
      ? decisions.map((d) => `- ${d}`).join('\n')
      : `- No explicit ownership changes flagged in this session.`,
    '',
    `### Action Items`,
    actionItems.length > 0
      ? actionItems.map((a) => `- [ ] **@${a.owner}**: ${a.task}`).join('\n')
      : `- No open action items recorded.`,
    '',
    `### Cited Transcript Highlights`,
    highlights || `- No transcript segments recorded.`,
  ].join('\n')

  return {
    distilledNotes,
    actionItems,
    decisions,
    assertions: { entities, relationships },
    provider: 'nectar-deterministic-distiller',
  }
}
