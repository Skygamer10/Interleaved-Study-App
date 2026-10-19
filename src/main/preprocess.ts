// Local, zero-token preprocessing: normalize text, strip junk, number paragraphs, detect headings,
// build AI windows and provisional topics (never "Part N").
import type { Para } from '../shared/types'
import { isGenericName, normName, wordCount } from '../shared/util'

export function normalizeText(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/­/g, '')
    .replace(/[​-‍⁠]/g, '')
    .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2') // de-hyphenate words broken across lines
    .replace(/\t/g, '  ')
    .replace(/[^\S\n]{2,}/g, ' ') // any run of non-newline whitespace (incl. U+3000, \f) becomes one space
    .split('\n').map((l) => l.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const PAGE_NUM = /^\s*(?:[-–—]\s*)?(?:page|p\.|pg\.?|seite|pagina)?\s*\d{1,4}\s*(?:(?:of|\/|von|de)\s*\d{1,4})?\s*(?:[-–—])?\s*$/i
const RULE = /^\s*([-*_=]\s*){3,}$/

/** Remove page numbers, horizontal rules and short lines repeated many times (running headers/footers). */
export function stripJunk(text: string): string {
  const lines = text.split('\n')
  const counts = new Map<string, number>()
  for (const l of lines) {
    const k = l.trim().toLowerCase().replace(/\d+/g, '#')
    if (k.length > 0 && k.length < 80) counts.set(k, (counts.get(k) || 0) + 1)
  }
  const out: string[] = []
  for (const l of lines) {
    const t = l.trim()
    if (t.length > 0 && t.length <= 40 && PAGE_NUM.test(t)) continue // short lines only: keeps the regex cheap
    if (RULE.test(t)) continue
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(t)) continue // image-only lines carry no study text
    const k = t.toLowerCase().replace(/\d+/g, '#')
    if (t.length > 0 && t.length < 80 && (counts.get(k) || 0) >= 3 && !/^#{1,6}\s/.test(t) && !/^[-*+]\s|^\d+[.)]\s/.test(t)) continue
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function stripInline(s: string): string {
  return s
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, '')
    .replace(/\[([^[\]]+)\]\([^()]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/<[^<>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Detect a heading line. Returns level 1..6 and clean text, or null. */
export function detectHeading(block: string): { level: number; text: string } | null {
  if (block.includes('\n')) {
    const [a, b] = block.split('\n')
    if (block.split('\n').length === 2 && /^=+$/.test(b.trim()) && a.trim()) return { level: 1, text: stripInline(a) }
    if (block.split('\n').length === 2 && /^-+$/.test(b.trim()) && a.trim()) return { level: 2, text: stripInline(a) }
    return null
  }
  const t = block.trim()
  const md = t.length <= 300 ? t.match(/^(#{1,6})\s+(.+?)\s*#*$/) : null // bounded: the lazy group backtracks on long lines
  if (md) return { level: md[1].length, text: stripInline(md[2]) }
  const bold = t.match(/^(?:\*\*|__)(.{2,90})(?:\*\*|__):?$/)
  if (bold && wordCount(bold[1]) <= 12) return { level: 3, text: stripInline(bold[1]) }
  if (t.length > 90 || wordCount(t) > 12 || wordCount(t) === 0) return null
  if (/[.,;:!?]$/.test(t) && !/^\d+(\.\d+)*\.?\s/.test(t)) return null
  if (/^[-*+>|]/.test(t)) return null
  const num = t.match(/^((?:\d+\.)+\d*|\d+\)?|[IVXLC]+\.)\s+(\S.*)$/)
  if (num && /^\p{Lu}/u.test(num[2])) {
    const depth = num[1].replace(/\.$/, '').split('.').length
    return { level: Math.min(6, depth + 1), text: stripInline(t) }
  }
  const letters = t.replace(/[^\p{L}]/gu, '')
  if (letters.length >= 4 && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters)) return { level: 2, text: stripInline(t) }
  const words = t.split(/\s+/)
  const caps = words.filter((w) => /^\p{Lu}/u.test(w)).length
  if (words.length >= 2 && words.length <= 9 && caps / words.length >= 0.6 && !/[.!?]$/.test(t)) return { level: 3, text: stripInline(t) }
  return null
}

const MAX_PARA_WORDS = 350

function splitLong(text: string): string[] {
  if (wordCount(text) <= MAX_PARA_WORDS) return [text]
  const sentences = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?\s*|[^.!?]+$/g) || [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur && wordCount(cur) + wordCount(s) > 200) { out.push(cur.trim()); cur = '' }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Split normalized text into numbered paragraphs (headings are their own paragraphs). */
export function toParas(text: string): Para[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const out: Para[] = []
  for (const b of blocks) {
    // A heading line immediately followed by body text in the same block
    const lines = b.split('\n')
    const firstH = lines.length > 1 ? detectHeading(lines[0]) : null
    const setext = lines.length === 2 && /^(=+|-+)$/.test(lines[1].trim())
    if (firstH && !setext) {
      out.push({ id: 0, text: lines[0].trim(), words: wordCount(lines[0]), heading: firstH })
      const rest = lines.slice(1).join('\n').trim()
      if (rest) for (const piece of splitLong(rest)) out.push({ id: 0, text: piece, words: wordCount(piece), heading: null })
      continue
    }
    const h = detectHeading(b)
    if (h) { out.push({ id: 0, text: b.trim(), words: wordCount(b), heading: h }); continue }
    for (const piece of splitLong(b)) out.push({ id: 0, text: piece, words: wordCount(piece), heading: null })
  }
  out.forEach((p, i) => (p.id = i + 1))
  return out
}

export interface Prepared {
  text: string
  paras: Para[]
  words: number
  outline: string
}

export function prepare(raw: string): Prepared {
  const text = stripJunk(normalizeText(raw))
  const paras = toParas(text)
  return { text, paras, words: paras.reduce((a, p) => a + p.words, 0), outline: buildOutline(paras) }
}

export function buildOutline(paras: Para[], maxChars = 1500): string {
  const lines: string[] = []
  let len = 0
  for (const p of paras) {
    if (!p.heading) continue
    const l = `${'  '.repeat(Math.max(0, p.heading.level - 1))}${p.heading.text} [p${p.id}]`
    if (len + l.length > maxChars) { lines.push('…'); break }
    lines.push(l)
    len += l.length + 1
  }
  return lines.join('\n')
}

export const estTokens = (chars: number): number => Math.ceil(chars / 4)

export interface Window { index: number; from: number; to: number; tokens: number }

/** Group paragraphs into windows of about `target` tokens, breaking at paragraph (preferably heading) boundaries. */
export function buildWindows(paras: Para[], target = 3500): Window[] {
  const wins: Window[] = []
  let from = -1
  let tokens = 0
  const push = (to: number): void => { wins.push({ index: wins.length, from: paras[from].id, to, tokens }); from = -1; tokens = 0 }
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i]
    const t = estTokens(p.text.length + 8)
    if (from >= 0) {
      const atHeading = !!p.heading && tokens >= target * 0.7
      if (tokens + t > target || atHeading) push(paras[i - 1].id)
    }
    if (from < 0) from = i
    tokens += t
  }
  if (from >= 0) push(paras[paras.length - 1].id)
  // Fold a tiny trailing window into the previous one
  if (wins.length >= 2 && wins[wins.length - 1].tokens < target * 0.25) {
    const last = wins.pop()!
    const prev = wins[wins.length - 1]
    prev.to = last.to
    prev.tokens += last.tokens
  }
  return wins
}

const LEAD_IN = /^(in this (section|chapter|lesson|part|unit)|this (section|chapter|lesson)|here we|we will|we now|now we|let us|let's|first,|second,|finally,|next,|in summary,|overall,)\s*/i
const STOP_TAIL = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'by', 'is', 'are', 'as', 'at', 'from', 'that', 'which'])

/** About six meaningful words from the first sentence of a section. */
export function firstSentenceName(text: string, maxWords = 6): string {
  const clean = stripInline(text.replace(/^#{1,6}\s+/gm, '')).replace(LEAD_IN, '')
  const sentence = (clean.match(/^[^.!?:;]+/) || [clean])[0]
  let words = sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, maxWords)
  while (words.length > 2 && STOP_TAIL.has(words[words.length - 1].toLowerCase())) words = words.slice(0, -1)
  let s = words.join(' ')
  while (s && ',()"\'“”'.includes(s[s.length - 1])) s = s.slice(0, -1)
  s = s.trim()
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Ensure a name is never generic; fall back to the first sentence, then to the lesson title. */
export function safeName(candidate: string, bodyText: string, lessonTitle: string): string {
  const c = candidate.trim().replace(/\s+/g, ' ')
  if (c && !isGenericName(c)) return c
  const fs = firstSentenceName(bodyText)
  if (fs && !isGenericName(fs)) return fs
  return `Notes from ${lessonTitle}`
}

export interface ProvisionalTopic {
  name: string
  unit: string
  start: number
  end: number
  words: number
}

/** Provisional topics before AI: sections split at headings, big sections split by size and named from their first sentence. */
export function provisionalTopics(paras: Para[], lessonTitle: string, maxWords = 1200): ProvisionalTopic[] {
  if (!paras.length) return []
  const levels = paras.filter((p) => p.heading).map((p) => p.heading!.level)
  const minLevel = levels.length ? Math.min(...levels) : 1
  // Unit = nearest top-level heading; topic boundary = any heading
  const sections: { heading: string | null; unit: string; paras: Para[] }[] = []
  let unit = lessonTitle
  let cur: { heading: string | null; unit: string; paras: Para[] } | null = null
  for (const p of paras) {
    if (p.heading) {
      if (p.heading.level === minLevel && levels.filter((l) => l === minLevel).length > 1) unit = p.heading.text
      cur = { heading: p.heading.text, unit, paras: [p] }
      sections.push(cur)
    } else {
      if (!cur) { cur = { heading: null, unit, paras: [] }; sections.push(cur) }
      cur.paras.push(p)
    }
  }
  // Merge heading-only or tiny sections into the following one (or previous for the last)
  const merged: typeof sections = []
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    const w = s.paras.filter((p) => !p.heading).reduce((a, p) => a + p.words, 0)
    if (w < 60 && i < sections.length - 1) {
      const next = sections[i + 1]
      next.paras = [...s.paras, ...next.paras]
      if (!next.heading || w === 0) next.heading = next.heading || s.heading
      continue
    }
    if (w < 60 && merged.length) { merged[merged.length - 1].paras.push(...s.paras); continue }
    merged.push(s)
  }
  const out: ProvisionalTopic[] = []
  for (const s of merged) {
    const pieces: Para[][] = []
    let curP: Para[] = []
    let w = 0
    for (const p of s.paras) {
      if (w + p.words > maxWords && curP.length && w > maxWords * 0.4) { pieces.push(curP); curP = []; w = 0 }
      curP.push(p)
      w += p.words
    }
    if (curP.length) pieces.push(curP)
    pieces.forEach((pp, idx) => {
      const body = pp.filter((p) => !p.heading).map((p) => p.text).join('\n\n') || pp.map((p) => p.text).join('\n\n')
      const base = idx === 0 && s.heading ? s.heading : firstSentenceName(body)
      out.push({
        name: safeName(base, body, lessonTitle),
        unit: s.unit && !isGenericName(s.unit) ? s.unit : lessonTitle,
        start: pp[0].id,
        end: pp[pp.length - 1].id,
        words: pp.reduce((a, p) => a + p.words, 0)
      })
    })
  }
  // Disambiguate identical names within a lesson
  const seen = new Map<string, number>()
  for (const t of out) {
    const k = normName(t.name)
    const n = (seen.get(k) || 0) + 1
    seen.set(k, n)
    if (n > 1) {
      const p = paras.find((x) => x.id > t.start && !x.heading) || paras.find((x) => x.id === t.start)!
      const alt = firstSentenceName(p.text)
      if (alt && normName(alt) !== k) t.name = alt
    }
  }
  return out
}

export function sliceText(paras: Para[], start: number, end: number): string {
  return paras.filter((p) => p.id >= start && p.id <= end).map((p) => p.text).join('\n\n')
}
