#!/usr/bin/env node
/**
 * Standalone stdio MCP server for Nectar + Synapse (`nectar-mcp`).
 * Can be registered directly in Claude Desktop, Cursor, or VS Code `.vscode/mcp.json`.
 */
import * as path from 'node:path'
import * as readline from 'node:readline'
import { Synapse } from '@infilectai/synapse'
import { handleMcpJsonRpc } from '../dist-electron/mcp-server.js'
import { NectarStore, getNectarDataDir } from '../dist-electron/store.js'

const dataDir = getNectarDataDir()
const store = new NectarStore(path.join(dataDir, 'nectar.db'))
const settings = store.getSettings()

const synapse = await Synapse.open(path.join(dataDir, 'synapse.db'), {
  defaultGroupId: settings.groupId,
  inferenceMode: 'fake',
  consolidationMode: 'deterministic',
})

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const req = JSON.parse(trimmed)
    const res = await handleMcpJsonRpc(req, store, () => synapse)
    if (res !== null) {
      process.stdout.write(JSON.stringify(res) + '\n')
    }
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: String(err) },
      }) + '\n',
    )
  }
})
