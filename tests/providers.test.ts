import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockServer } from '../scripts/mock-ai-server.mjs'
import { Queue } from '../src/main/queue'
import { makeHandlers } from '../src/main/jobs'
import { importPaths } from '../src/main/importer'
import { testModel } from '../src/main/ai/test'
import { claudeSupportsFallback } from '../src/main/ai/provider'
import { DEFAULT_BASE_URLS, MODEL_PRESETS, baseUrlFor, mergeSettings } from '../src/shared/defaults'
import type { Doc, Job, ModelCaps, Provider, Topic } from '../src/shared/types'
import { setup, writeLesson } from './helpers'

type Mock = Awaited<ReturnType<typeof startMockServer>>
let mock: Mock

beforeAll(async () => { mock = await startMockServer() })
afterAll(async () => { await mock.close() })

function reset(): void {
  mock.state.script = []
  mock.state.requests = []
  mock.state.rejectJsonMode = false
  mock.state.rejectThinking = false
  mock.state.rejectGenerateContent = false
  mock.state.rejectFallbacks = false
}

function env(provider: Provider) {
  const e = setup({ provider, model: MODEL_PRESETS[provider][0] })
  e.settings.ai.baseUrls = { gemini: mock.url, anthropic: mock.url, openai: mock.url }
  return e
}

function makeQueue(e: ReturnType<typeof env>, key: string | null = 'test-key'): Queue {
  return new Queue({ store: e.store, settings: () => e.settings, getKey: () => key, handlers: makeHandlers(e.repo), random: () => 0 })
}

async function organizeOne(e: ReturnType<typeof env>): Promise<Doc> {
  const f = writeLesson(e.dir, 'Biology', 'Lesson 1.md', 1)
  const res = await importPaths(e.repo, [f])
  const doc = e.store.get<Doc>('docs', res.docIds[0])!
  e.repo.enqueueOrganize(doc.id)
  const q = makeQueue(e)
  q.start()
  await q.idle()
  return e.store.get<Doc>('docs', doc.id)!
}

describe('settings for multiple providers', () => {
  it('defaults to Gemini and carries an old single Gemini base URL over', () => {
    const fresh = mergeSettings(undefined)
    expect(fresh.ai.provider).toBe('gemini')
    expect(fresh.ai.baseUrls).toEqual(DEFAULT_BASE_URLS)
    const old = mergeSettings({ ai: { model: 'gemini-3.8-flash', baseUrl: 'http://proxy.local' } })
    expect(old.ai.baseUrls.gemini).toBe('http://proxy.local')
    expect(old.ai.baseUrls.anthropic).toBe(DEFAULT_BASE_URLS.anthropic)
    expect('baseUrl' in old.ai).toBe(false)
  })

  it('drops the old client-side rate limit settings', () => {
    const s = mergeSettings({ ai: { rpm: 15, tpm: 1000, rpd: 50, utilization: 0.5, countInputOnly: true, model: 'gemma-4-31b-it' } })
    for (const k of ['rpm', 'tpm', 'rpd', 'utilization', 'countInputOnly']) expect(k in s.ai).toBe(false)
    expect(s.ai.model).toBe('gemma-4-31b-it')
  })

  it('falls back to the official endpoint when a base URL is blank', () => {
    const s = mergeSettings({ ai: { provider: 'openai', baseUrls: { openai: '  ' } } })
    expect(baseUrlFor(s.ai)).toBe(DEFAULT_BASE_URLS.openai)
    expect(baseUrlFor(s.ai, 'anthropic')).toBe(DEFAULT_BASE_URLS.anthropic)
  })

  it('has a model list per provider', () => {
    expect(MODEL_PRESETS.anthropic[0]).toBe('claude-opus-5-5')
    expect(MODEL_PRESETS.openai.every((m) => m.startsWith('gpt-'))).toBe(true)
    expect(claudeSupportsFallback('claude-opus-5-5')).toBe(true)
    expect(claudeSupportsFallback('claude-haiku-5-5')).toBe(false)
  })
})

