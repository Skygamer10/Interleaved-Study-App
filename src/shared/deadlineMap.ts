// Column mapping and date parsing for deadline spreadsheets (.xlsx / .csv). Pure and unit-tested.
import { normName } from './util'

export type DateFormat = 'auto' | 'DMY' | 'MDY' | 'YMD'

export interface ColumnMapping {
  title: number
  date: number
  course: number | null
  notes: number | null
  headerRow: boolean
  dateFormat: DateFormat
}

export interface MappedRow {
  row: number // 1-based spreadsheet row
  title: string
  date: string // YYYY-MM-DD
  course: string | null
  notes: string
  key: string
  warning?: string
}

export interface MapResult {
  valid: MappedRow[]
  errors: { row: number; error: string }[]
  duplicates: number
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Excel serial date (1900 system) to ISO day. */
export function excelSerialToIso(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null
  const ms = Math.round((Math.floor(n) - 25569) * 86400000)
  const d = new Date(ms)
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function parseDate(v: unknown, fmt: DateFormat): { date: string | null; warning?: string } {
  if (v === null || v === undefined || v === '') return { date: null }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return { date: iso(v.getFullYear(), v.getMonth() + 1, v.getDate()) }
  }
  if (typeof v === 'number') return { date: excelSerialToIso(v) }
  const s = String(v).trim()
  if (/^\d{5}(\.\d+)?$/.test(s)) return { date: excelSerialToIso(Number(s)) }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/)
  if (m) return { date: iso(+m[1], +m[2], +m[3]) }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3]
    if (fmt === 'DMY') return { date: iso(y, b, a) }
    if (fmt === 'MDY') return { date: iso(y, a, b) }
    if (fmt === 'YMD') return { date: null }
    if (a > 12 && b <= 12) return { date: iso(y, b, a) }
    if (b > 12 && a <= 12) return { date: iso(y, a, b) }
    return { date: iso(y, b, a), warning: 'Ambiguous day/month; read as day/month. Pick a date format to be sure.' }
  }
  // "12 Mar 2026", "12 March, 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/)
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return { date: iso(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]) }
  }
  // "March 12, 2026", "Mar 12 2026"
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/)
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return { date: iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]) }
  }
  return { date: null }
}

export function deadlineKey(title: string, date: string, course: string | null | undefined): string {
  return `${normName(title)}|${date}|${normName(course || '')}`
}

/** Guess columns from a header row. */
export function guessMapping(header: unknown[]): ColumnMapping {
  const h = header.map((x) => normName(String(x ?? '')))
  const find = (re: RegExp): number => h.findIndex((x) => re.test(x))
  const title = find(/^(title|event|name|task|assessment|item|description|what)/)
  const date = find(/(date|due|deadline|when|day)/)
  const course = find(/(course|subject|module|class)/)
  const notes = find(/(note|comment|detail|remark)/)
  return {
    title: title >= 0 ? title : 0,
    date: date >= 0 ? date : (h.length > 1 ? 1 : 0),
    course: course >= 0 ? course : null,
    notes: notes >= 0 ? notes : null,
    headerRow: title >= 0 || date >= 0,
    dateFormat: 'auto'
  }
}

export function mapRows(rows: unknown[][], map: ColumnMapping, existingKeys: Set<string> = new Set()): MapResult {
  const valid: MappedRow[] = []
  const errors: { row: number; error: string }[] = []
  const seen = new Set<string>()
  let duplicates = 0
  rows.forEach((r, i) => {
    if (map.headerRow && i === 0) return
    const rowNo = i + 1
    if (!r || r.every((c) => c === null || c === undefined || String(c).trim() === '')) return
    const title = String(r[map.title] ?? '').trim()
    if (!title) { errors.push({ row: rowNo, error: 'Missing title' }); return }
    const raw = r[map.date]
    const pd = parseDate(raw, map.dateFormat)
    if (!pd.date) {
      errors.push({ row: rowNo, error: raw === undefined || raw === null || raw === '' ? 'Missing date' : `Unreadable date "${String(raw)}"` })
      return
    }
    const course = map.course !== null ? String(r[map.course] ?? '').trim() || null : null
    const notes = map.notes !== null ? String(r[map.notes] ?? '').trim() : ''
    const key = deadlineKey(title, pd.date, course)
    if (seen.has(key) || existingKeys.has(key)) { duplicates++; return }
    seen.add(key)
    valid.push({ row: rowNo, title, date: pd.date, course, notes, key, warning: pd.warning })
  })
  return { valid, errors, duplicates }
}
