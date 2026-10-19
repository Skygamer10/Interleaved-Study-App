import { describe, expect, it } from 'vitest'
import { deadlineCourseId, monthWeeks, visibleCount, weekInfo, weekdayOrder } from '../src/renderer/src/calendar'
import { dayKey } from '../src/shared/util'
import type { Deadline } from '../src/shared/types'

const keys = (weeks: Date[][]): string[][] => weeks.map((w) => w.map((d) => dayKey(d)))

describe('month view grid', () => {
  it('shows only the weeks a month needs, starting on the chosen weekday', () => {
    // October 2026 starts on a Thursday
    const mon = keys(monthWeeks(2026, 9, 1))
    expect(mon).toHaveLength(5)
    expect(mon[0][0]).toBe('2026-09-28')
    expect(mon[0][3]).toBe('2026-10-01')
    expect(mon[4][6]).toBe('2026-11-01')
    const sun = keys(monthWeeks(2026, 9, 0))
    expect(sun[0][0]).toBe('2026-09-27')
    expect(sun[0][4]).toBe('2026-10-01')
    // February 2026 starts on a Sunday and has 28 days: exactly four weeks when weeks start on Sunday
    expect(monthWeeks(2026, 1, 0)).toHaveLength(4)
    // August 2026 (starts Saturday, 31 days) needs six Monday-first weeks
    expect(monthWeeks(2026, 7, 1)).toHaveLength(6)
  })

  it('never skips or repeats a day across a daylight-saving change', () => {
    const all = keys(monthWeeks(2026, 2, 0)).flat() // March: clocks change in many regions
    expect(new Set(all).size).toBe(all.length)
    for (let i = 1; i < all.length; i++) {
      expect(new Date(`${all[i]}T12:00:00`).getTime() - new Date(`${all[i - 1]}T12:00:00`).getTime()).toBeLessThanOrEqual(25 * 3600e3)
    }
  })

  it('orders weekdays from the first day of the week', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('follows the locale for the first day of the week, like Apple and Google Calendar', () => {
    expect(weekInfo('en-US').firstDay).toBe(0)
    expect(weekInfo('en-GB').firstDay).toBe(1)
    expect(weekInfo('de-DE').weekend.sort()).toEqual([0, 6])
    expect(weekInfo('not a locale!').firstDay).toBe(1)
  })
})

describe('deadline chips', () => {
  const docs = new Map([['doc1', { courseId: 'bio' }]])
  const topics = new Map([['t1', { courseId: 'chem' }]])
  const base: Deadline = { id: 'x', title: 'Essay', date: '2026-10-20', key: 'k', createdAt: 0 }

  it('takes the course from the deadline, then its lesson, then its first topic', () => {
    expect(deadlineCourseId({ ...base, courseId: 'hist', docId: 'doc1' }, docs, topics)).toBe('hist')
    expect(deadlineCourseId({ ...base, docId: 'doc1' }, docs, topics)).toBe('bio')
    expect(deadlineCourseId({ ...base, topicIds: ['t1'] }, docs, topics)).toBe('chem')
    expect(deadlineCourseId(base, docs, topics)).toBeNull()
  })

  it('keeps at most three rows in a day, giving one to "N more" when there are more', () => {
    expect(visibleCount(0)).toBe(0)
    expect(visibleCount(3)).toBe(3)
    expect(visibleCount(4)).toBe(2)
    expect(visibleCount(9)).toBe(2)
  })
})