describe('Anthropic Claude through the Messages API', () => {
  it('organizes a lesson with the SDK: system prompt, low effort and refusal fallback sent', async () => {
    reset()
    const e = env('anthropic')
    const doc = await organizeOne(e)
    expect(doc.status).toBe('organized')
    expect(e.store.byParent<Topic>('topics', doc.id).every((t) => t.name.startsWith('Concept of'))).toBe(true)
    const r = mock.state.requests[0]
    expect(r.url).toMatch(/\/v1\/messages/)
    expect(r.key).toBe('test-key')
    expect(r.body.model).toBe('claude-opus-5-5')
    expect(r.body.system).toMatch(/organize study material/)
    expect(r.body.output_config).toEqual({ effort: 'low' })
    expect(r.body.fallbacks).toBe('default')
    expect(r.body.max_tokens).toBeGreaterThan(e.settings.ai.maxOutputTokens)
    const caps = e.store.kvGet<Record<string, ModelCaps>>('modelCaps')!['claude-opus-5-5']
    expect(caps).toMatchObject({ api: 'messages', system: true, json: false, thinkMinimal: true, fallback: true })
  })

  it('drops effort and the fallback on HTTP 400 and remembers it', async () => {
    reset()
    mock.state.rejectThinking = true
    mock.state.rejectFallbacks = true
    const e = env('anthropic')
    expect((await organizeOne(e)).status).toBe('organized')
    const caps = e.store.kvGet<Record<string, ModelCaps>>('modelCaps')!['claude-opus-5-5']
    expect(caps).toMatchObject({ thinkMinimal: false, fallback: false })
  })

  it('pauses on a Claude 429 with the provider message and wait time, then continues', async () => {
    reset()
    mock.state.script = [{ status: 429, retryAfter: 20, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } } }]
    const e = env('anthropic')
    const doc = await organizeOne(e)
    expect(doc.status).toBe('queued')
    const q = makeQueue(e)
    const rl = q.status().rateLimit!
    expect(rl).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(rl.message).toMatch(/per-minute rate limit/)
    expect(rl.resetAt! - rl.at).toBe(20000)
    q.resume()
    await q.idle()
    expect(e.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
    expect(mock.state.requests).toHaveLength(2)
  })

  it('pauses on a rejected Claude key', async () => {
    reset()
    mock.state.script = [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]
    const e = env('anthropic')
    const f = writeLesson(e.dir, 'Biology', 'Lesson 1.md', 1)
    const res = await importPaths(e.repo, [f])
    e.repo.enqueueOrganize(res.docIds[0])
    const q = makeQueue(e)
    q.start()
    await q.idle()
    expect(q.userPaused).toBe(true)
    expect(q.pauseReason).toMatch(/API key rejected \(HTTP 401\)/)
    expect(e.store.all<Job>('jobs')[0].status).toBe('queued')
  })

  it('Test model reports Claude capabilities', async () => {
    reset()
    const r = await testModel({ provider: 'anthropic', baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'claude-haiku-5-5')
    expect(r.ok).toBe(true)
    expect(r.api).toBe('messages')
    expect(mock.state.requests[0].body.fallbacks).toBeUndefined()
    expect(r.notes.join(' ')).toMatch(/Refusal fallback: not available/)
  })
})

describe('OpenAI through the Responses API', () => {
  it('organizes a lesson with instructions, JSON mode, low reasoning effort and storage off', async () => {
    reset()
    const e = env('openai')
    expect((await organizeOne(e)).status).toBe('organized')
    const r = mock.state.requests[0]
    expect(r.url).toBe('/v1/responses')
    expect(r.key).toBe('test-key')
    expect(r.body.model).toBe('gpt-6-luna')
    expect(r.body.instructions).toMatch(/organize study material/)
    expect(r.body.text).toEqual({ format: { type: 'json_object' } })
    expect(r.body.reasoning).toEqual({ effort: 'low' })
    expect(r.body.store).toBe(false)
  })

  it('drops reasoning effort and JSON mode on HTTP 400 and remembers it', async () => {
    reset()
    mock.state.rejectThinking = true
    mock.state.rejectJsonMode = true
    const e = env('openai')
    expect((await organizeOne(e)).status).toBe('organized')
    const caps = e.store.kvGet<Record<string, ModelCaps>>('modelCaps')!['gpt-6-luna']
    expect(caps).toMatchObject({ api: 'responses', thinkMinimal: false, json: false, system: true })
  })

  it('Test model works against the Responses API', async () => {
    reset()
    const r = await testModel({ provider: 'openai', baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'gpt-5.6-terra')
    expect(r.ok).toBe(true)
    expect(r.api).toBe('responses')
    expect(r.reply).toContain('"ok":true')
  })
})
