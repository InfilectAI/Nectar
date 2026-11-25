#!/usr/bin/env node
/**
 * Standalone stdio MCP server for Nectar + Synapse (`nectar-mcp`).
 * Can be registered directly in Claude Code, Claude Desktop, Cursor, Codex, Copilot, or VS Code.
 *
 * When Nectar.app is running locally, forwards JSON-RPC requests to its live HTTP MCP
 * server (using the user's configured LLM/embedding stack). When Nectar.app is closed,
 * falls back seamlessly to reading `nectar.db` and `synapse.db` directly.
 */
import * as http from 'node:http'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Synapse } from '@infilectai/synapse'
import { handleMcpJsonRpc } from '../dist-electron/mcp-server.js'
import { NectarStore, getNectarDataDir } from '../dist-electron/store.js'

const dataDir = getNectarDataDir()
const store = new NectarStore(path.join(dataDir, 'nectar.db'))
let synapsePromise = null

function getLocalSynapse() {
  if (!synapsePromise) {
    const settings = store.getSettings()
    synapsePromise = Synapse.open(path.join(dataDir, 'synapse.db'), {
      defaultGroupId: settings.groupId,
      inferenceMode: 'fake',
      consolidationMode: 'deterministic',
    })
  }
  return synapsePromise
}

function getHttpEndpoint() {
  if (process.env.NECTAR_MCP_URL) return process.env.NECTAR_MCP_URL
  const settings = store.getSettings()
  const port = Number(settings.mcpPort) || 4577
  return `http://127.0.0.1:${port}/mcp`
}

function forwardToLiveHttp(rawLine) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(getHttpEndpoint())
    } catch {
      resolve({ ok: false })
      return
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawLine),
        },
        timeout: 30_000,
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 202) {
            resolve({ ok: true, response: null })
          } else if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, response: body.trim() || null })
          } else {
            resolve({ ok: false })
          }
        })
      },
    )
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false })
    })
    req.write(rawLine)
    req.end()
  })
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

// Serialize incoming stdio lines so responses preserve request ordering
let chain = Promise.resolve()

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  chain = chain.then(async () => {
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: String(err) },
        }) + '\n',
      )
      return
    }

    const proxied = await forwardToLiveHttp(trimmed)
    if (proxied.ok) {
      if (proxied.response !== null) {
        process.stdout.write(proxied.response + '\n')
      }
      return
    }

    try {
      const synapse = await getLocalSynapse()
      const res = await handleMcpJsonRpc(parsed, store, () => synapse)
      if (res !== null) {
        process.stdout.write(JSON.stringify(res) + '\n')
      }
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed?.id ?? null,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        }) + '\n',
      )
    }
  })
})

