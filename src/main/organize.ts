// AI-organized import: prompts, validation/repair of paragraph ranges, merging of continuing topics,
// and local de-duplication. The model never re-outputs source text; we slice locally.
import crypto from 'crypto'
import type { Para } from '../shared/types'
import { clamp, isGenericName, normName } from '../shared/util'
import { firstSentenceName, safeName, sliceText } from './preprocess'
import { CAP, InvalidJson, str, strList } from './ai/json'
import type { JsonSchema } from './ai/schema'

export const PROMPT_VERSION = 'org-v3'

export const ORGANIZE_SYSTEM = [
  'You organize study material into clear study topics.',
  'Input: numbered paragraphs labeled [pN] plus the document outline.',
  'Return ONLY compact JSON, no prose, no code fences:',
  '{"title":string?,"topics":[{"start":N,"end":N,"name":string,"unit":string,"summary":string,"difficulty":1-5,"terms":[string],"prereqs":[string],"continues":bool}]}',
  'Rules: topics cover every paragraph of the window in order, no gaps or overlaps; start/end are paragraph numbers.',
  'name: a specific concept title of at most 8 words (e.g. "Michaelis-Menten enzyme kinetics"); never generic like "Part 2", "Section 3", "Introduction continued".',
  'unit: the section/chapter the topic belongs to. summary: 1-2 sentences. terms: up to 6 key terms. prereqs: up to 3 prerequisite concepts.',
  'Aim for topics of roughly 300-1500 words. When headings are good, treat them as strong boundaries and mainly clean names and group units; split or merge only when clearly warranted.',
  'continues: true only for the first topic if it continues the previous window\'s last topic.',
  'Do not repeat the source text.'
].join('\n')

// Gemini response schemas mirror each prompt's JSON shape in the same key order; all fields are required
// (nullable where the prompt allows null) because optional or reordered fields make constrained output repeat.
const DIFFICULTY: JsonSchema = { type: 'integer', minimum: 1, maximum: 5 }
const TERMS: JsonSchema = { type: 'array', items: { type: 'string' }, maxItems: 6 }
const PREREQS: JsonSchema = { type: 'array', items: { type: 'string' }, maxItems: 3 }

/** title is null except in the first window. */
export const ORGANIZE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: ['string', 'null'] },
    topics: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          start: { type: 'integer' },
          end: { type: 'integer' },
          name: { type: 'string' },
          unit: { type: 'string' },
          summary: { type: 'string' },
          difficulty: DIFFICULTY,
          terms: TERMS,
          prereqs: PREREQS,
          continues: { type: 'boolean' }
        },
        required: ['start', 'end', 'name', 'unit', 'summary', 'difficulty', 'terms', 'prereqs', 'continues']
      }
    }
  },
  required: ['title', 'topics']
}

export function organizePrompt(o: { lessonTitle: string; outline: string; paras: Para[]; from: number; to: number; prevTopic: string | null; first: boolean }): string {
  const lines = o.paras.filter((p) => p.id >= o.from && p.id <= o.to).map((p) => `[p${p.id}] ${p.text}`)
  return [
    `Lesson file: ${o.lessonTitle}`,
    o.first ? 'Also propose "title": a clean lesson title (max 8 words).' : '',
    o.outline ? `Outline:\n${o.outline}` : 'Outline: (no headings detected)',
    o.prevTopic ? `Previous window ended with topic: "${o.prevTopic}"` : 'This is the first window.',
    `Paragraphs p${o.from}-p${o.to}:`,
    lines.join('\n')
  ].filter(Boolean).join('\n\n')
}

export interface WinTopic {
  start: number
  end: number
  name: string
  unit: string
  summary: string
  difficulty: number
  terms: string[]
  prereqs: string[]
  continues: boolean
}

export interface WinResult { title?: string | null; topics: WinTopic[] }

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (typeof v === 'string') { const m = v.match(/\d+/); return m ? Number(m[0]) : null }
  return null
}

function capWords(s: string, n: number): string {
  const w = s.split(/\s+/).filter(Boolean)
  return w.length <= n ? w.join(' ') : w.slice(0, n).join(' ')
}

/**
 * Validate a model's window output against the window range and repair it locally:
 * clamp to range, sort, remove overlaps, attach gaps to the nearest topic, fix generic names.
 */
