import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { WebSocketServer } from 'ws'

import {
  validateCloudSettings,
} from '../dist-electron/cloud-validator.js'
import {
  resolveEmbeddingEndpoint,
  resolveLlmEndpoint,
} from '../dist-electron/distiller.js'
import {
  cancelCortexModelDownload,
  fallbackLocalModels,
  fetchCortexModels,
  startCortexModelDownload,
} from '../dist-electron/local-models.js'
import {
  NectarStore,
  anyServiceUsesLocal,
  normalizeSettings,
} from '../dist-electron/store.js'
import {
  StreamingSpeakerResolver,
  formatClusterFallback,
} from '../dist-electron/speaker-attribution.js'
import { StreamingWsSession } from '../dist-electron/streaming-ws.js'

const tempDirs = []

function makeTempDir(prefix = 'nectar-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Cortex local-models client', () => {
  it('falls back cleanly to not_downloaded when Cortex is offline or missing /v1/models', () => {
    const offline = fallbackLocalModels('stopped', {})
    assert.equal(offline.length, 4)
    for (const model of offline) {
      assert.equal(model.status, 'not_downloaded')
      assert.equal(model.installedOnDisk, false)
      assert.equal(model.runtimeState, 'unavailable')
    }

    const running = fallbackLocalModels('running', {
      stt: 'loaded',
      diarize: 'loading',
      chat: 'unloaded',
      embed: 'error',
    })
    const byId = Object.fromEntries(running.map((m) => [m.id, m]))
    assert.equal(byId.stt.status, 'ready')
    assert.equal(byId.diarize.status, 'loading')
    assert.equal(byId.chat.status, 'not_downloaded')
    assert.equal(byId.embed.status, 'error')
  })

  it('fetches models and triggers/cancels downloads via Cortex /v1/models API', async () => {
    const requests = []
    const sampleModel = {
      id: 'stt',
      name: 'WhisperKit',
      modelName: 'whisper-large-v3',
      role: 'Live Transcription',
      engine: 'Core ML · Apple Neural Engine',
      required: true,
      kind: 'coreml',
      status: 'not_downloaded',
      runtimeState: 'unloaded',
      installedOnDisk: false,
      canCancel: false,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 950 * 1024 * 1024,
      bytesPerSec: null,
      detail: 'Not downloaded',
      error: null,
      localPath: null,
    }

    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ models: [sampleModel] }))
      } else if (req.method === 'POST' && req.url === '/v1/models/stt/download') {
        res.end(JSON.stringify({ ...sampleModel, status: 'downloading', progress: 0.1 }))
      } else if (req.method === 'DELETE' && req.url === '/v1/models/stt/download') {
        res.end(JSON.stringify({ ...sampleModel, status: 'not_downloaded', progress: 0 }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      const list = await fetchCortexModels(baseUrl)
      assert.equal(list.length, 1)
      assert.equal(list[0].id, 'stt')

      const started = await startCortexModelDownload(baseUrl, 'stt')
      assert.equal(started.status, 'downloading')

      const cancelled = await cancelCortexModelDownload(baseUrl, 'stt')
      assert.equal(cancelled.status, 'not_downloaded')

      assert.deepEqual(requests, [
        'GET /v1/models',
        'POST /v1/models/stt/download',
        'DELETE /v1/models/stt/download',
      ])
    } finally {
      server.close()
    }
  })
})

