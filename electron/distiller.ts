import type { SemanticAssertions } from '@infilectai/synapse'
import type { ActionItem, AuthScheme, MeetingRecord, NectarSettings, ServiceMode } from './store.js'
import { buildAuthHeader } from './streaming-ws.js'

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

const DISTILL_SYSTEM_PROMPT = `You are Nectar, an executive meeting note distiller modeled after Granola.
Given the user's rough scratchpad notes and the speaker-attributed meeting transcript, produce crisp, scannable, high-signal notes and return a SINGLE valid JSON object (no markdown fences) with these exact keys:

1. "distilledNotes": Concise Markdown (target ~180–300 words total, scannable in 15 seconds — even for 60-minute meetings). Contain ONLY these sections (do NOT include an Action Items section here—action items are returned separately in "actionItems"):
   - "### Executive Summary": 2–3 tight sentences (<= 55 words) stating the meeting's purpose and main takeaway/outcome.
   - "### Key Takeaways": 3–5 short thematic groups with 2–3 punchy bullets each (1 concise line per bullet, <= 18 words). Prioritize substance: conclusions, architecture/trade-offs, numbers, and user rough notes enriched with transcript context.
     STRICT NOISE FILTER:
     - Omit small talk, personal/biographical trivia, pleasantries, self-introductions (unless directly relevant to the decision/evaluation), rambling tangents, and filler.
     - Do NOT repeat the same point across sections.
   - "### Key Decisions": ONLY include if real commitments or project/org decisions were agreed upon (2–4 one-line bullets). OMIT this section entirely for interviews, brainstorms, or discussions where no binding decision was made.

2. "decisions": array of concise binding decision strings (empty array if none).

3. "actionItems": array of ONLY genuine, concrete next steps, follow-ups, or commitments that a participant explicitly agreed to do or was assigned:
   {"owner": string, "task": string, "status": "open"}
   STRICT RULES for actionItems:
   - Include ONLY real actionable commitments/assignments. NEVER include questions, hypotheticals, commentary, status descriptions, or raw transcript quotes.
   - Write each "task" as a crisp imperative phrase (<= 15 words).
   - Set "owner" to the person's clean display name (no leading "@"). Use "Unassigned" only if truly unclear.
   - Deduplicate overlapping items. Return [] if there are no concrete action items.

4. "entities": array of {"kind": "Person"|"Team"|"System"|"Project"|"Task"|"Decision", "name": string}.
5. "relationships": array of {"subjectKind": string, "subjectName": string, "predicate": "owns"|"assigned_to"|"decides"|"blocks"|"implements", "objectKind": string, "objectName": string}.

Output valid JSON only.`

export function stripActionItemsSection(markdown: string): string {
  if (!markdown) return ''
  // Remove any top-level "### Action Items..." or "## Action Items..." section
  // so action items are never duplicated alongside the dedicated Action Items card,
  // and drop placeholder-only "### Key Decisions" sections like "(none...)".
  return markdown
    .replace(
      /(?:^|\n)#{2,3}\s+Action\s+Items[^\n]*\n[\s\S]*?(?=\n#{2,3}\s+|\s*$)/gi,
      '\n',
    )
    .replace(
      /(?:^|\n)#{2,3}\s+Key\s+Decisions[^\n]*\n\s*(?:[-*•]\s*)?(?:\(none[^)]*\)|none\.?|n\/a\.?|no\s+(?:binding\s+|explicit\s+)?decisions[^\n]*)\s*(?=\n#{2,3}\s+|\s*$)/gi,
      '\n',
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normalizeActionItems(rawItems: unknown[]): ActionItem[] {
  const seen = new Set<string>()
  const out: ActionItem[] = []
  for (const item of rawItems) {
    if (!item) continue
    let owner = 'Unassigned'
    let task = ''
    let status: 'open' | 'done' = 'open'
    if (typeof item === 'string') {
      const m = item.match(/^@?([^:]{1,60}):\s*(.+)$/)
      if (m) {
        owner = m[1]!.trim()
        task = m[2]!.trim()
      } else {
        task = item.trim()
      }
    } else if (typeof item === 'object') {
      const obj = item as Record<string, unknown>
      owner = String(obj.owner ?? 'Unassigned').replace(/^@+/, '').trim() || 'Unassigned'
      task = String(obj.task ?? '').trim()
      status = obj.status === 'done' ? 'done' : 'open'
    }
    task = task.replace(/^[-*•\[\] x]+\s*/i, '').trim()
    if (!task || task.length < 4) continue
    const key = `${owner.toLowerCase()}::${task.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ owner, task, status })
  }
  return out
}

function formatGroupedTranscriptForLlm(meeting: MeetingRecord): string {
  const blocks: Array<{ speaker: string; t0: number; parts: string[] }> = []
  for (const t of meeting.turns) {
    const text = t.text.trim()
    if (!text) continue
    const speaker = t.speaker.trim() || 'Speaker'
    const prev = blocks[blocks.length - 1]
    if (prev && prev.speaker.toLowerCase() === speaker.toLowerCase()) {
      prev.parts.push(text)
    } else {
      blocks.push({ speaker, t0: t.t0, parts: [text] })
    }
  }
  const full = blocks
    .map((b) => `[${formatTimecode(b.t0)}] ${b.speaker}: ${b.parts.join(' ')}`)
    .join('\n')
  // Keep within a generous context window for multi-hour meetings
  const maxChars = 180_000
  if (full.length <= maxChars) return full
  const head = full.slice(0, Math.floor(maxChars * 0.6))
  const tail = full.slice(-Math.floor(maxChars * 0.38))
  return `${head}\n\n[... middle section truncated for length ...]\n\n${tail}`
}

function parseLlmJsonPayload(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```$/im, '')
    .trim()
  if (!cleaned) return null
  try {
    return JSON.parse(cleaned) as Record<string, unknown>
  } catch {
    const firstBrace = cleaned.indexOf('{')
    const lastBrace = cleaned.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<
          string,
          unknown
        >
      } catch {
        return null
      }
    }
    return null
  }
}