export function normalizeWindow(raw: unknown, from: number, to: number, paras: Para[], lessonTitle: string): WinResult {
  const obj = Array.isArray(raw) ? { topics: raw } : (raw as Record<string, unknown>)
  if (!obj || typeof obj !== 'object' || !Array.isArray((obj as { topics?: unknown }).topics)) {
    throw new InvalidJson('Expected {"topics":[...]}', JSON.stringify(raw)?.slice(0, 500) ?? '')
  }
  const list: WinTopic[] = []
  for (const t of (obj as { topics: unknown[] }).topics) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    let start = toInt(r.start ?? r.s)
    let end = toInt(r.end ?? r.e)
    if (start === null || end === null) continue
    if (start > end) [start, end] = [end, start]
    start = clamp(start, from, to)
    end = clamp(end, from, to)
    list.push({
      start, end,
      name: capWords(str(r.name, CAP.name).replace(/\s+/g, ' '), 10),
      unit: str(r.unit, CAP.name),
      summary: str(r.summary, CAP.summary),
      difficulty: clamp(toInt(r.difficulty ?? r.d) ?? 3, 1, 5),
      terms: strList(r.terms, 6, CAP.term),
      prereqs: strList(r.prereqs ?? r.pre, 3, CAP.term),
      continues: r.continues === true || r.continues === 'true'
    })
  }
  if (!list.length) throw new InvalidJson('No valid topics with paragraph ranges', JSON.stringify(raw)?.slice(0, 500) ?? '')
  list.sort((a, b) => a.start - b.start || a.end - b.end)
  // Remove overlaps
  const fixed: WinTopic[] = []
  for (const t of list) {
    const prev = fixed[fixed.length - 1]
    if (prev && t.start <= prev.end) {
      if (t.end <= prev.end) { // fully contained: drop, keep terms
        prev.terms = [...new Set([...prev.terms, ...t.terms])].slice(0, 6)
        continue
      }
      t.start = prev.end + 1
    }
    fixed.push(t)
  }
  // Fill gaps: leading gap attaches to the first topic; inner/trailing gaps attach to the previous topic
  fixed[0].start = from
  for (let i = 1; i < fixed.length; i++) {
    if (fixed[i].start > fixed[i - 1].end + 1) fixed[i - 1].end = fixed[i].start - 1
  }
  fixed[fixed.length - 1].end = to
  // Fix names
  for (const t of fixed) {
    const body = sliceText(paras, t.start, t.end)
    t.name = safeName(t.name, body, lessonTitle)
    if (!t.unit || isGenericName(t.unit)) t.unit = ''
  }
  const title = str((obj as { title?: unknown }).title, CAP.name) || null
  return { title: title && !isGenericName(title) ? capWords(title, 10) : null, topics: fixed }
}

export interface FinalTopic extends WinTopic { words: number }

function mergeInto(a: WinTopic, b: WinTopic): void {
  a.end = Math.max(a.end, b.end)
  a.start = Math.min(a.start, b.start)
  a.terms = [...new Set([...a.terms, ...b.terms])].slice(0, 6)
  a.prereqs = [...new Set([...a.prereqs, ...b.prereqs])].slice(0, 3)
  if (b.summary && a.summary && !a.summary.includes(b.summary) && a.summary.length < 250) a.summary = `${a.summary} ${b.summary}`
  if (!a.summary) a.summary = b.summary
  a.difficulty = Math.round((a.difficulty + b.difficulty) / 2)
}

/** Combine window results into lesson topics: merge continuing topics, same-name neighbours and tiny topics. */
export function finalizeWindows(results: WinResult[], paras: Para[], lessonTitle: string, minWords = 60): FinalTopic[] {
  const all: WinTopic[] = []
  results.forEach((r, wi) => {
    r.topics.forEach((t, ti) => {
      const prev = all[all.length - 1]
      if (prev && wi > 0 && ti === 0 && (t.continues || normName(t.name) === normName(prev.name))) {
        mergeInto(prev, t)
        return
      }
      all.push({ ...t, terms: [...t.terms], prereqs: [...t.prereqs] })
    })
  })
  // Local de-duplication of adjacent identical names
  const dedup: WinTopic[] = []
  for (const t of all) {
    const prev = dedup[dedup.length - 1]
    if (prev && normName(prev.name) === normName(t.name)) { mergeInto(prev, t); continue }
    dedup.push(t)
  }
  // Merge tiny topics into a neighbour
  const words = (t: WinTopic): number => paras.filter((p) => p.id >= t.start && p.id <= t.end && !p.heading).reduce((a, p) => a + p.words, 0)
  const out: WinTopic[] = []
  for (let i = 0; i < dedup.length; i++) {
    const t = dedup[i]
    if (words(t) < minWords && dedup.length > 1) {
      if (out.length) { mergeInto(out[out.length - 1], t); continue }
      if (i + 1 < dedup.length) { const n = dedup[i + 1]; n.start = t.start; continue }
    }
    out.push(t)
  }
  // Units: fill missing units from the previous topic, else lesson title
  let unit = lessonTitle
  for (const t of out) {
    if (t.unit) unit = t.unit
    else t.unit = unit
  }
  // Disambiguate repeated names within the lesson
  const seen = new Map<string, number>()
  for (const t of out) {
    const k = normName(t.name)
    const n = (seen.get(k) || 0) + 1
    seen.set(k, n)
    if (n > 1) {
      const alt = firstSentenceName(sliceText(paras, t.start, t.end).replace(/^.*\n/, ''))
      t.name = alt && normName(alt) !== k ? alt : `${t.name} (${t.unit})`
    }
  }
  return out.map((t) => ({ ...t, words: words(t) || paras.filter((p) => p.id >= t.start && p.id <= t.end).reduce((a, p) => a + p.words, 0) }))
}