describe('NectarStore onboarding & per-service mix-and-match settings', () => {
  it('defaults onboardingCompleted to false and persists completion', () => {
    const dir = makeTempDir()
    const store = new NectarStore(path.join(dir, 'nectar.db'))
    try {
      assert.equal(store.getSettings().onboardingCompleted, false)
      store.saveSettings({ onboardingCompleted: true })
      assert.equal(store.getSettings().onboardingCompleted, true)
    } finally {
      store.close()
    }
  })

  it('computes local, hybrid, and cloud modes and bundles diarization with cloud STT', () => {
    const hybrid = normalizeSettings({
      sttMode: 'local',
      diarizeMode: 'local',
      llmMode: 'cloud',
      embeddingMode: 'cloud',
    })
    assert.equal(hybrid.mode, 'hybrid')
    assert.equal(anyServiceUsesLocal(hybrid), true)

    // Diarize marked local, but bundled onto cloud STT -> effectively all cloud
    const allCloudBundled = normalizeSettings({
      sttMode: 'cloud',
      sttIncludesDiarization: true,
      diarizeMode: 'local',
      llmMode: 'cloud',
      embeddingMode: 'cloud',
    })
    assert.equal(allCloudBundled.mode, 'cloud')
    assert.equal(anyServiceUsesLocal(allCloudBundled), false)

    // Legacy cloud config without per-service fields migrates all 4 services to cloud
    const migrated = normalizeSettings({ mode: 'cloud' })
    assert.equal(migrated.sttMode, 'cloud')
    assert.equal(migrated.diarizeMode, 'cloud')
    assert.equal(migrated.llmMode, 'cloud')
    assert.equal(migrated.embeddingMode, 'cloud')
  })

  it('resolves independent cloud LLM (Bearer) and dedicated Embedding (Api-Key) endpoints', () => {
    const settings = normalizeSettings({
      sttMode: 'local',
      diarizeMode: 'local',
      llmMode: 'cloud',
      cloudAiProvider: 'openai-compatible',
      llmBaseUrl: 'https://inference.example.com/v1',
      llmModel: 'zai-org/GLM-5.3-Flash',
      llmAuthScheme: 'Bearer',
      llmApiKey: 'llm-secret',
      embeddingMode: 'cloud',
      embeddingBaseUrl: 'https://embed.example.com/sync/v1',
      embeddingModel: 'default',
      embeddingAuthScheme: 'Api-Key',
      embeddingApiKey: 'embed-secret',
    })

    const llm = resolveLlmEndpoint(settings, 'http://127.0.0.1:8000')
    assert.equal(llm.mode, 'cloud')
    assert.equal(llm.baseUrl, 'https://inference.example.com/v1')
    assert.equal(llm.authScheme, 'Bearer')
    assert.equal(llm.apiKey, 'llm-secret')

    const emb = resolveEmbeddingEndpoint(settings, 'http://127.0.0.1:8000')
    assert.equal(emb.mode, 'cloud')
    assert.equal(emb.baseUrl, 'https://embed.example.com/sync/v1')
    assert.equal(emb.authScheme, 'Api-Key')
    assert.equal(emb.apiKey, 'embed-secret')
  })
})