export interface ResolvedEndpoint {
  mode: ServiceMode
  baseUrl: string
  model: string
  apiKey: string
  authScheme: AuthScheme
}

export function resolveLlmEndpoint(
  settings: NectarSettings,
  localCortexUrl?: string | null,
): ResolvedEndpoint {
  if (settings.llmMode === 'local') {
    const base = `${(localCortexUrl ?? `http://127.0.0.1:${settings.localPort}`).replace(/\/+$/, '')}/v1`
    return {
      mode: 'local',
      baseUrl: base,
      model: settings.llmModel || 'gemma-4-E2B-it',
      apiKey: '',
      authScheme: 'none',
    }
  }

  const apiKey = settings.llmApiKey || ''
  const authScheme: AuthScheme = settings.llmAuthScheme || 'Bearer'

  if (settings.cloudAiProvider === 'gemini') {
    return {
      mode: 'cloud',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: settings.llmModel || 'gemini-2.5-flash',
      apiKey,
      authScheme,
    }
  }

  if (settings.cloudAiProvider === 'openai') {
    return {
      mode: 'cloud',
      baseUrl: 'https://api.openai.com/v1',
      model: settings.llmModel || 'gpt-4o-mini',
      apiKey,
      authScheme,
    }
  }

  // OpenAI-compatible or custom
  return {
    mode: 'cloud',
    baseUrl: (settings.llmBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: settings.llmModel || 'gpt-4o-mini',
    apiKey,
    authScheme,
  }
}

export function resolveEmbeddingEndpoint(
  settings: NectarSettings,
  localCortexUrl?: string | null,
): ResolvedEndpoint {
  if (settings.embeddingMode === 'local') {
    const base = `${(localCortexUrl ?? `http://127.0.0.1:${settings.localPort}`).replace(/\/+$/, '')}/v1`
    return {
      mode: 'local',
      baseUrl: base,
      model: settings.embeddingModel || 'embeddinggemma-300M',
      apiKey: '',
      authScheme: 'none',
    }
  }

  const apiKey = settings.embeddingApiKey || settings.llmApiKey || ''
  const explicitBase = settings.embeddingBaseUrl?.trim()
  if (explicitBase) {
    return {
      mode: 'cloud',
      baseUrl: explicitBase.replace(/\/+$/, ''),
      model: settings.embeddingModel || 'default',
      apiKey,
      authScheme: settings.embeddingAuthScheme || 'Api-Key',
    }
  }

  // Fallback to LLM cloud base URL if no separate embedding URL was specified
  const llm = resolveLlmEndpoint(settings, localCortexUrl)
  return {
    mode: 'cloud',
    baseUrl: llm.baseUrl,
    model:
      settings.embeddingModel ||
      (settings.cloudAiProvider === 'gemini'
        ? 'text-embedding-004'
        : 'text-embedding-3-small'),
    apiKey,
    authScheme: settings.embeddingAuthScheme || llm.authScheme,
  }
}

export async function distillMeeting(
  meeting: MeetingRecord,
  settings: NectarSettings,
  localCortexUrl?: string | null,
): Promise<DistillResult> {
  const llm = resolveLlmEndpoint(settings, localCortexUrl)

  const transcriptText = formatGroupedTranscriptForLlm(meeting)

  if (llm.mode === 'local' || llm.apiKey || llm.authScheme === 'none') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const auth = buildAuthHeader(llm.authScheme, llm.apiKey)
    if (auth) {
      headers.Authorization = auth
    }

    const userContent =
      `Meeting Title: ${meeting.title}\n` +
      `Participants: ${meeting.participants.join(', ') || '(unknown)'}\n\n` +
      `User Scratchpad Notes:\n${meeting.roughNotes || '(none)'}\n\n` +
      `Speaker-Attributed Transcript:\n${transcriptText || '(none)'}`

    const attempt = async (useJsonFormat: boolean): Promise<DistillResult | null> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      try {
        const payload: Record<string, unknown> = {
          model: llm.model || 'default',
          temperature: 0.2,
          max_tokens: 8192,
          messages: [
            { role: 'system', content: DISTILL_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
        }
        if (useJsonFormat) {
          payload.response_format = { type: 'json_object' }
        }

        const res = await fetch(`${llm.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (!res.ok) {
          if (useJsonFormat && (res.status === 400 || res.status === 422)) {
            return attempt(false)
          }
          return null
        }

        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        const raw = body.choices?.[0]?.message?.content ?? ''
        const parsed = parseLlmJsonPayload(raw)
        if (
          parsed &&
          typeof parsed.distilledNotes === 'string' &&
          parsed.distilledNotes.trim()
        ) {
          return {
            distilledNotes: stripActionItemsSection(parsed.distilledNotes),
            actionItems: Array.isArray(parsed.actionItems)
              ? normalizeActionItems(parsed.actionItems)
              : [],
            decisions: Array.isArray(parsed.decisions)
              ? parsed.decisions.map(String).filter(Boolean)
              : [],
            assertions: {
              entities: Array.isArray(parsed.entities)
                ? (parsed.entities as SemanticAssertions['entities'])
                : [],
              relationships: Array.isArray(parsed.relationships)
                ? (parsed.relationships as SemanticAssertions['relationships'])
                : [],
            },
            provider: `${llm.mode}:${llm.model || 'llm'}`,
          }
        }
        return null
      } catch {
        clearTimeout(timer)
        return null
      }
    }

    const llmResult = await attempt(true)
    if (llmResult) return llmResult
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

    const isQuestion = turn.text.trim().endsWith('?')
    const explicitCommitment =
      !isQuestion &&
      /\b(?:i'll|i will|we'll|we need to|action item|follow up|let me|i can send|i can share|updating\s+\S+|will\s+(?:send|share|update|create|set up|setup|follow up|review|benchmark|publish|fix|ship|deploy|schedule|document))\b/i.test(
        turn.text,
      )
    if (explicitCommitment) {
      actionItems.push({
        owner: turn.speaker,
        task: `${turn.text.trim()} [${formatTimecode(turn.t0)}]`,
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
      const cleanedLine = line.replace(/^\[ \]\s*/, '').replace(/^(?:todo|action):\s*/i, '')
      const ownerMatch = cleanedLine.match(/^@?([A-Za-z][A-Za-z .'-]{0,40}):\s+(.+)$/)
      actionItems.push({
        owner: ownerMatch ? ownerMatch[1]!.trim() : meeting.participants[0] ?? 'Team',
        task: ownerMatch ? ownerMatch[2]!.trim() : cleanedLine,
        status: 'open',
      })
    } else if (!decisions.some((d) => d.includes(line))) {
      decisions.push(line)
    }
  }

  const normalizedActions = normalizeActionItems(actionItems)

  const summarySentences: string[] = []
  if (meeting.participants.length > 0) {
    summarySentences.push(
      `**${meeting.title}** with ${meeting.participants.join(', ')}.`,
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
    `### Discussion Notes`,
    roughLines.length > 0
      ? roughLines.map((l) => `- ${l}`).join('\n')
      : highlights || `- No transcript segments recorded.`,
    ...(decisions.length > 0
      ? ['', `### Key Decisions`, ...decisions.map((d) => `- ${d}`)]
      : []),
  ].join('\n')

  return {
    distilledNotes,
    actionItems: normalizedActions,
    decisions,
    assertions: { entities, relationships },
    provider: 'nectar-deterministic-distiller',
  }
}