function tokenSet(s: string): Set<string> {
  return new Set(normName(s).split(' ').filter((w) => w.length > 2))
}

export function nameSimilarity(a: string, b: string): number {
  const A = tokenSet(a), B = tokenSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

/** Adjacent topics in the same unit whose names are similar but not identical: candidates for an AI merge check. */
export function ambiguousPairs(topics: { name: string; unit: string }[], lo = 0.5, max = 10): [number, number][] {
  const out: [number, number][] = []
  for (let i = 1; i < topics.length && out.length < max; i++) {
    const a = topics[i - 1], b = topics[i]
    if (a.unit !== b.unit) continue
    const s = nameSimilarity(a.name, b.name)
    if (s >= lo && s < 1) out.push([i - 1, i])
  }
  return out
}

// Object root (not a bare array): the Interactions API and OpenAI JSON mode expect an object; the validator takes both.
export const DEDUPE_SYSTEM = 'You decide whether adjacent study topics cover the same concept. Return ONLY JSON: {"pairs":[{"pair":N,"same":bool,"name":string}]} where name is the merged title (max 8 words) when same is true, else "".'

export const DEDUPE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: { pair: { type: 'integer' }, same: { type: 'boolean' }, name: { type: 'string' } },
        required: ['pair', 'same', 'name']
      }
    }
  },
  required: ['pairs']
}

export function dedupePrompt(pairs: { a: { name: string; summary: string }; b: { name: string; summary: string } }[]): string {
  return pairs.map((p, i) => `Pair ${i}:\nA: ${p.a.name} — ${p.a.summary}\nB: ${p.b.name} — ${p.b.summary}`).join('\n\n')
}

export const QUIZ_SYSTEM = [
  'You write short study quizzes from the given text only.',
  'Return ONLY JSON: {"questions":[{"type":"mc","q":string,"options":[4 strings],"answer":index 0-3,"why":string},{"type":"short","q":string,"answer":string}]}',
  'Write 5 questions: 3 multiple choice and 2 short answer. Keep answers short. Test understanding, not trivia.'
].join('\n')

/** Each question is either multiple choice (answer = option index) or short answer (answer = text). */
export const QUIZ_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['mc'] },
              q: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
              answer: { type: 'integer', minimum: 0, maximum: 3 },
              why: { type: 'string' }
            },
            required: ['type', 'q', 'options', 'answer', 'why']
          },
          {
            type: 'object',
            properties: { type: { type: 'string', enum: ['short'] }, q: { type: 'string' }, answer: { type: 'string' } },
            required: ['type', 'q', 'answer']
          }
        ]
      }
    }
  },
  required: ['questions']
}

export const GRADE_SYSTEM = 'You grade short answers against an answer key. Be fair about wording. Return ONLY JSON: {"grades":[{"correct":bool,"feedback":string}]} with one entry per item, feedback max 20 words.'

/** The item count varies per request: gradeSchema(n) in jobs.ts pins it, and the validator checks it too. */
export const GRADE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    grades: {
      type: 'array',
      items: { type: 'object', properties: { correct: { type: 'boolean' }, feedback: { type: 'string' } }, required: ['correct', 'feedback'] }
    }
  },
  required: ['grades']
}

export const ENRICH_SYSTEM = [
  'You describe one study topic from its text.',
  'Return ONLY JSON: {"name":string,"summary":string,"difficulty":1-5,"terms":[string],"prereqs":[string]}',
  'name: specific concept title (max 8 words, never generic). summary 1-2 sentences, up to 6 terms, up to 3 prereqs.'
].join('\n')

export const ENRICH_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, summary: { type: 'string' }, difficulty: DIFFICULTY, terms: TERMS, prereqs: PREREQS },
  required: ['name', 'summary', 'difficulty', 'terms', 'prereqs']
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** Cache key: content + prompt version (+ model only when the setting asks for it). */
export function cacheKey(kind: string, content: string, model: string, includeModel: boolean): string {
  return sha256([kind, PROMPT_VERSION, includeModel ? model : '*', sha256(content)].join('|'))
}

export function windowCacheContent(o: { outline: string; paras: Para[]; from: number; to: number; first: boolean }): string {
  return `${o.first ? 'first' : 'next'}\n${o.outline}\n${sliceText(o.paras, o.from, o.to)}`
}
