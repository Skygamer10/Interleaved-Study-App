// Plan: flexible daily goal (never nags), streak with rest days, deadlines (agenda + month calendar),
// and spreadsheet import: converted to Markdown with markitdown and read by the AI, with a review step and
// manual column mapping (preview and row validation) as the alternative.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Deadline, DeadlineExtract, DeadlineInput, SheetData } from '../../../shared/types'
import { deadlineKey, guessMapping, mapRows, type ColumnMapping, type DateFormat } from '../../../shared/deadlineMap'
import { computeStreak } from '../../../shared/streak'
import { addDays, dayKey, daysBetween, parseDayKey } from '../../../shared/util'
import { api, errMsg } from '../api'
import { useAction, useApp } from '../state'
import { Icon } from '../icons'
import { Confirm, Deck, Modal, Spinner, fmtMin } from '../ui'
import { Calendar } from '../components/Calendar'

function colName(i: number): string {
  let s = ''
  let n = i + 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

function SheetImport({ sheet, onClose }: { sheet: SheetData; onClose: () => void }) {
  const { data } = useApp()
  const act = useAction()
  const [si, setSi] = useState(0)
  const rows = sheet.sheets[si]?.rows ?? []
  const [map, setMap] = useState<ColumnMapping>(() => guessMapping(rows[0] ?? []))
  const width = Math.max(1, ...rows.slice(0, 50).map((r) => r.length))
  const header = map.headerRow ? rows[0] ?? [] : []
  const label = (i: number): string => `${colName(i)}${header[i] !== undefined && header[i] !== null && String(header[i]).trim() ? `: ${String(header[i]).slice(0, 30)}` : ''}`
  const existing = useMemo(() => new Set((data?.deadlines ?? []).map((d) => d.key)), [data])
  const result = useMemo(() => mapRows(rows, map, existing), [rows, map, existing])
  const set = (p: Partial<ColumnMapping>): void => setMap((m) => ({ ...m, ...p }))
  const colSelect = (k: 'title' | 'date' | 'course' | 'notes', optional: boolean) => (
    <select className="input" value={map[k] ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? null : Number(e.target.value) } as Partial<ColumnMapping>)}>
      {optional && <option value="">Not used</option>}
      {Array.from({ length: width }, (_, i) => <option key={i} value={i}>{label(i)}</option>)}
    </select>
  )
  const doImport = async (): Promise<void> => {
    const items: DeadlineInput[] = result.valid.map((r) => ({ title: r.title, date: r.date, courseName: r.course, notes: r.notes }))
    const res = await act(() => api.importDeadlines(items))
    if (res) { onClose(); }
  }
  const errRows = new Map(result.errors.map((e) => [e.row, e.error]))
  const validRows = new Map(result.valid.map((v) => [v.row, v]))
  return (
    <Modal title="Import deadlines" wide onClose={onClose} footer={<>
      <span className="muted" style={{ marginRight: 'auto' }}>{result.valid.length} ready, {result.errors.length} with problems, {result.duplicates} duplicates skipped</span>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!result.valid.length} onClick={() => void doImport()}>Import {result.valid.length} deadline{result.valid.length === 1 ? '' : 's'}</button>
    </>}>
      <div className="muted small">{sheet.path}</div>
      <div className="grid3">
        {sheet.sheets.length > 1 && <label className="field"><span>Sheet</span><select className="input" value={si} onChange={(e) => { const n = Number(e.target.value); setSi(n); setMap(guessMapping(sheet.sheets[n].rows[0] ?? [])) }}>{sheet.sheets.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}</select></label>}
        <label className="field"><span>Title column</span>{colSelect('title', false)}</label>
        <label className="field"><span>Date column</span>{colSelect('date', false)}</label>
        <label className="field"><span>Course column</span>{colSelect('course', true)}</label>
        <label className="field"><span>Notes column</span>{colSelect('notes', true)}</label>
        <label className="field"><span>Date format for numbers like 03/04/2026</span>
          <select className="input" value={map.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}>
            <option value="auto">Detect (day/month when unclear)</option><option value="DMY">Day/month/year</option><option value="MDY">Month/day/year</option><option value="YMD">Year-month-day only</option>
          </select>
        </label>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={map.headerRow} onChange={(e) => set({ headerRow: e.target.checked })} /><span>First row is a header</span></label>
      </div>
      <p className="help">Rows already imported (same title, date and course) are skipped, so re-importing the same sheet is safe. Course names that match an existing course are linked to it.</p>
      <div style={{ maxHeight: 340, overflow: 'auto' }}>
        <table className="table">
          <thead><tr><th>Row</th><th>Title</th><th>Date</th><th>Course</th><th>Check</th></tr></thead>
          <tbody>
            {rows.slice(map.headerRow ? 1 : 0, 200).map((r, i) => {
              const rowNo = i + 1 + (map.headerRow ? 1 : 0)
              const v = validRows.get(rowNo)
              const err = errRows.get(rowNo)
              return (
                <tr key={rowNo} className={err ? 'err' : ''}>
                  <td className="num muted">{rowNo}</td>
                  <td>{String(r[map.title] ?? '')}</td>
                  <td className="num">{v ? v.date : String(r[map.date] ?? '')}</td>
                  <td>{map.course !== null ? String(r[map.course] ?? '') : ''}</td>
                  <td className="small">{err ?? (v ? (v.warning ?? 'OK') : 'Duplicate or empty')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}

/**
 * Spreadsheet → markitdown → AI. Starts as soon as it opens; the person reviews what was found before anything is
 * added. "Map columns manually" switches to the column-mapping import for the same file.
 */
function AiSheetImport({ sheet, onManual, onClose }: { sheet: SheetData; onManual: () => void; onClose: () => void }) {
  const { data, setView } = useApp()
  const act = useAction()
  const [res, setRes] = useState<DeadlineExtract | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skip, setSkip] = useState<Set<number>>(new Set())
  const started = useRef(false)
  const existing = useMemo(() => new Set((data?.deadlines ?? []).map((d) => d.key)), [data])
  useEffect(() => {
    if (started.current) return
    started.current = true
    api.extractDeadlines(sheet.path).then((r) => {
      setRes(r)
      setSkip(new Set(r.items.flatMap((it, i) => (existing.has(deadlineKey(it.title, it.date, it.courseName)) ? [i] : []))))
    }, (e) => setError(errMsg(e)))
  }, [sheet.path, existing])
  const dup = (i: number): boolean => !!res && existing.has(deadlineKey(res.items[i].title, res.items[i].date, res.items[i].courseName))
  const chosen = res ? res.items.filter((_, i) => !skip.has(i)) : []
  const toggle = (i: number): void => setSkip((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n })
  const doImport = async (): Promise<void> => {
    const r = await act(() => api.importDeadlines(chosen.map((it) => ({ title: it.title, date: it.date, courseName: it.courseName, notes: it.notes }))))
    if (r) onClose()
  }
  const noKey = !!error && /API key/i.test(error)
  return (
    <Modal title="Import deadlines" wide onClose={onClose} footer={<>
      {res && <span className="muted" style={{ marginRight: 'auto' }}>{res.items.length} found{res.dropped ? `, ${res.dropped} skipped without a usable date` : ''}</span>}
      <button className="btn ghost" style={res ? undefined : { marginRight: 'auto' }} onClick={onManual}>Map columns manually</button>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!chosen.length} onClick={() => void doImport()}>Import {chosen.length} deadline{chosen.length === 1 ? '' : 's'}</button>
    </>}>
      <div className="muted small">{sheet.path}</div>
      {!res && !error && <p className="row-flex"><Spinner /> Converting the spreadsheet to Markdown with markitdown and asking the AI to find the deadlines…</p>}
      {error && (
        <div>
          <p className="err-text sel">{error}</p>
          {noKey ? <button className="btn primary" onClick={() => { onClose(); setView('settings') }}>Open Settings</button> : <p className="help">You can still import this file by mapping its columns manually.</p>}
        </div>
      )}
      {res && (
        <>
          <p className="help">
            {res.converter === 'markitdown' ? 'Converted with markitdown' : 'Converted with the built-in converter'}
            {res.chunks > 1 ? ` and read in ${res.chunks} parts` : ''}. Check the dates before importing; untick anything you don’t want. Deadlines you already have are unticked.
          </p>
          {res.converterNote && <div className="notice">{res.converterNote}</div>}
          {res.items.length === 0 ? <p className="muted">The AI found no dated items in this spreadsheet. Try mapping its columns manually.</p> : (
            <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
              <table className="table">
                <thead><tr><th></th><th>Title</th><th>Date</th><th>Course</th><th>Notes</th></tr></thead>
                <tbody>
                  {res.items.map((it, i) => (
                    <tr key={i}>
                      <td><input type="checkbox" checked={!skip.has(i)} onChange={() => toggle(i)} aria-label={`Import ${it.title}`} /></td>
                      <td>{it.title}{dup(i) && <span className="muted small"> · already added</span>}</td>
                      <td className="num">{parseDayKey(it.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td>{it.courseName ?? ''}</td>
                      <td className="small">{it.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

function DeadlineForm({ initial, defaultDate, onClose }: { initial?: Deadline; defaultDate?: string; onClose: () => void }) {
  const { data } = useApp()
  const act = useAction()
  const [title, setTitle] = useState(initial?.title ?? '')
  const [date, setDate] = useState(initial?.date ?? defaultDate ?? addDays(dayKey(), 14))
  const [link, setLink] = useState<'none' | 'course' | 'lesson' | 'topics'>(initial?.topicIds?.length ? 'topics' : initial?.docId ? 'lesson' : initial?.courseId ? 'course' : 'none')
  const [courseId, setCourseId] = useState(initial?.courseId ?? data?.courses[0]?.id ?? '')
  const [docId, setDocId] = useState(initial?.docId ?? data?.docs[0]?.id ?? '')
  const [topicIds, setTopicIds] = useState<string[]>(initial?.topicIds ?? [])
  const [filter, setFilter] = useState('')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const save = async (): Promise<void> => {
    const payload = {
      title, date, notes,
      courseId: link === 'course' ? courseId : null, docId: link === 'lesson' ? docId : null, topicIds: link === 'topics' ? topicIds : []
    }
    const ok = await act(() => (initial ? api.updateDeadline(initial.id, payload) : api.addDeadline(payload)).then(() => true), initial ? 'Deadline saved' : 'Deadline added')
    if (ok !== undefined) onClose()
  }
  return (
    <Modal title={initial ? 'Edit deadline' : 'Add a deadline'} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!title.trim() || !date} onClick={() => void save()}>{initial ? 'Save deadline' : 'Add deadline'}</button>
    </>}>
      <div className="grid2">
        <label className="field"><span>Title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Biochemistry midterm" /></label>
        <label className="field"><span>Date</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      </div>
      <label className="field"><span>Gives priority to</span>
        <select className="input" value={link} onChange={(e) => setLink(e.target.value as typeof link)}>
          <option value="none">Nothing (reminder only)</option><option value="course">A course</option><option value="lesson">A lesson</option><option value="topics">Chosen topics</option>
        </select>
      </label>
      {link === 'course' && <select className="input" value={courseId} onChange={(e) => setCourseId(e.target.value)}>{data?.courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      {link === 'lesson' && <select className="input" value={docId} onChange={(e) => setDocId(e.target.value)}>{data?.docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select>}
      {link === 'topics' && (
        <>
          <input className="input" placeholder="Filter topics" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="pick-list">{data?.topics.filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 300).map((t) => (
            <label key={t.id} className="check"><input type="checkbox" checked={topicIds.includes(t.id)} onChange={() => setTopicIds((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))} /><span><span className="serif">{t.name}</span> <Deck topicId={t.id} /></span></label>
          ))}</div>
        </>
      )}
      <label className="field"><span>Notes</span><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
    </Modal>
  )
}

function countdown(date: string): string {
  const d = daysBetween(dayKey(), date)
  if (d === 0) return 'today'
  if (d === 1) return 'tomorrow'
  if (d < 0) return `${-d} days ago`
  return `in ${d} days`
}

export function Plan() {
  const { data, settings, saveSettings, courses, docs } = useApp()
  const act = useAction()
  const [sheet, setSheet] = useState<SheetData | null>(null)
  const [manual, setManual] = useState(false)
  const [form, setForm] = useState<Deadline | 'new' | null>(null)
  const [newDate, setNewDate] = useState<string | undefined>(undefined) // set when adding from a calendar day
  const [del, setDel] = useState<Deadline | null>(null)
  const [showPast, setShowPast] = useState(false)
  if (!data || !settings) return null
  const today = dayKey()
  const todayRec = data.daily.find((d) => d.id === today)
  const goal = todayRec?.goal ?? { kind: settings.goal.kind, value: settings.goal.value }
  const done = goal.kind === 'minutes' ? todayRec?.minutes ?? 0 : todayRec?.topics ?? 0
  const studiedDays = new Set(data.daily.filter((d) => d.minutes > 0).map((d) => d.id))
  const streak = computeStreak(studiedDays, today, settings.goal.restDaysPerWeek)
  const studied = new Map(data.daily.map((d) => [d.id, d.minutes]))
  const upcoming = data.deadlines.filter((d) => showPast || d.date >= today)
  const linkText = (d: Deadline): string => d.topicIds?.length ? `${d.topicIds.length} topic(s)` : d.docId ? docs.get(d.docId)?.title ?? '' : d.courseId ? courses.get(d.courseId)?.name ?? '' : ''

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Plan</h1>
        <div className="cols">
          <div>
            <h2>Today</h2>
            <div className="statline" style={{ marginBottom: 10 }}>
              <div className="stat"><b>{goal.kind === 'minutes' ? fmtMin(done) : done}</b><span>of {goal.kind === 'minutes' ? fmtMin(goal.value) : `${goal.value} topics`} goal</span></div>
              <div className="stat"><b>{streak.current}</b><span>day streak{streak.restUsed ? `, ${streak.restUsed} rest day${streak.restUsed > 1 ? 's' : ''}` : ''}</span></div>
              <div className="stat"><b>{streak.best}</b><span>best streak</span></div>
            </div>
            <div className="goalbar"><i style={{ width: `${Math.min(100, (100 * done) / Math.max(1, goal.value))}%` }} /></div>
            <p className="help">The goal is a guide, not a rule. {settings.goal.restDaysPerWeek} rest day{settings.goal.restDaysPerWeek === 1 ? '' : 's'} per week keep a streak alive.</p>
            <div className="row-flex">
              <span>Today’s goal</span>
              <select className="input" style={{ width: 'auto' }} value={goal.kind} onChange={(e) => void act(() => api.setDayGoal({ kind: e.target.value as 'minutes' | 'topics', value: goal.value }))}>
                <option value="minutes">minutes</option><option value="topics">topics</option>
              </select>
              <input className="input num" type="number" min={1} style={{ width: 70 }} value={goal.value} onChange={(e) => void act(() => api.setDayGoal({ kind: goal.kind, value: Math.max(1, Number(e.target.value) || 1) }))} aria-label="Goal for today" />
              {todayRec?.goal && <button className="btn ghost small" onClick={() => void act(() => api.setDayGoal(null))}>Use default</button>}
            </div>
            <div className="row-flex" style={{ marginTop: 8 }}>
              <span>Default goal</span>
              <select className="input" style={{ width: 'auto' }} value={settings.goal.kind} onChange={(e) => void saveSettings({ goal: { kind: e.target.value as 'minutes' | 'topics' } })}>
                <option value="minutes">minutes</option><option value="topics">topics</option>
              </select>
              <input className="input num" type="number" min={1} style={{ width: 70 }} value={settings.goal.value} onChange={(e) => void saveSettings({ goal: { value: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Default goal" />
              <span>rest days per week</span>
              <input className="input num" type="number" min={0} max={3} style={{ width: 54 }} value={settings.goal.restDaysPerWeek} onChange={(e) => void saveSettings({ goal: { restDaysPerWeek: Math.max(0, Math.min(3, Number(e.target.value) || 0)) } })} aria-label="Rest days per week" />
            </div>
          </div>
          <div>
            <div className="row-flex" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0, marginRight: 'auto' }}>Deadlines</h2>
              <button className="btn" onClick={() => { setNewDate(undefined); setForm('new') }}><Icon.plus /> Add</button>
              <button className="btn" onClick={() => void act(async () => { const s = await api.openSheet(); if (s) { setManual(false); setSheet(s) } })}><Icon.upload /> Import .xlsx or .csv</button>
            </div>
            {upcoming.length === 0 ? <p className="muted">No upcoming deadlines. Linked deadlines give their topics priority as the date approaches (from three weeks out).</p> : (
              <div className="agenda-scroll"><div className="agenda">
                {upcoming.map((d) => (
                  <div key={d.id} style={{ display: 'contents' }}>
                    <div>{parseDayKey(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' })}</div>
                    <div><span>{d.title}</span>{linkText(d) && <span className="muted small"> ({linkText(d)})</span>}</div>
                    <div className={`num small ${daysBetween(today, d.date) <= 7 && d.date >= today ? 'overdue' : 'muted'}`}>{countdown(d.date)}</div>
                    <div className="row-flex" style={{ gap: 0 }}>
                      <button className="btn ghost icon" aria-label="Edit" onClick={() => setForm(d)}><Icon.edit /></button>
                      <button className="btn ghost icon" aria-label="Delete" onClick={() => setDel(d)}><Icon.trash /></button>
                    </div>
                  </div>
                ))}
              </div></div>
            )}
            <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /><span className="small muted">Show past deadlines</span></label>
          </div>
        </div>
        <div className="block">
          <Calendar deadlines={data.deadlines} studied={studied} onAdd={(d) => { setNewDate(d); setForm('new') }} onOpen={(d) => setForm(d)} />
        </div>
      </div>
      {sheet && (manual
        ? <SheetImport sheet={sheet} onClose={() => setSheet(null)} />
        : <AiSheetImport sheet={sheet} onManual={() => setManual(true)} onClose={() => setSheet(null)} />)}
      {form && <DeadlineForm initial={form === 'new' ? undefined : form} defaultDate={newDate} onClose={() => setForm(null)} />}
      {del && <Confirm title={`Delete "${del.title}"?`} danger confirm="Delete" body={<p>The deadline is removed; topics are not affected.</p>} onNo={() => setDel(null)} onYes={() => { const d = del; setDel(null); void act(() => api.deleteDeadline(d.id)) }} />}
    </div>
  )
}
