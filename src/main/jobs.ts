// Job handlers run by the queue: organize (segmentation + enrichment in one pass per window),
// dedupe (AI check of ambiguous merges), enrich (manual topics), quiz, grade, and deadlines (spreadsheet → calendar).
import type { Doc, ExtractedDeadline, Grade, Job, Quiz, QuizQuestion, Topic } from '../shared/types'
import { clamp, suggestedMinutes } from '../shared/util'
import type { Handler } from './queue'
import type { Repo } from './repo'
import { CAP, InvalidJson, num, str, strList } from './ai/json'
import type { JsonSchema } from './ai/schema'
import {
  DEDUPE_SCHEMA, DEDUPE_SYSTEM, ENRICH_SCHEMA, ENRICH_SYSTEM, GRADE_SCHEMA, GRADE_SYSTEM, ORGANIZE_SCHEMA, ORGANIZE_SYSTEM,
  QUIZ_SCHEMA, QUIZ_SYSTEM, cacheKey, dedupePrompt, normalizeWindow, organizePrompt, sha256, windowCacheContent, type WinResult
} from './organize'
import { safeName } from './preprocess'
import { DEADLINES_SCHEMA, DEADLINES_SYSTEM, deadlinesPrompt, mergeExtracted, validateDeadlines } from './deadlines'

export const QUIZ_TEXT_CHARS = 14000
export const MAX_GRADE_ITEMS = 8

export function validateQuiz(raw: unknown): QuizQuestion[] {
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown })?.questions
  if (!Array.isArray(list)) throw new InvalidJson('Expected {"questions":[...]}', JSON.stringify(raw)?.slice(0, 300) ?? '')
  const out: QuizQuestion[] = []
  for (const q of list) {
    if (!q || typeof q !== 'object') continue
    const r = q as Record<string, unknown>
    const text = str(r.q ?? r.question, CAP.quiz)
    if (!text) continue
    if (Array.isArray(r.options) && r.options.length >= 2) {
      const options = r.options.slice(0, 6).map((o) => str(o, CAP.quiz))
      if (options.some((o) => !o)) continue
      let answer = num(r.answer)
      if (!Number.isInteger(answer)) {
        const a = str(r.answer, CAP.quiz).toLowerCase()
        answer = options.findIndex((o) => o.toLowerCase() === a)
      }
      if (answer < 0 || answer >= options.length) continue
      out.push({ type: 'mc', q: text, options, answer, why: str(r.why, CAP.quiz) || undefined })
    } else {
      const answer = str(r.answer, CAP.quiz)
      if (answer) out.push({ type: 'short', q: text, answer })
    }
  }
  if (out.length < 2) throw new InvalidJson('Too few valid questions', JSON.stringify(raw)?.slice(0, 300) ?? '')
  return out.slice(0, 8)
}

export function validateGrades(raw: unknown, n: number): Grade[] {
  const list = Array.isArray(raw) ? raw : (raw as { grades?: unknown })?.grades
  if (!Array.isArray(list) || list.length !== n) throw new InvalidJson(`Expected ${n} grades`, JSON.stringify(raw)?.slice(0, 300) ?? '')
  return list.map((g) => {
    const r = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>
    return { correct: r.correct === true, feedback: str(r.feedback, CAP.feedback) }
  })
}

/** Pairs judged by the model; only integer pair indexes count, and only `same: true` merges. */
export function validateDedupe(raw: unknown): { pair: number; same: boolean; name: string }[] {
  const list = Array.isArray(raw) ? raw : (raw as { pairs?: unknown })?.pairs
  if (!Array.isArray(list)) throw new InvalidJson('Expected an array', JSON.stringify(raw)?.slice(0, 200) ?? '')
  return list.flatMap((x) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    return typeof r.pair === 'number' && Number.isInteger(r.pair) ? [{ pair: r.pair, same: r.same === true, name: str(r.name, CAP.name) }] : []
  })
}

