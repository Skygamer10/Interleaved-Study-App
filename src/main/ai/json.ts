// Robust JSON extraction from model output: strip code fences, take the outermost array/object.
export class InvalidJson extends Error {
  constructor(msg: string, public raw: string) { super(msg) }
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
