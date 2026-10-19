// Streaks that do not punish a missed day: a limited number of rest days per rolling 7 days keeps the streak alive.
import { addDays, dayKey } from './util'

export interface StreakInfo {
  current: number // calendar days in the streak (studied days plus allowed rest days)
  studied: number // studied days in the current streak
  restUsed: number // rest days used inside the current streak
  best: number // best streak (calendar days) in the given history
}

export function computeStreak(studiedDays: Set<string>, today = dayKey(), restPerWeek = 1): StreakInfo {
  // Today not studied yet does not break anything; start from yesterday in that case.
  let cursor = studiedDays.has(today) ? today : addDays(today, -1)
  const rests: string[] = []
  let current = 0
  let studied = 0
  let pendingRest: string[] = []
  // Walk backwards.
  for (let i = 0; i < 3660; i++) {
    if (studiedDays.has(cursor)) {
      current += 1 + pendingRest.length
      rests.push(...pendingRest)
      pendingRest = []
      studied++
    } else {
      // Rest days in the 7-day window ending at the most recent counted rest day
      const windowRests = [...rests, ...pendingRest].filter((r) => Math.abs(diff(r, cursor)) < 7)
      if (windowRests.length < restPerWeek && studied > 0) {
        pendingRest.push(cursor)
      } else break
    }
    cursor = addDays(cursor, -1)
  }
  return { current, studied, restUsed: rests.length, best: Math.max(current, bestStreak(studiedDays, restPerWeek)) }
}

function diff(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
}

function bestStreak(days: Set<string>, restPerWeek: number): number {
  if (days.size === 0) return 0
  const sorted = [...days].sort()
  let best = 0
  for (const end of sorted) {
    const s = computeStreakEndingAt(days, end, restPerWeek)
    if (s > best) best = s
  }
  return best
}

function computeStreakEndingAt(days: Set<string>, end: string, restPerWeek: number): number {
  let cursor = end
  let current = 0
  const rests: string[] = []
  let pending: string[] = []
  for (let i = 0; i < 3660; i++) {
    if (days.has(cursor)) {
      current += 1 + pending.length
      rests.push(...pending)
      pending = []
    } else {
      const w = [...rests, ...pending].filter((r) => Math.abs(diff(r, cursor)) < 7)
      if (w.length < restPerWeek && current > 0) pending.push(cursor)
      else break
    }
    cursor = addDays(cursor, -1)
  }
  return current
}