export function validateEnrich(raw: unknown): { name: string; summary: string; difficulty: number; terms: string[]; prereqs: string[] } {
  const o = raw as Record<string, unknown>
  if (!o || typeof o !== 'object' || typeof o.summary !== 'string') throw new InvalidJson('Expected an object with summary', JSON.stringify(raw)?.slice(0, 200) ?? '')
  return {
    name: str(o.name, CAP.name), summary: str(o.summary, CAP.summary), difficulty: clamp(num(o.difficulty) || 3, 1, 5),
    terms: strList(o.terms, 6, CAP.term), prereqs: strList(o.prereqs, 3, CAP.term)
  }
}

/** GRADE_SCHEMA with the item count pinned for one request (minItems = maxItems = n, n within 1-8). */
export function gradeSchema(n: number): JsonSchema {
  const k = clamp(Math.trunc(n) || 1, 1, MAX_GRADE_ITEMS)
  const s = structuredClone(GRADE_SCHEMA)
  Object.assign(s.properties!.grades, { minItems: k, maxItems: k })
  return s
}

/** A grade job's items as sent by the window: 1-8 of them, every field text and capped. */
export function gradeItems(payload: unknown): { q: string; key: string; answer: string }[] {
  const list = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_GRADE_ITEMS) throw new Error(`Grading takes 1 to ${MAX_GRADE_ITEMS} answers at a time`)
  return list.map((it) => {
    const r = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
    return { q: str(r.q, CAP.quiz), key: str(r.key, CAP.quiz), answer: str(r.answer, CAP.answer) }
  })
}

