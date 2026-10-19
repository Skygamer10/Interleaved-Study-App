// Plan calendar, laid out like the month views of Apple Calendar and Google Calendar: month title with
// "‹ Today ›", uniform day cells (weekends shaded, today circled, "Nov 1" on the first of a month), deadline chips
// tinted by course, "N more" opening a day card, double-click or "+" to add a deadline on that day.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Deadline } from '../../../shared/types'
import { dayKey, parseDayKey } from '../../../shared/util'
import { courseClass, useApp } from '../state'
import { Icon } from '../icons'
import { fmtMin } from '../ui'
import { deadlineCourseId, monthWeeks, visibleCount, weekInfo, weekdayOrder } from '../calendar'

interface Props {
  deadlines: Deadline[]
  studied: Map<string, number> // minutes studied per day key
  onAdd: (date: string) => void
  onOpen: (d: Deadline) => void
}

interface MoreCard { key: string; top: number; left: number; width: number }

export function Calendar({ deadlines, studied, onAdd, onOpen }: Props) {
  const { courses, docs, topics } = useApp()
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [more, setMore] = useState<MoreCard | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const wk = useMemo(() => weekInfo(), [])
  const order = weekdayOrder(wk.firstDay)
  const weeks = monthWeeks(cursor.getFullYear(), cursor.getMonth(), wk.firstDay)
  const today = dayKey()

  const byDay = useMemo(() => {
    const m = new Map<string, Deadline[]>()
    for (const d of deadlines) m.set(d.date, [...(m.get(d.date) ?? []), d])
    for (const list of m.values()) list.sort((a, b) => a.title.localeCompare(b.title))
    return m
  }, [deadlines])
  const courseOf = (d: Deadline) => { const id = deadlineCourseId(d, docs, topics); return id ? courses.get(id) : undefined }

  // Courses that appear in the visible weeks, for the legend
  const shownKeys = weeks.flat().map((d) => dayKey(d))
  const shown = shownKeys.flatMap((k) => byDay.get(k) ?? [])
  const legend = [...new Map(shown.map((d) => courseOf(d)).filter((c) => !!c).map((c) => [c!.id, c!])).values()].sort((a, b) => a.name.localeCompare(b.name))
  const anyUnlinked = shown.some((d) => !courseOf(d))
  const anyStudied = shownKeys.some((k) => (studied.get(k) ?? 0) > 0)

  const go = (delta: number): void => { setMore(null); setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1)) }
  const goToday = (): void => { setMore(null); const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)) }

  useEffect(() => {
    if (!more) return
    const down = (e: globalThis.MouseEvent): void => { if (!cardRef.current?.contains(e.target as Node)) setMore(null) }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setMore(null) } }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true) }
  }, [more])

  /** Google-style day card, placed over the cell and kept inside the calendar's width. */
  const openMore = (k: string, e: MouseEvent<HTMLElement>): void => {
    const cell = (e.currentTarget as HTMLElement).closest('.cal-cell')
    const wrap = wrapRef.current
    if (!cell || !wrap) return
    const c = cell.getBoundingClientRect(), w = wrap.getBoundingClientRect()
    const width = Math.min(w.width, Math.max(240, c.width + 32))
    setMore({ key: k, width, top: c.top - w.top - 6, left: Math.min(Math.max(0, c.left - w.left - 16), w.width - width) })
  }

  const chip = (d: Deadline, onClick?: () => void) => {
    const c = courseOf(d)
    return (
      <button key={d.id} className={`cal-ev ${c ? courseClass(c) : 'nolink'}${d.date < today ? ' past' : ''}`}
        title={`${d.title}${c ? ` · ${c.name}` : ''}${d.notes ? `\n${d.notes}` : ''}`}
        onClick={() => { onClick?.(); onOpen(d) }}>
        <span>{d.title}</span>
      </button>
    )
  }

  const card = more ? (() => {
    const date = parseDayKey(more.key)
    const list = byDay.get(more.key) ?? []
    const m = studied.get(more.key) ?? 0
    return (
      <div ref={cardRef} className="cal-card" style={{ top: more.top, left: more.left, width: more.width }} role="dialog" aria-label={`Deadlines on ${date.toLocaleDateString(undefined, { dateStyle: 'full' })}`}>
        <div className="cal-card-h">
          <span className="dow">{date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
          <span className={`dn${more.key === today ? ' today' : ''}`}>{date.getDate()}</span>
          {m > 0 && <span className="cal-study">{fmtMin(m)} studied</span>}
          <button className="btn ghost icon" aria-label="Close" onClick={() => setMore(null)}><Icon.close size={14} /></button>
        </div>
        {list.map((d) => chip(d, () => setMore(null)))}
        <button className="cal-more" style={{ marginTop: 4 }} onClick={() => { setMore(null); onAdd(more.key) }}><Icon.plus size={12} /> Add deadline</button>
      </div>
    )
  })() : null

  return (
    <div className="cal-wrap" ref={wrapRef}>
      <div className="cal-head">
        <h2 className="cal-title"><b>{cursor.toLocaleDateString(undefined, { month: 'long' })}</b> {cursor.getFullYear()}</h2>
        <div className="cal-nav">
          <button className="btn ghost icon" aria-label="Previous month" onClick={() => go(-1)}><Icon.chevron className="flip" size={14} /></button>
          <button className="btn" onClick={goToday}>Today</button>
          <button className="btn ghost icon" aria-label="Next month" onClick={() => go(1)}><Icon.chevron size={14} /></button>
        </div>
      </div>
      <div className="cal" aria-label={`${cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })} calendar`}>
        <div className="cal-dow">
          {order.map((n) => (
            <div key={n} className={wk.weekend.includes(n) ? 'wknd' : ''}>{new Date(2024, 0, 7 + n).toLocaleDateString(undefined, { weekday: 'short' })}</div>
          ))}
        </div>
        <div className="cal-grid">
          {weeks.flat().map((d) => {
            const k = dayKey(d)
            const list = byDay.get(k) ?? []
            const n = visibleCount(list.length)
            const m = studied.get(k) ?? 0
            const cls = ['cal-cell', d.getMonth() !== cursor.getMonth() && 'out', wk.weekend.includes(d.getDay()) && 'wknd', k === today && 'today'].filter(Boolean).join(' ')
            const long = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
            return (
              <div key={k} className={cls} onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) onAdd(k) }}>
                <div className="cal-cell-h">
                  <button className="cal-add" tabIndex={-1} aria-label={`Add a deadline on ${long}`} title="Add a deadline (or double-click the day)" onClick={() => onAdd(k)}><Icon.plus size={12} /></button>
                  {m > 0 && <span className="cal-study" title={`${fmtMin(m)} studied`}>{fmtMin(m)}</span>}
                  <span className="cal-date" aria-label={long}>
                    {d.getDate() === 1 && <span className="mon">{d.toLocaleDateString(undefined, { month: 'short' })}</span>}
                    <span className="dn">{d.getDate()}</span>
                  </span>
                </div>
                {list.slice(0, n).map((x) => chip(x))}
                {list.length > n && <button className="cal-more" onClick={(e) => openMore(k, e)}>{list.length - n} more</button>}
              </div>
            )
          })}
        </div>
      </div>
      {(legend.length > 0 || anyUnlinked || anyStudied) && (
        <div className="cal-legend">
          {legend.map((c) => <span key={c.id} className={courseClass(c)}><i />{c.name}</span>)}
          {anyUnlinked && <span className="nolink"><i />No course</span>}
          {anyStudied && <span><span className="cal-study">45m</span>time studied that day</span>}
        </div>
      )}
      {card}
    </div>
  )
}
