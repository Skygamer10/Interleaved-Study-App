// FSRS-lite scheduler and mastery model. Pure functions; mastery and status are derived on read.
import type { Rating, Review, Sched, Suggestion } from './types'
import { DAY } from './util'

export const EVIDENCE: Record<Rating, number> = { lost: 0.1, shaky: 0.4, okay: 0.7, solid: 1.0 }
export const RATINGS: Rating[] = ['lost', 'shaky', 'okay', 'solid']

export type Status = 'new' | 'progress' | 'review' | 'solid'
export const STATUS_LABEL: Record<Status, string> = { new: 'New', progress: 'In progress', review: 'Needs review', solid: 'Solid' }

export function categorize(e: number): Rating {
  if (e < 0.25) return 'lost'
  if (e < 0.55) return 'shaky'
  if (e < 0.85) return 'okay'
  return 'solid'
}

export function combinedEvidence(self: Rating, quiz?: number | null): number {
  const s = EVIDENCE[self]
  if (quiz === undefined || quiz === null || Number.isNaN(quiz)) return s
  return (s + 2 * quiz) / 3
}

export function nextStability(rating: Rating, s0?: number | null): number {
  const s = s0 && s0 > 0 ? s0 : 0.5
  switch (rating) {
    case 'lost': return Math.max(0.25, 0.3 * s)
    case 'shaky': return Math.max(0.5, 1.2 * s)
    case 'okay': return Math.max(1, 2.2 * s)
    case 'solid': return Math.max(3, 3.5 * s)
  }
}

export interface ReviewInput {
  rating: Rating | null // null = skip rating, record time only
  quiz?: number | null
  minutes: number
  note?: string
  at: number
}

/** Apply a review. A skipped rating only records time (and a history entry is not added). */
export function applyReview<T extends Sched>(s: T, r: ReviewInput): T {
  const spent = (s.spent || 0) + Math.max(0, r.minutes)
  if (!r.rating) return { ...s, spent }
  const ev = combinedEvidence(r.rating, r.quiz)
  const cat = categorize(ev)
  const stab = nextStability(cat, s.stab)
  const rev: Review = { at: r.at, rating: cat, self: r.rating, minutes: Math.round(r.minutes * 10) / 10, quiz: r.quiz ?? null }
  if (r.note) rev.note = r.note
  return {
    ...s, spent, stab, due: r.at + stab * DAY, last: r.at, evid: ev,
    reviews: [...(s.reviews || []), rev], override: null, solidMark: false
  }
}

export function recall(s: Sched, now: number): number {
  if (!s.last || !s.stab) return 0
  const days = Math.max(0, (now - s.last) / DAY)
  return Math.pow(0.9, days / s.stab)
}

export function mastery(s: Sched, now: number): number {
  if (s.override !== null && s.override !== undefined) return Math.round(s.override)
  if (!s.last || !s.stab) return 0
  const R = recall(s, now)
  const c = s.solidMark ? 1 : 0.6 + 0.4 * Math.min(1, (s.reviews?.length || 0) / 3)
  return Math.round(100 * R * (s.evid ?? 0) * c)
}

export function status(s: Sched, now: number): Status {
  if (!s.due) return 'new'
  if (mastery(s, now) >= 80) return 'solid'
  if (s.due <= now) return 'review'
  return 'progress'
}

export function lastRating(s: Sched): Rating | null {
  const r = s.reviews?.[s.reviews.length - 1]
  return r ? r.rating : null
}

export function why(s: Sched, now: number): string {
  const parts: string[] = []
  if (!s.due) {
    parts.push('New, not studied yet.')
  } else {
    const d = (s.due - now) / DAY
    parts.push(d <= 0 ? `Overdue by ${Math.abs(d).toFixed(1)} days.` : `Due in ${d.toFixed(1)} days.`)
    const lr = lastRating(s)
    if (lr) parts.push(`Last rated ${lr}; interval ${(s.stab ?? 0).toFixed(1)} days.`)
    else if (s.stab) parts.push(`Interval ${s.stab.toFixed(1)} days (set manually).`)
  }
  if (s.override !== null && s.override !== undefined) parts.push(`Score set manually to ${Math.round(s.override)}.`)
  return parts.join(' ')
}