export function makeHandlers(repo: Repo): Record<string, Handler> {
  const store = repo.store

  const organize: Handler = async (job: Job, ai) => {
    const docId = job.docId!
    const doc = store.get<Doc>('docs', docId)
    const prep = repo.docPrep(docId)
    if (!doc || !prep) return null // lesson deleted meanwhile
    const p = job.payload as { win: number; from: number; to: number; of: number; fresh?: boolean }
    const prev = p.win > 0 ? store.get<{ result: WinResult }>('wins', `${docId}:${p.win - 1}`) : undefined
    const prevTopic = prev?.result.topics[prev.result.topics.length - 1]?.name ?? null
    const s = repo.settings().ai
    const key = cacheKey('organize', windowCacheContent({ outline: prep.outline, paras: prep.paras, from: p.from, to: p.to, first: p.win === 0 }), s.model, s.includeModelInCacheKey)
    const result = await ai<WinResult>({
      system: ORGANIZE_SYSTEM,
      prompt: organizePrompt({ lessonTitle: doc.fileName || doc.title, outline: prep.outline, paras: prep.paras, from: p.from, to: p.to, prevTopic, first: p.win === 0 }),
      maxOutput: s.maxOutputTokens,
      validate: (raw) => normalizeWindow(raw, p.from, p.to, prep.paras, doc.title),
      schema: ORGANIZE_SCHEMA,
      cacheKey: key,
      skipCacheRead: !!p.fresh
    })
    store.put('wins', { id: `${docId}:${p.win}`, docId, idx: p.win, result })
    const done = store.byParent('wins', docId).length
    const cur = store.get<Doc>('docs', docId)
    if (cur) store.put('docs', { ...cur, winsDone: done })
    if (done >= p.of) repo.finalizeDoc(docId)
    return result
  }

  const dedupe: Handler = async (job, ai) => {
    const pairs = ((job.payload as { pairs: [string, string][] }).pairs || [])
      .map(([a, b]) => [store.get<Topic>('topics', a), store.get<Topic>('topics', b)] as const)
      .filter((x): x is readonly [Topic, Topic] => !!x[0] && !!x[1])
    if (!pairs.length) return []
    const res = await ai({
      system: DEDUPE_SYSTEM,
      prompt: dedupePrompt(pairs.map(([a, b]) => ({ a: { name: a.name, summary: a.summary }, b: { name: b.name, summary: b.summary } }))),
      maxOutput: 400,
      validate: validateDedupe,
      schema: DEDUPE_SCHEMA,
      cacheKey: cacheKey('dedupe', JSON.stringify(pairs.map(([a, b]) => [a.name, a.summary, b.name, b.summary])), repo.settings().ai.model, repo.settings().ai.includeModelInCacheKey)
    })
    for (const r of res) {
      const pr = pairs[r.pair]
      if (!r.same || !pr) continue
      if (!store.get('topics', pr[0].id) || !store.get('topics', pr[1].id)) continue
      repo.mergeTopics([pr[0].id, pr[1].id], r.name || undefined)
    }
    return res
  }

  const enrich: Handler = async (job, ai) => {
    const t = store.get<Topic>('topics', job.topicId!)
    if (!t) return null
    const text = repo.topicText(t.id).slice(0, QUIZ_TEXT_CHARS)
    const r = await ai({
      system: ENRICH_SYSTEM,
      prompt: `Topic name given by the student: ${t.name}\n\nText:\n${text}`,
      maxOutput: 400,
      validate: validateEnrich,
      schema: ENRICH_SCHEMA,
      cacheKey: cacheKey('enrich', text, repo.settings().ai.model, repo.settings().ai.includeModelInCacheKey)
    })
    const cur = store.get<Topic>('topics', t.id)
    if (!cur) return null
    const useAiName = (job.payload as { useAiName?: boolean }).useAiName
    repo.saveTopic({
      ...cur,
      name: useAiName && r.name ? safeName(r.name, text, cur.name) : cur.name,
      summary: r.summary, difficulty: r.difficulty, terms: r.terms, prereqs: r.prereqs,
      minutes: suggestedMinutes(cur.words, r.difficulty, repo.settings().study.pace)
    })
    return r
  }

  const quiz: Handler = async (job, ai) => {
    const t = store.get<Topic>('topics', job.topicId!)
    if (!t) throw new Error('Topic not found')
    const text = repo.topicText(t.id).slice(0, QUIZ_TEXT_CHARS)
    if (!text.trim()) throw new Error('This topic has no text to build a quiz from')
    const textHash = sha256(text)
    const questions = await ai<QuizQuestion[]>({
      system: QUIZ_SYSTEM,
      prompt: `Topic: ${t.name}\n\nText:\n${text}`,
      maxOutput: 900,
      validate: validateQuiz,
      schema: QUIZ_SCHEMA,
      cacheKey: cacheKey('quiz', text, repo.settings().ai.model, repo.settings().ai.includeModelInCacheKey),
      skipCacheRead: !!(job.payload as { regenerate?: boolean }).regenerate
    })
    const q: Quiz = { id: t.id, textHash, questions, createdAt: Date.now() }
    store.put('quizzes', q)
    return q
  }

  const grade: Handler = async (job, ai) => {
    const items = gradeItems(job.payload)
    return ai<Grade[]>({
      system: GRADE_SYSTEM,
      prompt: items.map((it, i) => `Item ${i}\nQuestion: ${it.q}\nAnswer key: ${it.key}\nStudent answer: ${it.answer || '(blank)'}`).join('\n\n'),
      maxOutput: 400,
      validate: (raw) => validateGrades(raw, items.length),
      schema: gradeSchema(items.length)
    })
  }

  /** One request per chunk; each is cached, so a retry after a failure only re-asks for the missing chunks. */
  const deadlines: Handler = async (job, ai) => {
    const p = job.payload as { chunks: string[]; today: string; courses: string[] }
    const s = repo.settings().ai
    const parts: { items: ExtractedDeadline[]; dropped: number }[] = []
    for (let i = 0; i < p.chunks.length; i++) {
      const prompt = deadlinesPrompt(p.chunks[i], i + 1, p.chunks.length, p.today, p.courses)
      const rows = p.chunks[i].split('\n').filter((l) => l.trim().startsWith('|')).length
      parts.push(await ai({
        system: DEADLINES_SYSTEM,
        prompt,
        maxOutput: clamp(rows * 45 + 200, 600, 6000),
        validate: validateDeadlines,
        schema: DEADLINES_SCHEMA,
        cacheKey: cacheKey('deadlines', prompt, s.model, s.includeModelInCacheKey)
      }))
    }
    return mergeExtracted(parts)
  }

  return { organize, dedupe, enrich, quiz, grade, deadlines }
}