describe('StreamingWsSession', () => {
  it('sends configured Auth header, handshake, 100ms PCM frames, and emits diarized turns', async () => {
    let receivedAuth = null
    let receivedHandshake = null
    let appendCount = 0
    let commitReceived = false

    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => wss.once('listening', resolve))
    const addr = wss.address()

    wss.on('connection', (ws, req) => {
      receivedAuth = req.headers.authorization
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (!receivedHandshake && msg.session_id) {
          receivedHandshake = msg
          return
        }
        if (msg.type === 'input_audio_buffer.append') {
          appendCount += 1
          if (appendCount === 1) {
            ws.send(
              JSON.stringify({
                type: 'transcription',
                is_final: false,
                num_speakers: 1,
                segments: [],
                partial: [{ speaker: 'speaker_0', text: 'Hello there', start: 0, end: 0.5 }],
              }),
            )
          }
        } else if (msg.type === 'input_audio_buffer.commit') {
          commitReceived = true
          ws.send(
            JSON.stringify({
              type: 'transcription',
              is_final: true,
              num_speakers: 2,
              segments: [
                { speaker: 'speaker_0', start: 0, end: 1.2, text: 'Hello there' },
                { speaker: 'speaker_1', start: 1.5, end: 2.8, text: 'Hi back' },
              ],
              partial: [],
              stats: { commit_lat_s: { p50: 0.95 } },
            }),
          )
        }
      })
    })

    const segments = []
    const partials = []
    let lastStatus = null
    const session = new StreamingWsSession(
      {
        url: `ws://127.0.0.1:${addr.port}`,
        apiKey: 'test-token-123',
        authScheme: 'Api-Key',
        language: 'en',
        mode: 'meeting',
        maxSpeakers: 4,
      },
      {
        onStatus: (s) => {
          lastStatus = s
        },
        onSegment: (seg) => segments.push(seg),
        onPartial: (p) => {
          if (p) partials.push(p)
        },
      },
    )

    try {
      session.start()
      // Feed 6400 bytes (2 x 100ms PCM16 frames)
      session.feedPcm(Buffer.alloc(6400, 1))
      await new Promise((r) => setTimeout(r, 150))
      await session.finish(2000)

      assert.equal(receivedAuth, 'Api-Key test-token-123')
      assert.equal(receivedHandshake.language, 'en')
      assert.equal(receivedHandshake.mode, 'meeting')
      assert.equal(receivedHandshake.max_speakers, 4)
      assert.equal(appendCount, 2)
      assert.equal(commitReceived, true)
      assert.equal(partials.length, 1)
      assert.equal(partials[0].speaker, 'speaker_0')
      assert.equal(segments.length, 2)
      assert.equal(segments[0].speaker, 'speaker_0')
      assert.equal(segments[1].speaker, 'speaker_1')
      assert.equal(lastStatus.status, 'idle')
    } finally {
      wss.close()
    }
  })

  it('pads silent gaps with 100ms zero PCM16 frames and pauses padding when paused', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => wss.once('listening', resolve))
    const addr = wss.address()
    const appendedFrames = []

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'input_audio_buffer.append') {
          appendedFrames.push(Buffer.from(msg.audio, 'base64'))
        } else if (msg.type === 'input_audio_buffer.commit') {
          ws.send(JSON.stringify({ type: 'transcription', is_final: true, segments: [] }))
        }
      })
    })

    const session = new StreamingWsSession(
      { url: `ws://127.0.0.1:${addr.port}`, authScheme: 'none' },
      {},
    )
    try {
      session.start()
      // Wait ~420ms without feeding any audio -> should emit >=2 zero-filled 3200-byte frames
      await new Promise((r) => setTimeout(r, 420))
      const countBeforePause = appendedFrames.length
      assert.ok(countBeforePause >= 2, `Expected >=2 silence frames, got ${countBeforePause}`)
      assert.equal(appendedFrames[0].length, 3200)
      assert.equal(appendedFrames[0].every((b) => b === 0), true)

      session.setPaused(true)
      await new Promise((r) => setTimeout(r, 320))
      assert.equal(appendedFrames.length, countBeforePause, 'Expected no frames while paused')

      await session.finish(1000)
    } finally {
      wss.close()
    }
  })
})

