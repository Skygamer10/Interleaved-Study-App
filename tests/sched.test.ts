import { describe, expect, it } from 'vitest'
import { applyReview, categorize, combinedEvidence, deadlinePressure, markSolid, mastery, nextStability, rank, resetSched, setDue, status, why, type PickTopic } from '../src/shared/sched'
import { computeStreak } from '../src/shared/streak'
import type { Sched } from '../src/shared/types'
import { DAY, addDays, addTime } from '../src/shared/util'

const NOW = Date.UTC(2026, 9, 11, 12)
const blank = (): Sched => ({ reviews: [], spent: 0 })

describe('evidence and stability', () => {
  it('combines self rating and quiz with the quiz weighing double', () => {
    expect(combinedEvidence('okay')).toBe(0.7)
    expect(combinedEvidence('solid', 0.25)).toBeCloseTo((1 + 0.5) / 3)
    expect(categorize(0.2)).toBe('lost')
    expect(categorize(0.5)).toBe('shaky')
    expect(categorize(0.84)).toBe('okay')
    expect(categorize(0.85)).toBe('solid')
  })
  it('computes new stability from the old one with floors', () => {
    expect(nextStability('lost', 10)).toBe(3)
    expect(nextStability('lost', 0.5)).toBe(0.25)
    expect(nextStability('shaky', undefined)).toBe(0.6)
    expect(nextStability('okay', 2)).toBeCloseTo(4.4)
    expect(nextStability('solid', 0.5)).toBe(3)
    expect(nextStability('solid', 4)).toBe(14)
  })
})

describe('reviews, mastery and status', () => {
  it('applies a review, sets due and clears an override', () => {
    const s = applyReview({ ...blank(), override: 90 }, { rating: 'okay', minutes: 30, at: NOW })
    expect(s.stab).toBe(1.1)
    expect(s.due).toBe(NOW + 1.1 * DAY)
    expect(s.override).toBeNull()
    expect(s.reviews).toHaveLength(1)
    expect(s.spent).toBe(30)
  })
  it('uses the quiz to change the category', () => {
    const s = applyReview(blank(), { rating: 'solid', quiz: 0.2, minutes: 10, at: NOW })
    expect(s.reviews[0].rating).toBe('shaky')
    expect(s.reviews[0].self).toBe('solid')
  })
  it('a skipped rating records time only', () => {
    const s = applyReview(blank(), { rating: null, minutes: 12, at: NOW })
    expect(s.reviews).toHaveLength(0)
    expect(s.spent).toBe(12)
    expect(status(s, NOW)).toBe('new')
  })
  it('mastery = 100 * R * evid * confidence and decays with time', () => {
    let s = applyReview(blank(), { rating: 'solid', minutes: 5, at: NOW })
    expect(mastery(s, NOW)).toBe(Math.round(100 * 1 * 1 * (0.6 + 0.4 / 3)))
    s = applyReview(s, { rating: 'solid', minutes: 5, at: NOW })
    s = applyReview(s, { rating: 'solid', minutes: 5, at: NOW })
    expect(mastery(s, NOW)).toBe(100)
    const later = NOW + (s.stab as number) * DAY
    expect(mastery(s, later)).toBe(90)
    expect(status(s, NOW)).toBe('solid')
  })
  it('derives status: new, in progress, needs review', () => {
    const s = applyReview(blank(), { rating: 'shaky', minutes: 5, at: NOW })
    expect(status(blank(), NOW)).toBe('new')
    expect(status(s, NOW + 0.1 * DAY)).toBe('progress')
    expect(status(s, NOW + 2 * DAY)).toBe('review')
  })
  it('explains why a topic is due', () => {
    const s = applyReview(blank(), { rating: 'shaky', minutes: 5, at: NOW })
    expect(why(s, NOW + 0.6 * DAY + 2.3 * DAY)).toBe('Overdue by 2.3 days. Last rated shaky; interval 0.6 days.')
    expect(why(s, NOW)).toMatch(/^Due in 0\.6 days\./)
    expect(why(blank(), NOW)).toMatch(/New/)
  })
  it('supports overrides: due date, solid, reset and score', () => {
    const d = setDue(blank(), NOW + 3 * DAY, NOW)
    expect(d.due).toBe(NOW + 3 * DAY)
    const solid = markSolid(blank(), NOW)
    expect(solid.stab).toBe(30)
    expect(status(solid, NOW)).toBe('solid')
    const r = resetSched(applyReview(blank(), { rating: 'okay', minutes: 5, at: NOW }))
    expect(status(r, NOW)).toBe('new')
    expect(mastery({ ...blank(), override: 42 }, NOW)).toBe(42)
  })
})

