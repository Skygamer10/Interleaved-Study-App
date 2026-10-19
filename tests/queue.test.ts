import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import { startMockServer } from '../scripts/mock-ai-server.mjs'
import { Queue } from '../src/main/queue'
import { makeHandlers } from '../src/main/jobs'
import { importPaths } from '../src/main/importer'
import { testModel } from '../src/main/ai/test'
import { isGenericName } from '../src/shared/util'
import type { Doc, Job, ModelCaps, Quiz, RateLimitInfo, Topic } from '../src/shared/types'
import { setup, writeLesson } from './helpers'

type Mock = Awaited<ReturnType<typeof startMockServer>>
let mock: Mock

beforeAll(async () => { mock = await startMockServer() })
afterAll(async () => { await mock.close() })

function makeQueue(env: ReturnType<typeof setup>, key: string | null = 'test-key', onRateLimit?: (i: RateLimitInfo) => void): Queue {
  env.settings.ai.baseUrls = { gemini: mock.url, anthropic: mock.url, openai: mock.url }
  return new Queue({
    store: env.store, settings: () => env.settings, getKey: () => key, handlers: makeHandlers(env.repo), random: () => 0, onRateLimit,
    onFail: (job, msg) => {
      if (job.kind === 'organize' && job.docId) {
        const d = env.store.get<Doc>('docs', job.docId)
        if (d) env.store.put('docs', { ...d, status: 'needs', error: msg })
      }
    }
  })
}

async function importOne(env: ReturnType<typeof setup>, sections = 6): Promise<Doc> {
  const f = writeLesson(env.dir, 'Biology', 'Lesson 1.md', sections)
  const res = await importPaths(env.repo, [f])
  expect(res.added).toBe(1)
  return env.store.get<Doc>('docs', res.docIds[0])!
}

function reset(): void {
  mock.state.script = []
  mock.state.requests = []
  mock.state.rejectJsonMode = false
  mock.state.rejectThinking = false
  mock.state.rejectGenerateContent = false
}

describe('import and provisional state', () => {
  it('stores the lesson as awaiting AI with provisional, non-generic names', async () => {
    const env = setup()
    const doc = await importOne(env)
    expect(doc.status).toBe('awaiting')
    expect(doc.title).toBe('Lesson 1')
    const topics = env.store.byParent<Topic>('topics', doc.id)
    expect(topics.length).toBeGreaterThan(3)
    expect(topics.every((t) => t.provisional && !isGenericName(t.name))).toBe(true)
    // Re-importing the unchanged file is a no-op
    const again = await importPaths(env.repo, [doc.path])
    expect(again.unchanged).toBe(1)
    expect(env.repo.estimate().requests).toBeGreaterThan(1)
  })
})

