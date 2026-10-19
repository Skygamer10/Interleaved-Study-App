import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockServer } from '../scripts/mock-ai-server.mjs'
import { Queue } from '../src/main/queue'
import { gradeSchema, makeHandlers } from '../src/main/jobs'
import { importPaths } from '../src/main/importer'
import { testModel } from '../src/main/ai/test'
import { type CallOpts, HttpError, NetworkError, claudeSupportsFallback, defaultCaps, generate, geminiSupportsSchema, normalizeCaps } from '../src/main/ai/provider'
import { MAX_RESET_HINT_MS, MAX_RETRY_AFTER_MS, backoffMs, parseRetryAfter } from '../src/main/backoff'
import type { JsonSchema } from '../src/main/ai/schema'
import { GRADE_SCHEMA, ORGANIZE_SCHEMA } from '../src/main/organize'
import { DEFAULT_BASE_URLS, MODEL_PRESETS, baseUrlFor, mergeSettings } from '../src/shared/defaults'
import type { Doc, Grade, Job, ModelCaps, Provider, Topic } from '../src/shared/types'
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
  mock.state.rejectSchema = null
  mock.state.rejectMinimal = false
  mock.state.maxOutputLimit = null
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
    const old = mergeSettings({ ai: { model: 'gemini-3.8-flash', baseUrl: 'https://proxy.local' } })
    expect(old.ai.baseUrls.gemini).toBe('https://proxy.local')
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
    expect(JSON.stringify(r.body)).not.toMatch(/"properties"|response_format|responseJsonSchema/)
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
    expect(JSON.stringify(r.body)).not.toMatch(/"properties"|response_format|responseJsonSchema/)
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