describe('next-topic picker', () => {
  const t = (id: string, docId: string, s: Partial<Sched> = {}, ord = 0): PickTopic => ({ id, name: id, docId, courseId: 'c', ord, reviews: [], spent: 0, ...s })
  it('prefers overdue, mixes in new material, avoids repeats and same lesson', () => {
    const overdue = t('over', 'd1', { stab: 1, due: NOW - 2 * DAY, last: NOW - 3 * DAY, evid: 0.4, reviews: [{ at: NOW - 3 * DAY, rating: 'shaky', minutes: 5 }] })
    const fresh = t('new', 'd2')
    const notDue = t('later', 'd3', { stab: 10, due: NOW + 5 * DAY, last: NOW - 5 * DAY, evid: 1, reviews: [{ at: NOW - 5 * DAY, rating: 'solid', minutes: 5 }] })
    let r = rank([overdue, fresh, notDue], { now: NOW })
    expect(r[0].topicId).toBe('over')
    expect(r[0].score).toBe(3)
    expect(r[1].topicId).toBe('new')
    r = rank([overdue, fresh, notDue], { now: NOW, lastTopicId: 'over', lastDocId: 'd1', lastWasReview: true })
    expect(r[0].topicId).toBe('new')
    expect(r[0].score).toBeCloseTo(1.1)
    expect(r[r.length - 1].topicId).toBe('over')
    const same = rank([t('a', 'd1'), t('b', 'd2', {}, 1)], { now: NOW, lastDocId: 'd1', lastTopicId: 'x' })
    expect(same[0].topicId).toBe('b')
    expect(same[1].reason).toMatch(/Same lesson/)
  })
  it('adds deadline pressure that grows as the deadline approaches', () => {
    const a = t('a', 'd1'), b = t('b', 'd2')
    const near = deadlinePressure(a, [{ title: 'Exam', date: NOW + 2 * DAY, docId: 'd1' }], NOW).p
    const far = deadlinePressure(a, [{ title: 'Exam', date: NOW + 15 * DAY, docId: 'd1' }], NOW).p
    expect(near).toBeGreaterThan(far)
    expect(deadlinePressure(b, [{ title: 'Exam', date: NOW + 2 * DAY, docId: 'd1' }], NOW).p).toBe(0)
    const r = rank([b, a], { now: NOW, deadlines: [{ title: 'Exam', date: NOW + 2 * DAY, docId: 'd1' }] })
    expect(r[0].topicId).toBe('a')
    expect(r[0].reason).toMatch(/Deadline "Exam" in 2 days/)
  })
})

describe('streak with rest days', () => {
  const today = '2026-10-11'
  const days = (offsets: number[]): Set<string> => new Set(offsets.map((o) => addDays(today, -o)))
  it('counts consecutive days and does not break on an unfinished today', () => {
    expect(computeStreak(days([0, 1, 2]), today, 1).current).toBe(3)
    expect(computeStreak(days([1, 2, 3]), today, 1).current).toBe(3)
  })
  it('allows one rest day per week but not two in a row', () => {
    const s = computeStreak(days([0, 1, 3, 4, 5]), today, 1)
    expect(s.current).toBe(6)
    expect(s.restUsed).toBe(1)
    expect(computeStreak(days([0, 1, 4, 5]), today, 1).current).toBe(2)
    expect(computeStreak(days([0, 2, 4]), today, 1).current).toBe(3) // a second rest within 7 days ends it
    expect(computeStreak(days([0, 2, 4]), today, 2).current).toBe(5)
    expect(computeStreak(days([0, 1, 3]), today, 0).current).toBe(2)
  })
  it('reports the best streak', () => {
    expect(computeStreak(days([0, 10, 11, 12, 13]), today, 1).best).toBe(4)
  })
})

describe('addTime', () => {
  it('adds minutes, hours, days and calendar months', () => {
    const t = new Date(2026, 0, 31, 9, 0).getTime()
    expect(addTime(t, 90, 'minutes')).toBe(t + 90 * 60000)
    expect(addTime(t, 2, 'hours')).toBe(t + 2 * 3600000)
    expect(addTime(t, 3, 'days')).toBe(t + 3 * DAY)
    const m = new Date(addTime(t, 1, 'months'))
    expect([m.getFullYear(), m.getMonth(), m.getDate(), m.getHours()]).toEqual([2026, 1, 28, 9]) // Jan 31 + 1 month clamps to Feb 28
  })
})
