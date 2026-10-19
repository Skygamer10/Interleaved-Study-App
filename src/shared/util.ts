// Small helpers shared by main and renderer.
export const DAY = 86400000

export function dayKey(t: number | Date = Date.now()): string {
  const d = typeof t === 'number' ? new Date(t) : t
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

export type PushUnit = 'minutes' | 'hours' | 'days' | 'months'

/** Adds an amount of time to a timestamp. Months follow the calendar (Jan 31 + 1 month = Feb 28/29). */
export function addTime(t: number, amount: number, unit: PushUnit): number {
  if (unit === 'minutes') return t + amount * 60000
  if (unit === 'hours') return t + amount * 3600000
  if (unit === 'days') return t + amount * DAY
  const d = new Date(t)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + Math.round(amount))
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()))
  return d.getTime()
}

/** Local "YYYY-MM-DDTHH:MM" for a datetime-local input. */
export function localDateTime(t: number): string {
  const d = new Date(t)
  return `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function parseDayKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(k: string, n: number): string {
  const d = parseDayKey(k)
  d.setDate(d.getDate() + n)
  return dayKey(d)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDayKey(b).getTime() - parseDayKey(a).getTime()) / DAY)
}

export function fmtDays(d: number): string {
  return `${Math.abs(d).toFixed(1)} day${Math.abs(d) >= 0.95 && Math.abs(d) < 1.05 ? '' : 's'}`
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function round5(v: number): number {
  return Math.round(v / 5) * 5
}

export function wordCount(s: string): number {
  const m = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
  return m ? m.length : 0
}

const GENERIC = /^(part|section|chunk|segment|piece|block|topic|unit|lesson|page)\s*[#.:-]?\s*(\d+|[ivxlc]+)\s*[.:)-]?$/i

/** True for names like "Part 3", "Section 2", "Chunk 7" which must never be used as topic names. */
export function isGenericName(name: string): boolean {
  const n = name.trim()
  return n.length === 0 || GENERIC.test(n) || /^\d+[.)]?$/.test(n)
}

/** Baseline study minutes from word count, adjusted by AI difficulty (1..5) when known. */
export function suggestedMinutes(words: number, difficulty?: number | null, pace = 120): number {
  const base = clamp(round5(words / pace), 10, 60)
  if (!difficulty) return base
  return clamp(round5(base * (0.8 + 0.1 * clamp(difficulty, 1, 5))), 10, 60)
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