describe('StreamingSpeakerResolver & retroactive relabeling', () => {
  it('maps diarizer cluster IDs to visual speaker names and local mic user', () => {
    const resolver = new StreamingSpeakerResolver()
    resolver.recordRoster([
      { id: 'Sean Bangalore', name: 'Sean Bangalore' },
      { id: 'Jimmy Whitaker', name: 'Jimmy Whitaker' },
      { id: 'Abhi Jain', name: 'Abhi Jain' },
    ], 'Abhi Jain')

    // Turn 1 arrives before any visual speaker_change -> friendly fallback, keeps clusterId
    const initial = resolver.resolve('speaker_0', 0.0, 2.0, 2.5, true)
    assert.equal(initial.speaker, 'Speaker 1')
    assert.equal(initial.participantId, 'speaker_0')
    assert.equal(formatClusterFallback('speaker_1'), 'Speaker 2')

    // Visual scraper identifies Sean Bangalore speaking at t=2.5s
    resolver.recordSpeakerChange('Sean Bangalore', 'Sean Bangalore', 2.5, 'native_ax')
    // A brief local mic blip must not close Sean Bangalore's ongoing visual span
    resolver.recordSpeakerChange('local', 'You', 4.0, 'mic')
    const matched = resolver.resolve('speaker_0', 3.0, 7.0, 7.5, true)
    assert.equal(matched.speaker, 'Sean Bangalore')
    assert.deepEqual(matched.relabelCluster, {
      clusterId: 'speaker_0',
      speaker: 'Sean Bangalore',
      participantId: 'speaker_0',
    })

    // Local mic dominates for speaker_1 -> mapped to Abhi Jain
    for (let t = 8.0; t <= 10.0; t += 0.2) {
      resolver.recordAudio(t, 0.002, 0.06, true)
    }
    const localTurn = resolver.resolve('speaker_1', 8.0, 10.0, 10.5, true)
    assert.equal(localTurn.speaker, 'Abhi Jain')

    // Manual 1-click cluster lock overrides future visual speaker changes
    resolver.lockCluster('speaker_2', 'Ben Levitt')
    resolver.recordSpeakerChange('Jimmy Whitaker', 'Jimmy Whitaker', 12.0, 'native_ax')
    const locked = resolver.resolve('speaker_2', 12.2, 15.0, 15.5, true)
    assert.equal(locked.speaker, 'Ben Levitt')
  })

  it('relabels earlier generic turns and participants in SQLite once cluster name resolves', () => {
    const dir = makeTempDir()
    const store = new NectarStore(path.join(dir, 'nectar.db'))
    try {
      const m = store.createMeeting({
        title: 'FDE Weekly Sync',
        platform: 'zoom',
        url: 'zoom://meeting/1',
      })
      store.addTranscriptTurn({
        meetingId: m.id,
        speaker: 'Speaker 1',
        participantId: 'speaker_0',
        text: 'First sentence before AX scrape',
        t0: 0,
        t1: 3,
      })
      const changed = store.relabelSpeakerTurns(m.id, 'speaker_0', 'Sean Bangalore')
      assert.equal(changed, true)

      const updated = store.getMeeting(m.id)
      assert.equal(updated.turns[0].speaker, 'Sean Bangalore')
      assert.deepEqual(updated.participants, ['Sean Bangalore'])
    } finally {
      store.close()
    }
  })
})

