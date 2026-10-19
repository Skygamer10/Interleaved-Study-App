// AI deadline extraction from spreadsheets: Markdown (from markitdown, or a built-in fallback) is cut into
// chunks that each keep their sheet heading and table header, and the model returns dated items as JSON.
import type { ExtractedDeadline } from '../shared/types'
import { deadlineKey } from '../shared/deadlineMap'
import { CAP, InvalidJson } from './ai/json'
import type { JsonSchema } from './ai/schema'

export const MAX_SHEET_MARKDOWN = 400_000
export const CHUNK_ROWS = 60

export const DEADLINES_SYSTEM = [
  'You extract deadlines from a spreadsheet that was converted to Markdown (each sheet starts with a "## Sheet name" heading).',
  'A deadline is any item with a due or event date: assignments, exams, quizzes, projects, presentations, readings due.',
  'Return ONLY compact JSON, no prose, no code fences:',
  '{"deadlines":[{"title":string,"date":"YYYY-MM-DD","course":string|null,"notes":string|null}]}',
  'Rules: one entry per dated item; skip rows without a date or without a clear item; never invent items or dates.',
  'title: short and specific, at most 12 words, taken from the row (e.g. "Essay 1", "Biology midterm").',
  'date: convert any format to YYYY-MM-DD and drop times. When the year is missing, pick the year that puts the date closest to today. For a range, use its end date. For ambiguous numeric dates like 03/04/2026, read day/month unless the same column shows month/day (a second number above 12).',
  'course: from a course column, the sheet name or the row text; when it is one of the known courses, copy that exact spelling; otherwise null.',
  'notes: other useful details from the same row (weight, time, room, format), or null. Never write "NaN" or "None".'
].join('\n')

/** Gemini response schema for DEADLINES_SYSTEM; course and notes are nullable but always present. */
export const DEADLINES_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    deadlines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: 'string', format: 'date' },
          course: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] }
        },
        required: ['title', 'date', 'course', 'notes']
      }
    }
  },
  required: ['deadlines']
}

export function deadlinesPrompt(chunk: string, part: number, of: number, today: string, courses: string[]): string {
  return `Today is ${today}.\nKnown courses: ${courses.length ? courses.join('; ') : '(none yet)'}\n\nSpreadsheet${of > 1 ? ` part ${part} of ${of}` : ''}:\n${chunk}`
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()

/** Built-in fallback when markitdown is not installed: the same "## sheet" + Markdown table layout. */
export function sheetsToMarkdown(sheets: { name: string; rows: unknown[][] }[]): string {
  const out: string[] = []
  for (const s of sheets) {
    const rows = s.rows.filter((r) => r.some((c) => cellText(c)))
    if (!rows.length) continue
    const width = Math.max(...rows.map((r) => r.length))
    const line = (r: unknown[]): string => `| ${Array.from({ length: width }, (_, i) => cellText(r[i])).join(' | ')} |`
    out.push(`## ${s.name}`, line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line), '')
  }
  return out.join('\n')
}

const isSeparator = (l: string): boolean => /^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l.trim())

/**
 * Split Markdown into chunks of at most `maxRows` table rows and about `maxChars` characters.
 * Every chunk starts with the current sheet heading and table header, so the model always sees column names.
 */
export function chunkMarkdown(md: string, maxRows = CHUNK_ROWS, maxChars = 14000): string[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const chunks: string[] = []
  let heading = ''
  let header: string[] = []
  let body: string[] = []
  let rows = 0
  let chars = 0
  const flush = (): void => {
    if (body.some((l) => l.trim())) chunks.push([heading, ...header, ...body].filter((l, i) => l || i > 0).join('\n').trim())
    body = []
    rows = 0
    chars = 0
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^#{1,6}\s/.test(l)) { flush(); heading = l; header = []; continue }
    if (l.trim().startsWith('|') && isSeparator(lines[i + 1] ?? '')) {
      flush()
      header = [l, lines[i + 1]]
      i++
      continue
    }
    if (!l.trim().startsWith('|') && !l.trim()) { if (body.length) body.push(l); continue }
    if (rows >= maxRows || chars + l.length > maxChars) flush()
    body.push(l)
    rows++
    chars += l.length + 1
  }
  flush()
  return chunks
}

function realDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

const clean = (v: unknown): string => {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^(nan|none|null|n\/a)$/i.test(s) ? '' : s
}

/** Validate one chunk's answer. Entries without a title or a real date are counted in `dropped`, not thrown. */
export function validateDeadlines(raw: unknown): { items: ExtractedDeadline[]; dropped: number } {
  const list = Array.isArray(raw) ? raw : (raw as { deadlines?: unknown })?.deadlines
  if (!Array.isArray(list)) throw new InvalidJson('Expected {"deadlines":[...]}', JSON.stringify(raw)?.slice(0, 300) ?? '')
  const items: ExtractedDeadline[] = []
  let dropped = 0
  for (const x of list) {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const title = clean(r.title).slice(0, CAP.name)
    const date = clean(r.date).slice(0, 10)
    if (!title || !realDate(date)) { dropped++; continue }
    items.push({ title, date, courseName: clean(r.course).slice(0, CAP.course) || null, notes: clean(r.notes).slice(0, CAP.notes) })
  }
  return { items, dropped }
}

/** Merge chunk results, dropping repeats (same title, date and course) that span chunks or sheets. */
export function mergeExtracted(parts: { items: ExtractedDeadline[]; dropped: number }[]): { items: ExtractedDeadline[]; dropped: number } {
  const seen = new Set<string>()
  const items: ExtractedDeadline[] = []
  let dropped = 0
  for (const p of parts) {
    dropped += p.dropped
    for (const it of p.items) {
      const k = deadlineKey(it.title, it.date, it.courseName)
      if (seen.has(k)) continue
      seen.add(k)
      items.push(it)
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
  return { items, dropped }
}
