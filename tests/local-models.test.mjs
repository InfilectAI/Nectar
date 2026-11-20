import assert from 'node:assert/strict'
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