describe('Gemini structured output', () => {
  const SCHEMA: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' }, reply: { type: 'string' } }, required: ['ok', 'reply'] }
  const gem = (endpoint: 'generateContent' | 'interactions' = 'generateContent') => ({ provider: 'gemini' as const, baseUrl: mock.url, key: 'k', endpoint })
  const opts = (over: Partial<CallOpts> = {}): CallOpts => ({
    model: 'gemini-3.8-flash', system: 'Reply with JSON.', prompt: 'Return {"ok":true,"reply":"ready"}', maxOutput: 400, json: true, thinkMinimal: true, schema: SCHEMA, ...over
  })
  const bodies = (): Record<string, any>[] => mock.state.requests.map((r) => r.body)

  it('sends responseJsonSchema with responseMimeType on generateContent and remembers that it works', async () => {
    reset()
    const r = await generate(gem(), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.result.text).toContain('"ok":true')
    expect(bodies()[0].generationConfig).toEqual({ maxOutputTokens: 400, responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'minimal' } })
    expect(r.caps).toMatchObject({ schema: true, json: true, thinkMinimal: true, system: true })
  })

  it('sends response_format on Interactions, with the schema and in plain JSON mode', async () => {
    reset()
    await generate(gem('interactions'), opts(), defaultCaps('gemini-3.8-flash', 'gemini'))
    await generate(gem('interactions'), opts({ schema: undefined }), defaultCaps('gemini-3.8-flash'))
    const [withSchema, plain] = bodies()
    expect(withSchema.response_format).toEqual({ type: 'text', mime_type: 'application/json', schema: SCHEMA })
    expect(plain.response_format).toEqual({ type: 'text', mime_type: 'application/json' })
    for (const b of [withSchema, plain]) expect(b.response_mime_type).toBeUndefined()
    expect(withSchema.generation_config).toEqual({ max_output_tokens: 400, thinking_level: 'minimal' })
  })

  it('leaves the schema out for models without structured output and for Claude and OpenAI', async () => {
    reset()
    for (const m of ['gemini-2.5-flash-image', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-live-preview', 'gemini-embedding-2']) expect(geminiSupportsSchema(m)).toBe(false)
    for (const m of ['gemma-4-31b-it', 'gemini-3.8-flash', 'gemini-flash-latest']) expect(geminiSupportsSchema(m)).toBe(true)
    const r = await generate(gem(), opts({ model: 'gemini-3.1-flash-image' }), defaultCaps('gemini-3.1-flash-image'))
    expect(bodies()[0].generationConfig).toMatchObject({ responseMimeType: 'application/json' })
    expect(bodies()[0].generationConfig.responseJsonSchema).toBeUndefined()
    expect(r.caps.schema).toBeNull()
    for (const provider of ['anthropic', 'openai'] as const) {
      const model = MODEL_PRESETS[provider][0]
      const c = await generate({ provider, baseUrl: mock.url, key: 'k', endpoint: 'auto' }, opts({ model }), defaultCaps(model, provider))
      expect(c.caps.schema).toBeNull()
    }
    for (const b of bodies().slice(1)) expect(JSON.stringify(b)).not.toMatch(/"properties"|response_format|responseJsonSchema/)
  })

  it('drops the schema and JSON mode when JSON mode is not enabled, keeping thinking and the system instruction', async () => {
    reset()
    mock.state.rejectSchema = 'nojson'
    const r = await generate(gem(), opts({ model: 'gemma-4-31b-it' }), defaultCaps('gemma-4-31b-it'))
    expect(r.caps).toMatchObject({ schema: false, json: false, thinkMinimal: true, system: true })
    expect(bodies()).toHaveLength(2)
    expect(bodies()[1].generationConfig).toEqual({ maxOutputTokens: 400, thinkingConfig: { thinkingLevel: 'minimal' } })
  })

  it('keeps JSON mode when only the responseJsonSchema field is unknown, and remembers it', async () => {
    reset()
    mock.state.rejectSchema = 'unknown'
    const r = await generate(gem(), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.caps).toMatchObject({ schema: false, json: true, thinkMinimal: true, system: true })
    expect(bodies()[1].generationConfig).toEqual({ maxOutputTokens: 400, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'minimal' } })
    // Learned: the next request goes without the schema straight away
    await generate(gem(), opts(), r.caps)
    expect(bodies()).toHaveLength(3)
    expect(bodies()[2].generationConfig.responseJsonSchema).toBeUndefined()
  })

  it('keeps JSON mode when the schema field is unknown on Interactions', async () => {
    reset()
    mock.state.rejectSchema = 'unknown'
    const r = await generate(gem('interactions'), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.caps).toMatchObject({ schema: false, json: true, thinkMinimal: true, system: true })
    expect(bodies()[1].response_format).toEqual({ type: 'text', mime_type: 'application/json' })
  })

  it.each(['complex', 'bare'] as const)('retries a %s schema rejection without the schema, for that request only', async (kind) => {
    reset()
    mock.state.rejectSchema = kind
    const r = await generate(gem(), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.caps).toMatchObject({ schema: null, json: true, thinkMinimal: true, system: true })
    expect(bodies()[1].generationConfig).toEqual({ maxOutputTokens: 400, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'minimal' } })
    mock.state.rejectSchema = null
    await generate(gem(), opts(), r.caps)
    expect(bodies()[2].generationConfig.responseJsonSchema).toEqual(SCHEMA)
  })

  it('drops rejected thinking levels without blaming the schema: minimal, then low, then none with full headroom', async () => {
    reset()
    mock.state.rejectThinking = true
    const r = await generate(gem(), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.caps).toMatchObject({ schema: true, json: true, thinkMinimal: false, thinkLevel: 'none', system: true })
    expect(bodies().map((b) => b.generationConfig.thinkingConfig)).toEqual([{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, undefined])
    expect(bodies()[2].generationConfig).toEqual({ maxOutputTokens: 400 + 12000, responseMimeType: 'application/json', responseJsonSchema: SCHEMA })
    await generate(gem('interactions'), opts({ thinkMinimal: false }), defaultCaps('gemini-3.8-flash'))
    expect(bodies()[3].generation_config).toEqual({ max_output_tokens: 400 + 12000 })
  })

  it('uses thinking level low with small headroom when only minimal is rejected, and remembers it', async () => {
    reset()
    mock.state.rejectMinimal = true
    const r = await generate(gem(), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.caps).toMatchObject({ thinkMinimal: false, thinkLevel: 'low', schema: true, json: true, system: true })
    expect(bodies()[1].generationConfig).toEqual({ maxOutputTokens: 400 + 4096, responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'low' } })
    await generate(gem('interactions'), opts(), r.caps)
    expect(bodies()).toHaveLength(3)
    expect(bodies()[2].generation_config).toEqual({ max_output_tokens: 400 + 4096, thinking_level: 'low' })
    // Caps saved before levels existed (minimal rejected, nothing about low) try low straight away
    const old = { ...defaultCaps('gemini-3.8-flash'), thinkMinimal: false }
    delete old.thinkLevel
    await generate(gem(), opts(), old)
    expect(bodies()[3].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
  })

  it('retries without the headroom when the model\'s output limit is too small, dropping nothing else', async () => {
    reset()
    mock.state.maxOutputLimit = 8192
    const r = await generate(gem(), opts({ model: 'gemma-4-31b-it', thinkMinimal: false }), defaultCaps('gemma-4-31b-it'))
    expect(bodies()).toHaveLength(2)
    expect(bodies()[1].generationConfig).toEqual({ maxOutputTokens: 400, responseMimeType: 'application/json', responseJsonSchema: SCHEMA })
    expect(r.caps).toMatchObject({ schema: true, json: true, system: true, thinkMinimal: null })
  })

  it('pins the grade schema to the number of items', async () => {
    reset()
    expect(gradeSchema(3).properties!.grades).toMatchObject({ minItems: 3, maxItems: 3 })
    expect(GRADE_SCHEMA.properties!.grades.minItems).toBeUndefined()
    const e = env('gemini')
    const items = [{ q: 'Q1', key: 'K1', answer: 'A1' }, { q: 'Q2', key: 'K2', answer: '' }, { q: 'Q3', key: 'K3', answer: 'A3' }]
    const grades = (await makeQueue(e).enqueue(e.repo.createJob({ kind: 'grade', topicId: null, label: 'Grade', payload: { items }, estTokens: 100 }), true)) as Grade[]
    expect(grades).toHaveLength(3)
    expect(bodies()[0].generationConfig.responseJsonSchema).toEqual(gradeSchema(3))
  })

  it('sends the schema with the repair retry too', async () => {
    reset()
    mock.state.script = [{ text: 'not json' }]
    expect((await organizeOne(env('gemini'))).status).toBe('organized')
    expect(bodies()[1].contents[0].parts[0].text).toMatch(/Return ONLY the valid JSON/)
    expect(bodies()[1].generationConfig.responseJsonSchema).toEqual(ORGANIZE_SCHEMA)
  })

  it('loads caps saved before structured output existed, then learns it', async () => {
    reset()
    const e = env('gemini')
    const old = { model: 'gemma-4-31b-it', api: 'generateContent', system: true, json: true, thinkMinimal: true, fallback: null, testedAt: 1 }
    e.store.kvSet('modelCaps', { 'gemma-4-31b-it': old })
    expect((await organizeOne(e)).status).toBe('organized')
    expect(bodies()[0].generationConfig.responseJsonSchema).toEqual(ORGANIZE_SCHEMA)
    expect(e.store.kvGet<Record<string, ModelCaps>>('modelCaps')!['gemma-4-31b-it']).toEqual({ ...old, schema: true, schemaFails: 0, thinkLevel: 'minimal' })
  })

  it('Test model reports structured output as not accepted when the probe schema is rejected, and remembers it', async () => {
    reset()
    mock.state.rejectSchema = 'bare'
    const r = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'gemma-4-31b-it')
    expect(r.ok).toBe(true)
    expect(r.caps).toMatchObject({ schema: false, json: true, thinkMinimal: true, system: true })
    expect(r.notes).toContain('Structured output (responseJsonSchema): not accepted; JSON mode with robust parsing is used.')
  })

  it('probes JSON mode again for Interactions caps saved while response_mime_type was rejected', async () => {
    reset()
    const stale: ModelCaps = { model: 'gemini-3.8-flash', api: 'interactions', system: true, json: false, thinkMinimal: true, fallback: null }
    expect(normalizeCaps(stale)).toMatchObject({ json: null, schema: null })
    expect(normalizeCaps({ ...stale, schema: false })).toMatchObject({ json: false, schema: false })
    expect(normalizeCaps({ ...stale, api: 'generateContent' })).toMatchObject({ json: false })
    const e = env('gemini')
    e.settings.ai.model = 'gemini-3.8-flash'
    e.store.kvSet('modelCaps', { 'gemini-3.8-flash': stale })
    expect((await organizeOne(e)).status).toBe('organized')
    expect(bodies()[0].response_format).toEqual({ type: 'text', mime_type: 'application/json', schema: ORGANIZE_SCHEMA })
    expect(e.store.kvGet<Record<string, ModelCaps>>('modelCaps')!['gemini-3.8-flash']).toMatchObject({ api: 'interactions', json: true, schema: true })
  })

  it('turns schemas off after two unexplained rejections in a row; a success resets the count', async () => {
    reset()
    mock.state.rejectSchema = 'bare'
    const caps = defaultCaps('gemma-4-31b-it')
    const r1 = await generate(gem(), opts({ model: 'gemma-4-31b-it' }), caps)
    expect(r1.caps).toMatchObject({ schema: null, schemaFails: 1, thinkMinimal: true })
    mock.state.rejectSchema = null
    const r2 = await generate(gem(), opts({ model: 'gemma-4-31b-it' }), r1.caps)
    expect(r2.caps).toMatchObject({ schema: true, schemaFails: 0 })
    mock.state.rejectSchema = 'bare'
    const r3 = await generate(gem(), opts({ model: 'gemma-4-31b-it' }), { ...r2.caps, schema: null })
    const r4 = await generate(gem(), opts({ model: 'gemma-4-31b-it' }), r3.caps)
    expect(r4.caps).toMatchObject({ schema: false, schemaFails: 2, json: true, thinkMinimal: true, system: true })
    const before = bodies().length
    await generate(gem(), opts({ model: 'gemma-4-31b-it' }), r4.caps)
    expect(bodies()).toHaveLength(before + 1)
    expect(bodies()[before].generationConfig.responseJsonSchema).toBeUndefined()
  })

  it('turns schemas off at once when the error says the model does not support them', async () => {
    reset()
    mock.state.rejectSchema = 'unsupported'
    const r = await generate(gem('interactions'), opts(), defaultCaps('gemini-3.8-flash'))
    expect(r.caps).toMatchObject({ schema: false, json: true, thinkMinimal: true })
  })

  it('drops the schema for one request only when an unknown keyword inside it is named', async () => {
    reset()
    mock.state.rejectSchema = 'keyword'
    for (const ep of ['generateContent', 'interactions'] as const) {
      const r = await generate(gem(ep), opts(), defaultCaps('gemini-3.8-flash'))
      expect(r.caps).toMatchObject({ schema: null, json: true, thinkMinimal: true, system: true })
      expect(r.caps.schemaFails ?? 0).toBe(0)
    }
    expect(bodies()).toHaveLength(4)
  })

  it('remembers when the headroom passes the output limit, and never drops other features for an output-limit 400', async () => {
    reset()
    mock.state.maxOutputLimit = 8192
    const r = await generate(gem(), opts({ model: 'gemma-4-31b-it', thinkMinimal: false }), defaultCaps('gemma-4-31b-it'))
    expect(r.caps).toMatchObject({ room: false, schema: true, json: true, system: true })
    await generate(gem(), opts({ model: 'gemma-4-31b-it', thinkMinimal: false }), r.caps)
    expect(bodies()).toHaveLength(3)
    expect(bodies()[2].generationConfig.maxOutputTokens).toBe(400)
    // The answer budget alone is over the limit: the 400 surfaces and nothing is dropped
    reset()
    mock.state.maxOutputLimit = 300
    const caps = defaultCaps('gemma-4-31b-it')
    await expect(generate(gem(), opts({ model: 'gemma-4-31b-it' }), caps)).rejects.toThrow(/out of range/)
    expect(bodies()).toHaveLength(1)
    expect(caps).toMatchObject({ system: null, json: null, thinkMinimal: null, schema: null })
  })

  it('drops nothing on a 400 about the API key, and the queue pauses for the key', async () => {
    reset()
    const keyErr = { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } }
    mock.state.script = [keyErr]
    const caps = defaultCaps('gemini-3.8-flash')
    await expect(generate(gem(), opts(), caps)).rejects.toBeInstanceOf(HttpError)
    expect(bodies()).toHaveLength(1)
    expect(caps).toEqual(defaultCaps('gemini-3.8-flash'))
    reset()
    mock.state.script = [keyErr]
    const t = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'gemini-3.8-flash')
    expect(t.ok).toBe(false)
    expect(bodies()).toHaveLength(1) // no Interactions retry for a key problem
    expect(t.caps).toMatchObject({ system: null, json: null, thinkMinimal: null, schema: null })
    reset()
    mock.state.script = [keyErr]
    const e = env('gemini')
    const f = writeLesson(e.dir, 'Biology', 'Lesson 1.md', 1)
    e.repo.enqueueOrganize((await importPaths(e.repo, [f])).docIds[0])
    const q = makeQueue(e)
    q.start()
    await q.idle()
    expect(q.pauseReason).toMatch(/API key rejected/)
    expect(e.store.kvGet('modelCaps')).toBeFalsy()
  })

  it('Test model re-probes a schema that was dropped because of a thinking error', async () => {
    reset()
    mock.state.rejectMinimal = 'bare'
    const r = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'gemini-3.8-flash')
    expect(r.ok).toBe(true)
    expect(r.caps).toMatchObject({ schema: true, schemaFails: 0, thinkMinimal: false, thinkLevel: 'low', json: true, system: true })
    expect(r.notes).toContain('Structured output (responseJsonSchema): supported.')
    expect(r.notes).toContain('Minimal thinking: not accepted; thinking level low is used instead.')
    expect(bodies().at(-1)!.generationConfig).toMatchObject({ responseJsonSchema: { type: 'object' }, thinkingConfig: { thinkingLevel: 'low' } })
  })

  it('Test model labels: Interactions JSON mode, and models without structured output', async () => {
    reset()
    const i = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'interactions' }, 'gemini-3.8-flash')
    expect(i.notes).toContain('JSON mode (response_format): supported.')
    expect(i.notes).toContain('Structured output (response_format schema): supported.')
    const img = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'generateContent' }, 'gemini-3.1-flash-image')
    expect(img.notes).toContain('Structured output: not used for this model type; JSON mode with robust parsing is used.')
    expect(img.caps.schema).toBe(false)
  })
})

