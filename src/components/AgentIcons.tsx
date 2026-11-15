export type McpAgentId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'vscode'
  | 'other'

export function AgentIcon({
  agent,
  className = 'h-4 w-4',
}: {
  agent: McpAgentId
  className?: string
}) {
  if (agent === 'claude') {
    // Anthropic Claude 12-ray starburst
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2.5V21.5M2.5 12H21.5M5.28 5.28L18.72 18.72M18.72 5.28L5.28 18.72M7.5 3.3L16.5 20.7M3.3 7.5L20.7 16.5M20.7 7.5L3.3 16.5M16.5 3.3L7.5 20.7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  if (agent === 'codex') {
    // OpenAI / Codex hexagonal knot
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none">
        <path
          d="M21.2 10.1a5.2 5.2 0 0 0-.45-4.3 5.3 5.3 0 0 0-5.7-2.55A5.25 5.25 0 0 0 11.1 1.5a5.3 5.3 0 0 0-5.05 3.65A5.25 5.25 0 0 0 2.55 7.7a5.3 5.3 0 0 0 .65 6.2 5.2 5.2 0 0 0 .45 4.3 5.3 5.3 0 0 0 5.7 2.55 5.25 5.25 0 0 0 3.95 1.75 5.3 5.3 0 0 0 5.05-3.65 5.25 5.25 0 0 0 3.5-2.55 5.3 5.3 0 0 0-.65-6.2Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <polygon
          points="12,8.2 15.3,10.1 15.3,13.9 12,15.8 8.7,13.9 8.7,10.1"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    )
  }

  if (agent === 'cursor') {
    // Cursor 3D isometric cube
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2.5L20.5 7.4V16.6L12 21.5L3.5 16.6V7.4L12 2.5Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M12 12L20.5 7.4M12 12L3.5 7.4M12 12V21.5"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  if (agent === 'copilot') {
    // GitHub Copilot visor/goggles mark
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none">
        <path
          d="M4.5 11C4.5 7.2 7.5 4.5 12 4.5C16.5 4.5 19.5 7.2 19.5 11V15.5C19.5 17.7 17.7 19.5 15.5 19.5H8.5C6.3 19.5 4.5 17.7 4.5 15.5V11Z"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        <rect
          x="6.5"
          y="9.2"
          width="11"
          height="4.8"
          rx="2.2"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <circle cx="9.8" cy="11.6" r="1" fill="currentColor" />
        <circle cx="14.2" cy="11.6" r="1" fill="currentColor" />
      </svg>
    )
  }

  if (agent === 'vscode') {
    // VS Code ribbon
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none">
        <path
          d="M17.2 3L7.2 12L17.2 21L21 19V5L17.2 3Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M17.2 6.5L4.5 16.5L3 15L10.5 9L3 6L4.5 4.5L17.2 14.5"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" />
    </svg>
  )
}
