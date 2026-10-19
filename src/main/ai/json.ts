// Robust JSON extraction from model output: strip code fences, take the outermost array/object.
// Plus the safe field readers and character caps every validator applies to what comes out.
export class InvalidJson extends Error {
  constructor(msg: string, public raw: string) { super(msg) }
}

/** Character caps for model output (and for the student answers sent to grading). */
export const CAP = { name: 120, term: 80, summary: 400, quiz: 500, feedback: 200, course: 120, notes: 500, answer: 2000 } as const

/** Model output as trimmed, capped text. Only strings, numbers and booleans count, so a hostile toString cannot throw. */
export function str(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
  return s.trim().slice(0, max)
}

/** Model output as a number: numbers and numeric strings only, else NaN. */
export function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
}

/** Up to `max` non-empty strings of at most `chars` characters each. */
export function strList(v: unknown, max: number, chars: number): string[] {
  return Array.isArray(v) ? v.map((x) => str(x, chars)).filter(Boolean).slice(0, max) : []
}

export function extractJson(raw: string): unknown {
  let s = raw.trim()
  s = s.replace(/^```(?:json|JSON)?\s*/m, '').replace(/```\s*$/m, '').trim()
  try { return JSON.parse(s) } catch { /* fall through */ }
  const firstObj = s.indexOf('{')
  const firstArr = s.indexOf('[')
  const candidates: [number, string][] = []
  if (firstObj >= 0) candidates.push([firstObj, '}'])
  if (firstArr >= 0) candidates.push([firstArr, ']'])
  candidates.sort((a, b) => a[0] - b[0])
  for (const [start, close] of candidates) {
    const end = s.lastIndexOf(close)
    if (end > start) {
      const sub = s.slice(start, end + 1)
      try { return JSON.parse(sub) } catch { /* try next */ }
      try { return JSON.parse(sub.replace(/,\s*([}\]])/g, '$1')) } catch { /* try next */ }
    }
  }
  throw new InvalidJson('Model output is not valid JSON', raw)
}