describe('request hardening', () => {
  const gem = { provider: 'gemini' as const, key: 'k', endpoint: 'generateContent' as const }
  const o: CallOpts = { model: 'gemini-3.8-flash', system: 's', prompt: 'p', maxOutput: 100, json: true, thinkMinimal: true }

  it('does not follow redirects, so the key header stays with the configured host', async () => {
    reset()
    mock.state.script = [{ redirect: `${mock.url}/v1beta/models/x:generateContent` }]
    await expect(generate({ ...gem, baseUrl: mock.url }, o, defaultCaps(o.model))).rejects.toBeInstanceOf(NetworkError)
    expect(mock.state.requests).toHaveLength(1)
    mock.state.script = [{ redirect: `${mock.url}/v1/messages` }]
    await expect(generate({ provider: 'anthropic', key: 'k', endpoint: 'auto', baseUrl: mock.url }, { ...o, model: 'claude-haiku-5-5' }, defaultCaps('claude-haiku-5-5', 'anthropic'))).rejects.toBeInstanceOf(NetworkError)
    expect(mock.state.requests).toHaveLength(2)
  })

  it('refuses bodies over 4 MB, by Content-Length and while streaming', async () => {
    reset()
    for (const chunked of [false, true]) {
      mock.state.script = [{ bytes: 5 * 1024 * 1024, chunked }]
      await expect(generate({ ...gem, baseUrl: mock.url }, o, defaultCaps(o.model))).rejects.toThrow(/larger than 4 MB/)
    }
  })

  it('times out a body that stalls after the headers', async () => {
    reset()
    mock.state.script = [{ stall: true }]
    await expect(generate({ ...gem, baseUrl: mock.url, timeoutMs: 300 }, o, defaultCaps(o.model))).rejects.toThrow(/timed out/)
    mock.state.script = [{ stall: true }]
    await expect(generate({ provider: 'anthropic', key: 'k', endpoint: 'auto', baseUrl: mock.url, timeoutMs: 300 }, { ...o, model: 'claude-haiku-5-5' }, defaultCaps('claude-haiku-5-5', 'anthropic'))).rejects.toThrow(/timed out/)
  })

  it('caps sleeps at an hour, and a 5xx asking for that long pauses like a rate limit', async () => {
    expect(parseRetryAfter('10000000000')).toBe(MAX_RESET_HINT_MS)
    expect(parseRetryAfter(null, '{"retryDelay": "99999999s"}')).toBe(MAX_RESET_HINT_MS)
    expect(parseRetryAfter('17')).toBe(17000)
    // Google's daily free-tier 429 states the real wait in its message; it is kept for display, while sleeps stay capped.
    const daily = parseRetryAfter(null, '{"error":{"message":"Quota exceeded ... Please retry in 8h23m14.115529309s."}}')
    expect(daily).toBe(Math.round((8 * 3600 + 23 * 60 + 14.115529309) * 1000))
    expect(backoffMs(1, daily, () => 1)).toBe(MAX_RETRY_AFTER_MS)
    reset()
    mock.state.script = [{ status: 503, retryAfter: 10000000000 }]
    const e = env('gemini')
    const f = writeLesson(e.dir, 'Biology', 'Lesson 1.md', 1)
    e.repo.enqueueOrganize((await importPaths(e.repo, [f])).docIds[0])
    const q = makeQueue(e)
    q.start()
    await q.idle()
    expect(q.userPaused).toBe(true)
    const rl = q.status().rateLimit!
    expect(rl.resetAt! - rl.at).toBe(MAX_RESET_HINT_MS) // shown as the real (bounded) wait; nothing sleeps that long
    expect(e.store.all<Job>('jobs').every((j) => j.status === 'queued' && j.attempts === 0)).toBe(true)
  })

  it('keeps a "__proto__" model ID away from Object.prototype', async () => {
    reset()
    const e = env('gemini')
    e.settings.ai.model = '__proto__'
    const q = makeQueue(e)
    expect(q.caps('__proto__')).toEqual(defaultCaps('__proto__'))
    expect((await organizeOne(e)).status).toBe('organized')
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'json')).toBe(false)
    expect(({} as Record<string, unknown>).schema).toBeUndefined()
    const saved = e.store.kvGet<Record<string, ModelCaps>>('modelCaps')!
    expect(Object.hasOwn(saved, '__proto__')).toBe(true)
    expect(q.caps('__proto__')).toMatchObject({ model: '__proto__', json: true, schema: true })
  })
})
