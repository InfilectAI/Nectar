import React from 'react'

interface MarkdownViewProps {
  content: string
  className?: string
}

/**
 * Renders inline Markdown tokens (`**bold**`, `*italic*`, `` `code` ``,
 * `[text](url)`, and `[MM:SS]` timecodes) into safe React nodes without
 * dangerouslySetInnerHTML.
 */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const tokenRe =
    /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|`[^`\n]+?`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\[\d{1,2}:\d{2}(?::\d{2})?\])/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  let idx = 0

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const full = match[0]
    const k = `${keyPrefix}-${idx++}`

    if (
      (full.startsWith('**') && full.endsWith('**')) ||
      (full.startsWith('__') && full.endsWith('__'))
    ) {
      const inner = full.slice(2, -2)
      nodes.push(
        <strong key={k} className="font-semibold text-ink">
          {renderInline(inner, `${k}-b`)}
        </strong>,
      )
    } else if (full.startsWith('*') && full.endsWith('*')) {
      const inner = full.slice(1, -1)
      nodes.push(
        <em key={k} className="italic text-ink/90">
          {renderInline(inner, `${k}-i`)}
        </em>,
      )
    } else if (full.startsWith('`') && full.endsWith('`')) {
      nodes.push(
        <code
          key={k}
          className="rounded-[3px] border border-rail bg-chassis px-1.5 py-0.5 font-mono text-[12px] text-ink"
        >
          {full.slice(1, -1)}
        </code>,
      )
    } else if (match[2] && match[3]) {
      nodes.push(
        <a
          key={k}
          href={match[3]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-signal underline decoration-signal/40 underline-offset-2 hover:decoration-signal"
        >
          {match[2]}
        </a>,
      )
    } else if (/^\[\d{1,2}:\d{2}(?::\d{2})?\]$/.test(full)) {
      nodes.push(
        <span
          key={k}
          className="inline-block rounded-[3px] border border-rail bg-chassis px-1.5 py-0.2 font-mono text-[11px] font-medium text-muted align-baseline"
        >
          {full.slice(1, -1)}
        </span>,
      )
    } else {
      nodes.push(full)
    }

    lastIndex = match.index + full.length
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

export function MarkdownView({ content, className = '' }: MarkdownViewProps) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: React.ReactNode[] = []

  let i = 0
  let blockIdx = 0

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!)
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push(
        <pre
          key={`b-${blockIdx++}`}
          className="overflow-x-auto rounded-[4px] border border-rail bg-chassis p-3.5 font-mono text-[12px] leading-relaxed text-ink"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`b-${blockIdx++}`} className="border-rail my-4" />)
      i += 1
      continue
    }

    // Heading (#, ##, ###, ####)
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1]!.length
      const text = headingMatch[2]!.trim()
      const k = `b-${blockIdx++}`
      if (level === 1) {
        blocks.push(
          <h1
            key={k}
            className="text-[19px] font-bold tracking-[-0.02em] text-ink pt-1"
          >
            {renderInline(text, k)}
          </h1>,
        )
      } else if (level === 2) {
        blocks.push(
          <h2
            key={k}
            className="text-[16px] font-semibold tracking-[-0.015em] text-ink pt-2 border-b border-rail/70 pb-1"
          >
            {renderInline(text, k)}
          </h2>,
        )
      } else if (level === 3) {
        blocks.push(
          <h3
            key={k}
            className="font-mono text-[11.5px] font-semibold uppercase tracking-wider text-muted pt-3 first:pt-0"
          >
            {renderInline(text, k)}
          </h3>,
        )
      } else {
        blocks.push(
          <h4 key={k} className="text-[13.5px] font-semibold text-ink pt-2">
            {renderInline(text, k)}
          </h4>,
        )
      }
      i += 1
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''))
        i += 1
      }
      const k = `b-${blockIdx++}`
      blocks.push(
        <blockquote
          key={k}
          className="border-l-2 border-signal/60 bg-recessed pl-3.5 pr-3 py-2 text-[13.5px] leading-relaxed text-ink/90 italic rounded-r-[3px]"
        >
          {renderInline(quoteLines.join(' '), k)}
        </blockquote>,
      )
      continue
    }

    // Unordered or task list
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: Array<{ checked: boolean | null; text: string }> = []
      while (i < lines.length && /^[-*•]\s+/.test(lines[i]!.trim())) {
        const rawItem = lines[i]!.trim().replace(/^[-*•]\s+/, '')
        const taskMatch = rawItem.match(/^\[([ xX])\]\s+(.+)$/)
        if (taskMatch) {
          items.push({
            checked: taskMatch[1]!.toLowerCase() === 'x',
            text: taskMatch[2]!,
          })
        } else {
          items.push({ checked: null, text: rawItem })
        }
        i += 1
      }
      const k = `b-${blockIdx++}`
      blocks.push(
        <ul key={k} className="space-y-2 text-[14px] leading-relaxed text-ink">
          {items.map((item, itemIdx) => (
            <li key={`${k}-${itemIdx}`} className="flex items-start gap-2.5">
              {item.checked !== null ? (
                <span
                  aria-hidden="true"
                  className={`mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border font-mono text-[9px] ${
                    item.checked
                      ? 'border-ink bg-ink text-well'
                      : 'border-rail-strong bg-recessed text-transparent'
                  }`}
                >
                  ✓
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-signal/80"
                />
              )}
              <span className={item.checked ? 'line-through text-muted' : ''}>
                {renderInline(item.text, `${k}-${itemIdx}`)}
              </span>
            </li>
          ))}
        </ul>,
      )
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!.trim())) {
        items.push(lines[i]!.trim().replace(/^\d+\.\s+/, ''))
        i += 1
      }
      const k = `b-${blockIdx++}`
      blocks.push(
        <ol
          key={k}
          className="list-decimal pl-5 space-y-1.5 text-[14px] leading-relaxed text-ink"
        >
          {items.map((item, itemIdx) => (
            <li key={`${k}-${itemIdx}`}>
              {renderInline(item, `${k}-${itemIdx}`)}
            </li>
          ))}
        </ol>,
      )
      continue
    }

    // Regular paragraph (consume consecutive plain lines)
    const paraLines: string[] = []
    while (i < lines.length) {
      const cur = lines[i]!.trim()
      if (
        !cur ||
        cur.startsWith('```') ||
        /^#{1,4}\s+/.test(cur) ||
        cur.startsWith('>') ||
        /^[-*•]\s+/.test(cur) ||
        /^\d+\.\s+/.test(cur) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(cur)
      ) {
        break
      }
      paraLines.push(cur)
      i += 1
    }
    const k = `b-${blockIdx++}`
    blocks.push(
      <p key={k} className="text-[14px] leading-relaxed text-ink">
        {renderInline(paraLines.join(' '), k)}
      </p>,
    )
  }

  return <div className={`space-y-3 ${className}`}>{blocks}</div>
}
