// Month-view date math for the Plan calendar. Pure, so it is unit-tested; the component is components/Calendar.tsx.
import type { Deadline } from '../../shared/types'

export interface WeekInfo {
  firstDay: number // 0 = Sunday … 6 = Saturday
  weekend: number[] // same numbering
}

type IntlWeekInfo = { firstDay: number; weekend: number[] }

/**
 * First day of the week and weekend days for a locale, the way Apple Calendar and Google Calendar follow the system
 * setting. Intl numbers days 1 = Monday … 7 = Sunday; older engines expose `weekInfo` instead of `getWeekInfo()`.
 */
export function weekInfo(locale?: string): WeekInfo {
  try {
    const loc = new Intl.Locale(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) as Intl.Locale & {
      getWeekInfo?: () => IntlWeekInfo
      weekInfo?: IntlWeekInfo
    }
    const info = loc.getWeekInfo?.() ?? loc.weekInfo
    if (info?.firstDay) return { firstDay: info.firstDay % 7, weekend: (info.weekend ?? [6, 7]).map((d) => d % 7) }
  } catch { /* unknown locale */ }
  return { firstDay: 1, weekend: [6, 0] }
}

/** The weeks shown for a month: only as many rows as the month needs (4 to 6), each starting on `firstDay`. */
export function monthWeeks(year: number, month: number, firstDay: number): Date[][] {
  const lead = (new Date(year, month, 1).getDay() - firstDay + 7) % 7
  const days = new Date(year, month + 1, 0).getDate()
  const rows = Math.ceil((lead + days) / 7)
  // Built from calendar fields, not milliseconds, so daylight-saving changes never skip or repeat a day.
  return Array.from({ length: rows }, (_, w) => Array.from({ length: 7 }, (_, i) => new Date(year, month, 1 - lead + w * 7 + i)))
}

/** Weekday numbers (0 = Sunday) in display order. */
export function weekdayOrder(firstDay: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (firstDay + i) % 7)
}

/** The course a deadline belongs to: its own course, else its lesson's, else its first linked topic's. */
export function deadlineCourseId(d: Deadline, docs: Map<string, { courseId: string }>, topics: Map<string, { courseId: string }>): string | null {
  return d.courseId ?? (d.docId ? docs.get(d.docId)?.courseId : undefined) ?? (d.topicIds?.length ? topics.get(d.topicIds[0])?.courseId : undefined) ?? null
}

/** Chips that fit in a day cell: all of them up to `max`; past that, one row is given to "N more". */
export function visibleCount(total: number, max = 3): number {
  return total > max ? max - 1 : total
}