describe('AI queue with the mock server', () => {
  it('organizes a lesson window by window, then serves re-runs from the cache', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env)
    const n = env.repo.enqueueOrganize(doc.id)
    expect(n).toBeGreaterThan(1)
    const q = makeQueue(env)
    q.start()
    await q.idle()
    const after = env.store.get<Doc>('docs', doc.id)!
    expect(after.status).toBe('organized')
    expect(after.title).toBe('Mock lesson title')
    const topics = env.store.byParent<Topic>('topics', doc.id)
    expect(topics.every((t) => !t.provisional && t.name.startsWith('Concept of'))).toBe(true)
    expect(mock.state.requests.filter((r) => r.url.includes('generateContent'))).toHaveLength(n)
    // system instruction, JSON mode and minimal thinking were sent
    const body = mock.state.requests[0].body
    expect(body.systemInstruction).toBeTruthy()
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' })
    // Topic text is sliced locally from paragraph ranges
    expect(env.repo.topicText(topics[0].id).length).toBeGreaterThan(50)
    // Estimate now sees everything cached; re-organizing (not fresh) costs no requests
    expect(env.repo.estimate([doc.id]).requests).toBe(0)
    mock.state.requests = []
    env.repo.enqueueOrganize(doc.id, false)
    q.kick()
    await q.idle()
    expect(mock.state.requests).toHaveLength(0)
    expect(env.store.all<Job>('jobs')).toHaveLength(0)
  })

  it('pauses everything on a rate limit, notifies once, and continues where it stopped (also after a restart)', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 6)
    const windows = env.repo.enqueueOrganize(doc.id)
    expect(windows).toBeGreaterThan(2)
    mock.state.script = [{ text: undefined }, { status: 429, retryAfter: 30 }]
    const notified: RateLimitInfo[] = []
    const q = makeQueue(env, 'test-key', (i) => notified.push(i))
    const t0 = Date.now()
    q.start()
    await q.idle()
    // Paused at once (no waiting or retrying), with the provider's wait time and message kept for the banner
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(q.userPaused).toBe(true)
    expect(notified).toHaveLength(1)
    const rl = q.status().rateLimit!
    expect(rl.message).toMatch(/429/)
    expect(rl.provider).toBe('gemini')
    expect(rl.resetAt! - rl.at).toBe(30000)
    expect(mock.state.requests).toHaveLength(2)
    // Nothing lost: no failures, no attempts used, the finished window is kept
    const jobs = env.store.all<Job>('jobs')
    expect(jobs.filter((j) => j.status === 'failed')).toHaveLength(0)
    expect(jobs.every((j) => j.attempts === 0)).toBe(true)
    expect(env.store.get<Doc>('docs', doc.id)!.winsDone).toBe(1)
    // "Restart": the pause and the banner survive, and Continue finishes the lesson
    env.store.flush()
    const env2 = setup({}, env.dir)
    const q2 = makeQueue(env2)
    expect(q2.userPaused).toBe(true)
    expect(q2.status().rateLimit).toMatchObject({ resetAt: rl.resetAt })
    q2.start()
    await q2.idle()
    expect(mock.state.requests).toHaveLength(2)
    q2.resume()
    expect(q2.status().rateLimit).toBeNull()
    await q2.idle()
    expect(env2.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
    // Only the request that hit the limit was sent again
    expect(mock.state.requests).toHaveLength(windows + 1)
  })

  it('keeps a waiting quiz request alive through a rate-limit pause and delivers it after Continue', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    const topic = env.store.byParent<Topic>('topics', doc.id)[0]
    mock.state.script = [{ status: 429 }]
    const q = makeQueue(env)
    const pending = q.enqueue(env.repo.createJob({ kind: 'quiz', docId: doc.id, topicId: topic.id, label: 'Quiz', payload: {}, estTokens: 100 }), true) as Promise<Quiz>
    await q.idle()
    expect(q.status().rateLimit).not.toBeNull()
    expect(q.status().rateLimit!.resetAt).toBeNull()
    q.resume()
    const quiz = await pending
    expect(quiz.questions.length).toBeGreaterThan(0)
  })

  it('retries 5xx and network-style errors, failing after the attempt limit', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    env.repo.enqueueOrganize(doc.id)
    const jobs = env.store.all<Job>('jobs')
    // Pretend 5 attempts already happened so the next failure is the 6th
    for (const j of jobs) env.store.put('jobs', { ...j, attempts: 5 })
    mock.state.script = [{ status: 503 }]
    const q = makeQueue(env)
    q.start()
    await q.idle()
    const failed = env.store.all<Job>('jobs').filter((j) => j.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].error).toMatch(/Gave up after 6 attempts/)
    expect(env.store.get<Doc>('docs', doc.id)!.status).toBe('needs')
    // Retry works
    q.retry(failed[0].id)
    await q.idle()
    expect(env.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
  })

  it('repairs invalid JSON with exactly one retry', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    env.repo.enqueueOrganize(doc.id)
    mock.state.script = [{ text: 'Sorry, here are the topics: none' }]
    const q = makeQueue(env)
    q.start()
    await q.idle()
    expect(mock.state.requests).toHaveLength(2)
    expect(mock.state.requests[1].body.contents[0].parts[0].text).toMatch(/Return ONLY the valid JSON/)
    expect(env.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
  })

  it('fails the job when the repair is invalid too', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    env.repo.enqueueOrganize(doc.id)
    mock.state.script = [{ text: 'nope' }, { text: '{"topics": "still wrong"}' }]
    const q = makeQueue(env)
    q.start()
    await q.idle()
    const j = env.store.all<Job>('jobs')[0]
    expect(j.status).toBe('failed')
    expect(j.error).toMatch(/invalid JSON twice/)
    const d = env.store.get<Doc>('docs', doc.id)!
    expect(d.status).toBe('needs')
    // provisional topics are kept
    expect(env.store.byParent<Topic>('topics', doc.id).every((t) => t.provisional)).toBe(true)
  })

  it('falls back when JSON mode or minimal thinking cause HTTP 400 and remembers it per model', async () => {
    reset()
    mock.state.rejectJsonMode = true
    mock.state.rejectThinking = true
    const env = setup()
    const doc = await importOne(env, 1)
    env.repo.enqueueOrganize(doc.id)
    const q = makeQueue(env)
    q.start()
    await q.idle()
    expect(env.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
    const caps = env.store.kvGet<Record<string, ModelCaps>>('modelCaps')!['gemma-4-31b-it']
    expect(caps).toMatchObject({ json: false, thinkMinimal: false, system: true })
  })

  it('pauses the queue on a rejected key and keeps the job', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    env.repo.enqueueOrganize(doc.id)
    mock.state.script = [{ status: 403 }]
    const q = makeQueue(env)
    q.start()
    await q.idle()
    expect(q.userPaused).toBe(true)
    expect(q.pauseReason).toMatch(/API key rejected/)
    expect(env.store.all<Job>('jobs')[0].status).toBe('queued')
    q.resume()
    await q.idle()
    expect(env.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
  })

  it('waits without a key and resumes jobs left running after a restart', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    env.repo.enqueueOrganize(doc.id)
    const q1 = makeQueue(env, null)
    q1.start()
    await q1.idle()
    expect(q1.status().noKey).toBe(true)
    // Simulate a crash mid-request: the job is persisted as running
    const j = env.store.all<Job>('jobs')[0]
    env.store.put('jobs', { ...j, status: 'running' })
    env.store.flush()
    // "Restart": a fresh store instance from the same file and a new queue
    const env2 = setup({}, env.dir)
    expect(env2.store.all<Job>('jobs')[0].status).toBe('running')
    const q2 = makeQueue(env2)
    q2.start()
    await q2.idle()
    expect(env2.store.get<Doc>('docs', doc.id)!.status).toBe('organized')
  })

  it('makes a quiz on demand and caches it', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 1)
    const topic = env.store.byParent<Topic>('topics', doc.id)[0]
    const q = makeQueue(env)
    const job = env.repo.createJob({ kind: 'quiz', docId: doc.id, topicId: topic.id, label: 'Quiz', payload: {}, estTokens: 100 })
    const quiz = (await q.enqueue(job, true)) as Quiz
    expect(quiz.questions.length).toBe(5)
    expect(env.store.get('quizzes', topic.id)).toBeTruthy()
    const job2 = env.repo.createJob({ kind: 'quiz', docId: doc.id, topicId: topic.id, label: 'Quiz', payload: {}, estTokens: 100 })
    const before = mock.state.requests.length
    await q.enqueue(job2, true)
    expect(mock.state.requests.length).toBe(before) // served from the cache
  })
})

