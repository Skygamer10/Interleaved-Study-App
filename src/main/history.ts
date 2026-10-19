// History carry-over: match new topics to old ones (same name, or text Jaccard on word shingles >= 0.6)
// and copy their study history so re-imports and re-organization never silently lose progress.
import type { Topic } from '../shared/types'
import { normName } from '../shared/util'

export const SHINGLE = 3
export const MATCH_THRESHOLD = 0.6

export function shingles(text: string, k = SHINGLE): Set<string> {
  const w = normName(text).split(' ').filter(Boolean)
  const out = new Set<string>()
  if (w.length === 0) return out
  if (w.length < k) { out.add(w.join(' ')); return out }
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let inter = 0
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  for (const x of small) if (big.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export interface MatchItem { id: string; name: string; text: string }

/** Returns newId -> oldId. Exact (normalized) name matches first, then best text similarity >= threshold, greedily. */
export function matchTopics(olds: MatchItem[], news: MatchItem[], threshold = MATCH_THRESHOLD): Map<string, string> {
  const result = new Map<string, string>()
  const usedOld = new Set<string>()
  const byName = new Map<string, MatchItem[]>()
  for (const o of olds) {
    const k = normName(o.name)
    byName.set(k, [...(byName.get(k) || []), o])
  }
  for (const n of news) {
    const cands = (byName.get(normName(n.name)) || []).filter((o) => !usedOld.has(o.id))
    if (cands.length) { result.set(n.id, cands[0].id); usedOld.add(cands[0].id) }
  }
  const oldSh = new Map(olds.map((o) => [o.id, shingles(o.text)]))
  const pairs: { n: string; o: string; s: number }[] = []
  for (const n of news) {
    if (result.has(n.id)) continue
    const ns = shingles(n.text)
    for (const o of olds) {
      if (usedOld.has(o.id)) continue
      const s = jaccard(ns, oldSh.get(o.id)!)
      if (s >= threshold) pairs.push({ n: n.id, o: o.id, s })
    }
  }
  pairs.sort((a, b) => b.s - a.s)
  for (const p of pairs) {
    if (result.has(p.n) || usedOld.has(p.o)) continue
    result.set(p.n, p.o)
    usedOld.add(p.o)
  }
  return result
}

export const HISTORY_FIELDS = ['stab', 'due', 'last', 'evid', 'reviews', 'spent', 'override', 'notes', 'solidMark'] as const

export function hasHistory(t: Pick<Topic, 'reviews' | 'spent' | 'due' | 'notes' | 'override'>): boolean {
  return (t.reviews?.length || 0) > 0 || (t.spent || 0) > 0 || !!t.due || !!(t.notes && t.notes.trim()) || (t.override !== null && t.override !== undefined)
}

export function carryHistory(target: Topic, from: Topic): Topic {
  const out = { ...target } as Topic & Record<string, unknown>
  for (const f of HISTORY_FIELDS) (out as Record<string, unknown>)[f] = structuredClone((from as unknown as Record<string, unknown>)[f])
  out.reviews = out.reviews || []
  out.spent = out.spent || 0
  out.notes = out.notes || ''
  return out
}