describe('Cloud API smoke-test validator & legacy preset cleanup', () => {
  it('strips legacy local Cortex URLs and models while preserving custom endpoints', () => {
    const cleaned = normalizeSettings({
      sttUrl: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      sttModel: 'whisper-large-v3',
      diarizeUrl: 'http://127.0.0.1:8000/v1/audio/diarize',
      llmBaseUrl: 'http://127.0.0.1:8000/v1',
      llmModel: 'gemma-4-E2B-it',
      embeddingBaseUrl: 'http://127.0.0.1:8000/v1',
      embeddingModel: 'embeddinggemma-300M',
    })
    assert.equal(cleaned.sttUrl, '')
    assert.equal(cleaned.sttModel, '')
    assert.equal(cleaned.diarizeUrl, '')
    assert.equal(cleaned.llmBaseUrl, '')
    assert.equal(cleaned.llmModel, '')
    assert.equal(cleaned.embeddingBaseUrl, '')
    assert.equal(cleaned.embeddingModel, '')

    const custom = normalizeSettings({
      llmBaseUrl: 'http://localhost:11434/v1',
      llmModel: 'llama3.2',
    })
    assert.equal(custom.llmBaseUrl, 'http://localhost:11434/v1')
    assert.equal(custom.llmModel, 'llama3.2')
  })

  it('validates cloud LLM & embedding endpoints and catches bad auth before save', async () => {
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization
      if (auth !== 'Bearer good-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url === '/v1/chat/completions') {
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }))
      } else if (req.url === '/v1/embeddings') {
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}/v1`

    try {
      const okRes = await validateCloudSettings(
        normalizeSettings({
          sttMode: 'local',
          diarizeMode: 'local',
          llmMode: 'cloud',
          embeddingMode: 'cloud',
          cloudAiProvider: 'openai-compatible',
          llmBaseUrl: base,
          llmModel: 'test-chat',
          llmApiKey: 'good-key',
          llmAuthScheme: 'Bearer',
          embeddingBaseUrl: base,
          embeddingModel: 'test-embed',
          embeddingApiKey: 'good-key',
          embeddingAuthScheme: 'Bearer',
        }),
      )
      assert.equal(okRes.ok, true)
      const byService = Object.fromEntries(okRes.results.map((r) => [r.service, r]))
      assert.equal(byService.stt.skipped, true)
      assert.equal(byService.llm.ok, true)
      assert.equal(byService.embedding.ok, true)
      assert.match(byService.embedding.message, /3d/)

      const badRes = await validateCloudSettings(
        normalizeSettings({
          sttMode: 'local',
          diarizeMode: 'local',
          llmMode: 'cloud',
          embeddingMode: 'local',
          cloudAiProvider: 'openai-compatible',
          llmBaseUrl: base,
          llmModel: 'test-chat',
          llmApiKey: 'wrong-key',
          llmAuthScheme: 'Bearer',
        }),
      )
      assert.equal(badRes.ok, false)
      const llmErr = badRes.results.find((r) => r.service === 'llm')
      assert.equal(llmErr.ok, false)
      assert.match(llmErr.message, /401.*Invalid API key/)
    } finally {
      server.close()
    }
  })
})

describe('Standalone stdio MCP bridge (bin/nectar-mcp.js)', () => {
  it('unpacks all runtime modules required by bin/nectar-mcp.js in package.json asarUnpack', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve('package.json'), 'utf8'),
    )
    const unpack = pkg.build?.asarUnpack ?? []
    for (const required of [
      'bin/**',
      'package.json',
      'dist-electron/mcp-server.js',
      'dist-electron/store.js',
      'node_modules/@infilectai/synapse/**',
    ]) {
      assert.ok(
        unpack.includes(required),
        `Expected build.asarUnpack to include "${required}"`,
      )
    }
  })

  it('handles initialize and tools/list offline when Nectar HTTP MCP is unreachable', async () => {
    const dir = makeTempDir()
    const child = spawn(process.execPath, [path.resolve('bin/nectar-mcp.js')], {
      env: {
        ...process.env,
        NECTAR_DATA_DIR: dir,
        NECTAR_MCP_URL: 'http://127.0.0.1:1/mcp',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const lines = []
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) lines.push(JSON.parse(line))
      }
    })

    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    )
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    )
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
    )
    child.stdin.end()

    const exitCode = await new Promise((resolve) => child.once('close', resolve))
    assert.equal(exitCode, 0, `Expected clean exit, got ${exitCode}. stderr: ${stderr}`)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].id, 1)
    assert.equal(lines[0].result.serverInfo.name, 'nectar-mcp')
    assert.equal(lines[1].id, 2)
    const toolNames = lines[1].result.tools.map((t) => t.name)
    assert.deepEqual(toolNames, ['list_meetings', 'get_meeting', 'find_memory'])
  })

  it('proxies stdio requests to a live Nectar HTTP MCP server when running', async () => {
    const dir = makeTempDir()
    let proxiedCalls = 0
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        proxiedCalls += 1
        const parsed = JSON.parse(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { serverInfo: { name: 'live-nectar-http' } },
          }),
        )
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()

    try {
      const child = spawn(process.execPath, [path.resolve('bin/nectar-mcp.js')], {
        env: {
          ...process.env,
          NECTAR_DATA_DIR: dir,
          NECTAR_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} }) + '\n',
      )
      child.stdin.end()

      const exitCode = await new Promise((resolve) => child.once('close', resolve))
      assert.equal(exitCode, 0)
      assert.equal(proxiedCalls, 1)
      const parsed = JSON.parse(out.trim())
      assert.equal(parsed.result.serverInfo.name, 'live-nectar-http')
    } finally {
      server.close()
    }
  })
})

describe('Transcript consecutive turn grouping & summary/action item helpers', () => {
  it('merges consecutive turns from the same speaker and keeps distinct speakers separate', async () => {
    const { groupConsecutiveTurns, groupActionItemsByOwner, stripMarkdownActionItemsSection } =
      await import('../src/utils/format.ts')
    const blocks = groupConsecutiveTurns([
      { id: 't1', speaker: 'prudhvi', participantId: 'speaker_0', text: 'Yeah. Yeah.', t0: 26, t1: 27 },
      { id: 't2', speaker: 'Abhi Jain', participantId: 'speaker_1', text: 'Awesome. Cool.', t0: 27, t1: 38 },
      { id: 't3', speaker: 'Abhi Jain', participantId: 'speaker_1', text: "and then we'll try to build something.", t0: 38, t1: 47 },
      { id: 't4', speaker: 'prudhvi', participantId: 'speaker_0', text: 'Sounds good.', t0: 48, t1: 49 },
    ])
    assert.equal(blocks.length, 3)
    assert.equal(blocks[0].speaker, 'prudhvi')
    assert.equal(blocks[1].speaker, 'Abhi Jain')
    assert.equal(blocks[1].t0, 27)
    assert.equal(blocks[1].t1, 47)
    assert.equal(blocks[1].text, "Awesome. Cool. and then we'll try to build something.")
    assert.deepEqual(blocks[1].turnIds, ['t2', 't3'])
    assert.equal(blocks[2].speaker, 'prudhvi')

    const groupedActions = groupActionItemsByOwner([
      { owner: '@Vargas Fuertes', task: 'Share agent mailbox RFC', status: 'open' },
      { owner: 'Ben Levitt', task: 'Confirm staging deployment', status: 'open' },
      { owner: 'vargas fuertes', task: 'Share agent mailbox RFC', status: 'open' },
      { owner: 'Vargas Fuertes', task: 'Align with tuning team on ownership', status: 'open' },
    ])
    assert.equal(groupedActions.length, 2)
    assert.equal(groupedActions[0].owner, 'Vargas Fuertes')
    assert.equal(groupedActions[0].items.length, 2)
    assert.equal(groupedActions[1].owner, 'Ben Levitt')

    const stripped = stripMarkdownActionItemsSection(
      '### Executive Summary\nGood sync.\n\n### Action Items\n- [ ] Dup item\n\n### Key Decisions\n- Ship v1',
    )
    assert.ok(!stripped.includes('Action Items'))
    assert.ok(stripped.includes('Executive Summary'))
    assert.ok(stripped.includes('Key Decisions'))
  })

  it('deterministic distiller ignores rhetorical questions and never duplicates action items in markdown', async () => {
    const { deterministicDistill } = await import('../dist-electron/distiller.js')
    const result = deterministicDistill({
      id: 'm1',
      title: 'Persistent Agents Review',
      platform: 'zoom',
      url: 'zoom://meeting/1',
      startedAt: '2026-11-24T12:00:00.000Z',
      endedAt: null,
      status: 'completed',
      participants: ['Vargas Fuertes', 'Ben Levitt'],
      roughNotes: '',
      distilledNotes: '',
      actionItems: [],
      decisions: [],
      episodeId: null,
      turns: [
        {
          id: '1',
          meetingId: 'm1',
          speaker: 'Vargas Fuertes',
          participantId: 'speaker_0',
          text: 'How will this get exposed to an agent?',
          t0: 10,
          t1: 15,
          createdAt: '2026-11-24T12:00:10.000Z',
        },
        {
          id: '2',
          meetingId: 'm1',
          speaker: 'Ben Levitt',
          participantId: 'speaker_1',
          text: "I'll set up the account universe routine in staging.",
          t0: 20,
          t1: 25,
          createdAt: '2026-11-24T12:00:20.000Z',
        },
      ],
    })
    assert.equal(result.actionItems.length, 1)
    assert.equal(result.actionItems[0].owner, 'Ben Levitt')
    assert.ok(!result.distilledNotes.includes('### Action Items'))
  })
})