describe('Test model and the Interactions adapter', () => {
  it('probes capabilities with generateContent', async () => {
    reset()
    const r = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'gemma-4-31b-it')
    expect(r.ok).toBe(true)
    expect(r.caps).toMatchObject({ api: 'generateContent', system: true, json: true, thinkMinimal: true })
  })
  it('switches a gemini-3.x model to the Interactions API when generateContent fails', async () => {
    reset()
    mock.state.rejectGenerateContent = true
    const r = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'gemini-3.8-flash')
    expect(r.ok).toBe(true)
    expect(r.caps.api).toBe('interactions')
    const req = mock.state.requests.find((x) => x.url.endsWith('/interactions'))!
    expect(req.body).toMatchObject({ model: 'gemini-3.8-flash', system_instruction: expect.any(String), response_mime_type: 'application/json' })
  })
  it('reports the exact error when the model is unknown', async () => {
    reset()
    mock.state.script = [{ status: 404, body: { error: { code: 404, message: 'models/foo is not found', status: 'NOT_FOUND' } } }]
    const r = await testModel({ baseUrl: mock.url, key: 'k', endpoint: 'auto' }, 'foo')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/models\/foo is not found/)
  })
})

describe('re-import with history carry-over', () => {
  it('keeps history for topics that still match after the file changes', async () => {
    reset()
    const env = setup()
    const doc = await importOne(env, 4)
    const topics = env.store.byParent<Topic>('topics', doc.id).sort((a, b) => a.ord - b.ord)
    env.repo.review(topics[1].id, { rating: 'okay', minutes: 20, at: Date.now() })
    // Change the file: append a new section
    fs.appendFileSync(doc.path, '\n\n## A brand new section on vesicles\n\nVesicles carry cargo through the cell by endocytosis and exocytosis. ' + 'More vesicle detail here. '.repeat(20))
    const first = await importPaths(env.repo, [doc.path])
    expect(first.needsConfirm).toHaveLength(1)
    expect(first.needsConfirm[0].withHistory).toBe(1)
    const second = await importPaths(env.repo, [doc.path], true)
    expect(second.replaced).toBe(1)
    const now = env.store.byParent<Topic>('topics', doc.id)
    const carried = now.find((t) => t.reviews.length === 1)
    expect(carried?.name).toBe(topics[1].name)
    expect(carried?.id).toBe(topics[1].id)
    expect(now.some((t) => /vesicles/i.test(t.name))).toBe(true)
  })
})