/** Manual overrides. */
export function setDue<T extends Sched>(s: T, at: number, now: number): T {
  return { ...s, due: at, stab: s.stab ?? Math.max(0.25, (at - now) / DAY), last: s.last ?? now, evid: s.evid ?? 0.4 }
}
export function markSolid<T extends Sched>(s: T, now: number): T {
  return { ...s, stab: 30, evid: 1, last: now, due: now + 30 * DAY, solidMark: true, override: null }
}
export function resetSched<T extends Sched>(s: T): T {
  return { ...s, stab: null, due: null, last: null, evid: null, reviews: [], spent: 0, override: null, solidMark: false }
}

export interface PickTopic extends Sched {
  id: string
  name: string
  docId: string
  courseId: string
  ord: number
}

export interface PickDeadline {
  title: string
  date: number // ms timestamp of the deadline day
  courseId?: string | null
  docId?: string | null
  topicIds?: string[]
}

export interface PickCtx {
  now: number
  lastTopicId?: string | null
  lastDocId?: string | null
  lastWasReview?: boolean
  deadlines?: PickDeadline[]
}

export const DEADLINE_HORIZON_DAYS = 21

/** Priority added for a topic linked to a deadline: grows linearly from 0 (21 days out) to 1.2 (due today). */
export function deadlinePressure(t: PickTopic, deadlines: PickDeadline[], now: number): { p: number; d?: PickDeadline; days?: number } {
  let best: { p: number; d?: PickDeadline; days?: number } = { p: 0 }
  for (const d of deadlines) {
    const linked = (d.topicIds && d.topicIds.includes(t.id)) || (d.docId && d.docId === t.docId) || (d.courseId && d.courseId === t.courseId)
    if (!linked) continue
    const days = (d.date - now) / DAY
    if (days < -1 || days > DEADLINE_HORIZON_DAYS) continue
    const p = 1.2 * Math.min(1, Math.max(0, 1 - Math.max(0, days) / DEADLINE_HORIZON_DAYS))
    if (p > best.p) best = { p, d, days }
  }
  return best
}

export function scoreTopic(t: PickTopic, ctx: PickCtx): Suggestion {
  const now = ctx.now
  let score: number
  let reason: string
  if (!t.due) {
    score = 0.8 + (ctx.lastWasReview ? 0.3 : 0)
    reason = ctx.lastWasReview ? 'New material, mixed in after a review.' : 'New material.'
  } else if (t.due <= now) {
    const stabMs = Math.max(0.25, t.stab ?? 0.5) * DAY
    const ratio = (now - t.due) / stabMs
    score = 1 + Math.min(ratio, 3)
    const lr = lastRating(t)
    reason = `Overdue by ${((now - t.due) / DAY).toFixed(1)} days${lr ? `; last rated ${lr}` : ''}.`
  } else {
    const R = recall(t, now)
    score = (1 - R) * 0.5
    reason = `Not due yet (in ${((t.due - now) / DAY).toFixed(1)} days); estimated recall ${Math.round(R * 100)}%.`
  }
  if (ctx.deadlines?.length) {
    const dp = deadlinePressure(t, ctx.deadlines, now)
    if (dp.p > 0 && dp.d) {
      score += dp.p
      const days = dp.days ?? 0
      reason += ` Deadline "${dp.d.title}" ${days <= 0 ? 'is today' : `in ${Math.ceil(days)} days`}.`
    }
  }
  if (ctx.lastDocId && t.docId === ctx.lastDocId && t.id !== ctx.lastTopicId) {
    score -= 0.3
    reason += ' Same lesson as the last block, so slightly lower.'
  }
  if (ctx.lastTopicId && t.id === ctx.lastTopicId) {
    score -= 9
    reason = 'Just studied; avoided back to back.'
  }
  return { topicId: t.id, name: t.name, score: Math.round(score * 1000) / 1000, reason }
}

export function rank(topics: PickTopic[], ctx: PickCtx): Suggestion[] {
  const scored = topics.map((t) => ({ s: scoreTopic(t, ctx), ord: t.ord }))
  scored.sort((a, b) => b.s.score - a.s.score || a.ord - b.ord)
  return scored.map((x) => x.s)
}
