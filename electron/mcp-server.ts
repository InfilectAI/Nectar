import * as http from 'node:http'
import type { Synapse } from '@infilectai/synapse'
import type { NectarStore } from './store.js'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'list_meetings',
    description:
      'List recorded meetings in Nectar with their IDs, titles, dates, participants, and action item counts.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of meetings to return (default 20).',
        },
      },
    },
  },
  {
    name: 'get_meeting',
    description:
      'Get the rough notes, enhanced summary, action items, decisions, and speaker-attributed transcript for a specific meeting.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: {
          type: 'string',
          description: 'ID of the meeting from list_meetings.',
        },
      },
      required: ['meetingId'],
    },
  },
  {
    name: 'find_memory',
    description:
      'Search across all meetings and temporal memory for answers, ownership, decisions, blockers, or historical changes, with exact speaker citations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language question (e.g. "Who owns checkout-service?" or "What runbook is Alex updating?").',
        },
        includeHistory: {
          type: 'boolean',
          description:
            'Include superseded/retired historical facts alongside current facts (default true).',
        },
      },
      required: ['query'],
    },
  },
]

export async function handleMcpJsonRpc(
  reqBody: Record<string, unknown>,
  store: NectarStore,
  getSynapse: () => Synapse,
): Promise<Record<string, unknown> | null> {
  const id = reqBody.id ?? null
  const method = String(reqBody.method ?? '')
  const params = (reqBody.params ?? {}) as Record<string, unknown>

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: {
          name: 'nectar-mcp',
          version: '0.1.0',
        },
        capabilities: {
          tools: {},
        },
      },
    }
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} }
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS,
      },
    }
  }

  if (method === 'tools/call') {
    const toolName = String(params.name ?? '')
    const args = (params.arguments ?? {}) as Record<string, unknown>
    const settings = store.getSettings()
    const groupId = settings.groupId || 'workspace'
    const synapse = getSynapse()

    try {
      let payload: unknown
      if (toolName === 'list_meetings') {
        const limit = typeof args.limit === 'number' ? args.limit : 20
        payload = store
          .listMeetings()
          .slice(0, limit)
          .map((m) => ({
            id: m.id,
            title: m.title,
            platform: m.platform,
            startedAt: m.startedAt,
            endedAt: m.endedAt,
            status: m.status,
            participants: m.participants,
            turnCount: m.turns.length,
            actionItemCount: m.actionItems.length,
            decisionCount: m.decisions.length,
          }))
      } else if (toolName === 'get_meeting') {
        const meeting = store.getMeeting(String(args.meetingId ?? ''))
        if (!meeting) {
          throw new Error(`Meeting not found: ${String(args.meetingId)}`)
        }
        payload = meeting
      } else if (toolName === 'find_memory') {
        const query = String(args.query ?? '')
        const includeHistory = args.includeHistory !== false
        const [recallResult, relationships] = await Promise.all([
          synapse.recall(query, groupId),
          synapse.relationships(groupId, { includeSuperseded: includeHistory }),
        ])
        const qLower = query.toLowerCase()
        const relatedFacts = relationships
          .filter(
            (r) =>
              qLower.includes(r.subject.canonicalName.toLowerCase()) ||
              qLower.includes(r.object.canonicalName.toLowerCase()) ||
              qLower.includes(r.predicate.toLowerCase()),
          )
          .map((r) => ({
            fact: `${r.subject.canonicalName} ${r.predicate} ${r.object.canonicalName}`,
            active: r.invalidAt === null,
            validAt: r.validAt,
            invalidAt: r.invalidAt,
            evidence: r.evidence.map((e) => e.excerpt),
          }))

        payload = {
          query: recallResult.query,
          answer: recallResult.answer,
          answerOrigin: recallResult.answerOrigin,
          citations: recallResult.citations,
          facts: relatedFacts,
          latencyMs: recallResult.latencyMs,
        }
      } else {
        throw new Error(`Unknown MCP tool: ${toolName}`)
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: msg }],
        },
      }
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  }
}

export class McpHttpServer {
  private server: http.Server | null = null
  private boundPort: number = 0
  private requestCount: number = 0

  constructor(
    private readonly store: NectarStore,
    private readonly getSynapse: () => Synapse,
  ) {}

  get port(): number {
    return this.boundPort
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/mcp`
  }

  get requestsHandled(): number {
    return this.requestCount
  }

  async start(preferredPort: number = 4577): Promise<number> {
    if (this.server) return this.boundPort

    this.server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === 'GET' && (req.url === '/health' || req.url === '/mcp')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            status: 'ok',
            server: 'nectar-mcp',
            version: '0.1.0',
            endpoint: this.url,
            tools: MCP_TOOLS.map((t) => t.name),
            requestsHandled: this.requestCount,
          }),
        )
        return
      }

      if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/')) {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', async () => {
          try {
            this.requestCount += 1
            const parsed = JSON.parse(body) as Record<string, unknown>
            const reply = await handleMcpJsonRpc(parsed, this.store, this.getSynapse)
            if (reply === null) {
              res.writeHead(202)
              res.end()
              return
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(reply))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: String(err) },
              }),
            )
          }
        })
        return
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    })

    return new Promise<number>((resolve) => {
      this.server!.once('error', () => {
        this.server!.listen(0, '127.0.0.1', () => {
          const addr = this.server!.address()
          this.boundPort = typeof addr === 'object' && addr ? addr.port : preferredPort
          resolve(this.boundPort)
        })
      })
      this.server!.listen(preferredPort, '127.0.0.1', () => {
        const addr = this.server!.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : preferredPort
        resolve(this.boundPort)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }
}
