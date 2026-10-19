// Topic board: left scope tree with due counts, center pane, right inspector. The center pane opens on a
// shelf of course folders; opening one lists its lessons as dropdowns (lesson > unit > topics). Both follow
// a user layout (sections > groups > courses > lesson folders > lessons) that can be rearranged by drag and
// drop and recoloured; see ../layout.ts.
import { useEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import type { Course, Doc, Topic } from '../../../shared/types'
import { mastery, status, type Status } from '../../../shared/sched'
import { DAY } from '../../../shared/util'
import { api } from '../api'
import { courseClass, useAction, useApp, type ScopeSel } from '../state'
import { Icon } from '../icons'
import { Confirm, Deck, Empty, MasteryBar, Modal, StatusChip, deckName, fmtMin, fmtRel } from '../ui'
import { importFlow, importTarget } from '../components/ImportFlow'
import { CustomizePanel, GroupMenu, Pop } from '../components/BoardCustomize'
import { NewCourse } from '../components/NewCourse'
import {
  COLS, colorCss, leaves, moveItem, moveSection, unfolder, uid, useBoardLayout,
  type Folder, type Item, type Layout, type Pos, type Prefs
} from '../layout'
import { Inspector } from './Inspector'

export interface Derived { t: Topic; m: number; s: Status }

export function useDerived(): Derived[] {
  const { data, now } = useApp()
  return useMemo(() => (data?.topics ?? []).map((t) => ({ t, m: mastery(t, now), s: status(t, now) })), [data, now])
}

function loadSet(k: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(k) || '[]') as string[]) } catch { return new Set() }
}

function useCollapsed(k: string): [Set<string>, (id: string) => void] {
  const [s, set] = useState(() => loadSet(k))
  const toggle = (id: string): void => {
    set((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      localStorage.setItem(k, JSON.stringify([...n]))
      return n
    })
  }
  return [s, toggle]
}

const vars = (o: Record<string, string | number | undefined>): CSSProperties => {
  const r: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v
  return r as CSSProperties
}

function InlineEdit({ value, onSave, className, startEditing, children }: { value: string; onSave: (v: string) => void; className?: string; startEditing?: boolean; children?: ReactNode }) {
  const [editing, setEditing] = useState(!!startEditing)
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  if (!editing) {
    return <span className={className} onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }} title="Double-click to rename">{children ?? value}</span>
  }
  const commit = (): void => { setEditing(false); if (v.trim() && v.trim() !== value) onSave(v.trim()) }
  return (
    <input className="input" autoFocus value={v} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.target.select()} onChange={(e) => setV(e.target.value)}
      onBlur={commit} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setV(value); setEditing(false) } }} />
  )
}

/** Section/folder id -> the courses (section, course folder) or lessons (lesson folder) inside it. */
type Groups = Map<string, { courses?: Set<string>; docs?: Set<string> }>

function groupsOf(l: Layout): Groups {
  const m: Groups = new Map()
  const walk = (items: Item[], key: 'courses' | 'docs'): void => {
    for (const it of items) if (it.kind === 'folder') { m.set(it.id, { [key]: new Set(leaves(it.items)) }); walk(it.items, key) }
  }
  for (const s of l.sections) { m.set(s.id, { courses: new Set(leaves(s.items)) }); walk(s.items, 'courses') }
  for (const items of Object.values(l.lessons)) walk(items, 'docs')
  return m
}

function inScope(t: { courseId: string; docId: string; unit?: string }, sc: ScopeSel, groups: Groups): boolean {
  if (sc.kind === 'all') return true
  if (sc.kind === 'course') return t.courseId === sc.id
  if (sc.kind === 'lesson') return t.docId === sc.id
  if (sc.kind === 'group') {
    const g = groups.get(sc.id)
    if (!g) return true
    return g.courses ? g.courses.has(t.courseId) : !!g.docs?.has(t.docId)
  }
  return t.docId === sc.docId && (t.unit === undefined || t.unit === sc.unit)
}

function ScopeTree({ derived, layout, groups }: { derived: Derived[]; layout: Layout; groups: Groups }) {
  const { data, scope, setScope, courses, docs } = useApp()
  const [collapsed, toggle] = useCollapsed('tree-collapsed')
  if (!data) return null
  const counts = (pred: (t: Topic) => boolean): { n: number; due: number } => {
    let n = 0, due = 0
    for (const d of derived) if (pred(d.t)) { n++; if (d.s === 'review') due++ }
    return { n, due }
  }
  const Cnt = ({ c }: { c: { n: number; due: number } }) => (
    <span className={`cnt${c.due ? ' due' : ''}`} title={`${c.due} due of ${c.n}`}>{c.due ? `${c.due} due` : c.n}</span>
  )
  const sel = (s: ScopeSel): boolean => JSON.stringify(s) === JSON.stringify(scope)
  const pad = (depth: number): CSSProperties => ({ paddingLeft: 8 + depth * 14 })
  const Chev = ({ id, show = true }: { id: string; show?: boolean }) => show
    ? <span onClick={(e) => { e.stopPropagation(); toggle(id) }} aria-label={collapsed.has(id) ? 'Expand' : 'Collapse'}><Icon.chevron className={`chev${collapsed.has(id) ? '' : ' open'}`} /></span>
    : <span style={{ width: 14, flex: '0 0 auto' }} />
  const groupCnt = (id: string): { n: number; due: number } => counts((t) => inScope(t, { kind: 'group', id }, groups))

  const lessonItems = (items: Item[], depth: number): ReactNode => items.map((it) => {
    if (it.kind === 'folder') {
      return (
        <div key={it.id} style={vars({ '--g': colorCss(it.color) })}>
          <button className="tree-item" style={pad(depth)} aria-selected={sel({ kind: 'group', id: it.id })} onClick={() => setScope({ kind: 'group', id: it.id })}>
            <Chev id={it.id} /><Icon.folder className="ficon" /><span className="lbl">{it.name}</span><Cnt c={groupCnt(it.id)} />
          </button>
          {!collapsed.has(it.id) && lessonItems(it.items, depth + 1)}
        </div>
      )
    }
    const d = docs.get(it.id)
    if (!d) return null
    const units = [...new Set(derived.filter((x) => x.t.docId === d.id).sort((a, b) => a.t.ord - b.t.ord).map((x) => x.t.unit))]
    return (
      <div key={d.id}>
        <button className="tree-item" style={pad(depth)} aria-selected={sel({ kind: 'lesson', id: d.id })} onClick={() => setScope({ kind: 'lesson', id: d.id })}>
          <Chev id={d.id} show={units.length > 1} />
          <span className="lbl">{d.title}</span><Cnt c={counts((t) => t.docId === d.id)} />
        </button>
        {!collapsed.has(d.id) && units.length > 1 && units.map((u) => (
          <button key={u} className="tree-item" style={pad(depth + 1.3)} aria-selected={sel({ kind: 'unit', docId: d.id, unit: u })} onClick={() => setScope({ kind: 'unit', docId: d.id, unit: u })}>
            <span className="lbl muted">{u}</span><Cnt c={counts((t) => t.docId === d.id && t.unit === u)} />
          </button>
        ))}
      </div>
    )
  })

  const courseItems = (items: Item[], depth: number): ReactNode => items.map((it) => {
    if (it.kind === 'folder') {
      return (
        <div key={it.id} style={vars({ '--g': colorCss(it.color) })}>
          <button className="tree-item" style={pad(depth)} aria-selected={sel({ kind: 'group', id: it.id })} onClick={() => setScope({ kind: 'group', id: it.id })}>
            <Chev id={it.id} /><Icon.folder className="ficon" /><span className="lbl">{it.name}</span><Cnt c={groupCnt(it.id)} />
          </button>
          {!collapsed.has(it.id) && courseItems(it.items, depth + 1)}
        </div>
      )
    }
    const c = courses.get(it.id)
    if (!c) return null
    return (
      <div key={c.id} className={courseClass(c)} style={vars({ '--c': colorCss(layout.colors[c.id]) })}>
        <button className="tree-item" style={pad(depth)} aria-selected={sel({ kind: 'course', id: c.id })} onClick={() => setScope({ kind: 'course', id: c.id })}>
          <Chev id={c.id} /><span className="dot" />
          <span className="lbl">{c.name}</span><Cnt c={counts((t) => t.courseId === c.id)} />
        </button>
        {!collapsed.has(c.id) && lessonItems(layout.lessons[c.id] ?? [], depth + 1)}
      </div>
    )
  })

  return (
    <nav className="pane scope" aria-label="Scope">
      <button className="tree-item" aria-selected={sel({ kind: 'all' })} onClick={() => setScope({ kind: 'all' })}>
        <span className="lbl">All courses</span><Cnt c={counts(() => true)} />
      </button>
      {layout.sections.length === 1 && courseItems(layout.sections[0].items, 0)}
      {layout.sections.length > 1 && layout.sections.map((s) => (
        <div key={s.id} style={vars({ '--g': colorCss(s.color) })}>
          <button className="tree-item tree-sec" aria-selected={sel({ kind: 'group', id: s.id })} onClick={() => setScope({ kind: 'group', id: s.id })}>
            <Chev id={s.id} /><span className="lbl">{s.name}</span><Cnt c={groupCnt(s.id)} />
          </button>
          {!collapsed.has(s.id) && courseItems(s.items, 0)}
        </div>
      ))}
    </nav>
  )
}

function DocState({ d }: { d: Doc }) {
  const act = useAction()
  if (d.status === 'awaiting') return <span className="row-flex"><span>Awaiting AI organization</span><button className="btn ghost small" onClick={(e) => { e.stopPropagation(); void importFlow.estimate([d.id]) }}>Organize</button></span>
  if (d.status === 'queued') {
    const pct = d.windows ? Math.round((100 * d.winsDone) / d.windows) : 0
    return <span className="row-flex"><span>Organizing</span><span className="progressbar" aria-label={`${pct}%`}><i style={{ width: `${pct}%` }} /></span><span className="num">{d.winsDone}/{d.windows}</span></span>
  }
  if (d.status === 'needs' || d.status === 'error') {
    return <span className="row-flex"><span className="overdue" title={d.error ?? ''}>Needs organizing</span>
      <button className="btn ghost small" onClick={(e) => { e.stopPropagation(); void act(() => api.retryDoc(d.id), 'Retrying') }}><Icon.refresh /> Retry</button></span>
  }
  return null
}

function AddTopic({ onClose }: { onClose: () => void }) {
  const { data, scope, setSelected } = useApp()
  const act = useAction()
  const preDoc = scope.kind === 'lesson' ? scope.id : scope.kind === 'unit' ? scope.docId : ''
  const preCourse = scope.kind === 'course' ? scope.id : data?.docs.find((d) => d.id === preDoc)?.courseId ?? data?.courses[0]?.id ?? ''
  const [courseId, setCourseId] = useState(preCourse || '__new')
  const [courseName, setCourseName] = useState('')
  const [docId, setDocId] = useState(preDoc || '__new')
  const [lessonTitle, setLessonTitle] = useState('Manual topics')
  const [unit, setUnit] = useState(scope.kind === 'unit' ? scope.unit : '')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [enrich, setEnrich] = useState(true)
  const docs = data?.docs.filter((d) => d.courseId === courseId) ?? []
  const save = async (): Promise<void> => {
    const id = await act(() => api.addTopic({
      docId: docId === '__new' ? null : docId, courseId: courseId === '__new' ? null : courseId, courseName: courseId === '__new' ? courseName : undefined,
      lessonTitle: docId === '__new' ? lessonTitle : undefined, unit, name, text, enrich
    }), 'Topic added')
    if (id) { setSelected(id); onClose() }
  }
  return (
    <Modal title="Add a topic" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim() || !text.trim() || (courseId === '__new' && !courseName.trim())} onClick={() => void save()}>Add topic</button>
    </>}>
      <div className="grid2">
        <label className="field"><span>Course</span>
          <select className="input" value={courseId} onChange={(e) => { setCourseId(e.target.value); setDocId('__new') }}>
            {data?.courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="__new">New course…</option>
          </select>
        </label>
        {courseId === '__new'
          ? <label className="field"><span>New course name</span><input className="input" value={courseName} onChange={(e) => setCourseName(e.target.value)} /></label>
          : <label className="field"><span>Lesson</span>
            <select className="input" value={docId} onChange={(e) => setDocId(e.target.value)}>
              {docs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
              <option value="__new">New lesson…</option>
            </select>
          </label>}
        {docId === '__new' && <label className="field"><span>Lesson title</span><input className="input" value={lessonTitle} onChange={(e) => setLessonTitle(e.target.value)} /></label>}
        <label className="field"><span>Unit (optional)</span><input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
      </div>
      <label className="field"><span>Topic name</span><input className="input serif" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Michaelis-Menten kinetics" /></label>
      <label className="field"><span>Text to study</span><textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the section text" /></label>
      <label className="check"><input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} /><span>Let the AI add a summary, key terms, prerequisites and difficulty (one small request)</span></label>
    </Modal>
  )
}

// Drag sources and drop targets for the list headings.
type DragSrc = { type: 'section' | 'item' | 'lesson'; id: string; course?: string }
type DropTgt = { kind: 'section' | 'folder' | 'course' | 'lfolder' | 'lesson'; id: string; course?: string }

function allowed(d: DragSrc, t: DropTgt, open: boolean): Pos[] {
  if (d.id === t.id) return []
  if (d.type === 'section') return t.kind === 'section' ? ['before', 'after'] : []
  if (d.type === 'item') {
    if (t.kind === 'section') return ['inside']
    if (t.kind === 'folder') return open ? ['before', 'inside'] : ['before', 'inside', 'after']
    if (t.kind === 'course') return open ? ['before'] : ['before', 'after']
    return []
  }
  if (t.course !== d.course) return []
  if (t.kind === 'course') return ['inside']
  if (t.kind === 'lfolder') return open ? ['before', 'inside'] : ['before', 'inside', 'after']
  if (t.kind === 'lesson') return open ? ['before'] : ['before', 'after']
  return []
}

function posAt(e: DragEvent<HTMLElement>, ps: Pos[], axis: 'x' | 'y' = 'y'): Pos {
  if (ps.length === 1) return ps[0]
  const r = e.currentTarget.getBoundingClientRect()
  const y = axis === 'x' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height
  if (!ps.includes('inside')) return y < 0.5 ? 'before' : 'after'
  if (y < 0.3) return 'before'
  if (y > 0.7 && ps.includes('after')) return 'after'
  return 'inside'
}

export function Board() {
  const { data, scope, setScope, selected, setSelected, courses, docs, now, toast, setView, courseWizard, setCourseWizard } = useApp()
  const act = useAction()
  const derived = useDerived()
  const { layout, update, reset } = useBoardLayout(data?.courses ?? [], data?.docs ?? [])
  const groups = useMemo(() => groupsOf(layout), [layout])
  const prefs = layout.prefs
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Set<string> | null>(null)
  const [fStatus, setFStatus] = useState<'all' | Status>('all')
  const [fDue, setFDue] = useState<'any' | 'today' | 'week' | 'overdue'>('any')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [collapsed, toggle] = useCollapsed('list-collapsed')
  const [openLessons, toggleLesson] = useCollapsed('lessons-open') // lessons are closed dropdowns until opened
  const [adding, setAdding] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragSrc | null>(null)
  const [over, setOver] = useState<{ id: string; pos: Pos } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; label: string; danger?: boolean; run: () => Promise<void> } | null>(null)
  const [created, setCreated] = useState<{ id: string; color: string | null; section: string | null } | null>(null)

  // The course being looked at (course, lesson, unit or lesson-folder scope); none means the course folders.
  const scopeGroup = scope.kind === 'group' ? groups.get(scope.id) : undefined
  const scopeCourse = scope.kind === 'course' ? scope.id
    : scope.kind === 'lesson' ? docs.get(scope.id)?.courseId
      : scope.kind === 'unit' ? docs.get(scope.docId)?.courseId
        : scopeGroup?.docs ? docs.get([...scopeGroup.docs][0] ?? '')?.courseId : undefined
  // Files dropped on the window go into the open course.
  useEffect(() => {
    importTarget.course = scopeCourse ?? null
    return () => { importTarget.course = null }
  }, [scopeCourse])

  // A course made in the New course flow gets its colour and shelf section once it shows up in the data.
  useEffect(() => {
    if (!created || !courses.has(created.id)) return
    const { id, color, section } = created
    update((l) => {
      if (color) l.colors[id] = color
      if (section && !l.sections.find((s) => s.id === section)?.items.some((it) => it.id === id)) {
        moveItem(l.sections.map((s) => s.items), new Map(l.sections.map((s) => [s.id, s.items])), id, section, 'inside')
      }
    })
    setCreated(null)
  }, [created, courses, update])

  useEffect(() => {
    if (!q.trim()) { setHits(null); return }
    const id = window.setTimeout(() => { void api.search(q).then((ids) => setHits(new Set(ids))).catch(() => setHits(new Set())) }, 160)
    return () => window.clearTimeout(id)
  }, [q, data])

  // A deleted section/folder can no longer be a scope.
  useEffect(() => { if (scope.kind === 'group' && !groups.has(scope.id)) setScope({ kind: 'all' }) }, [scope, groups, setScope])

  const visible = useMemo(() => {
    const endToday = new Date(); endToday.setHours(23, 59, 59, 999)
    return derived.filter(({ t, s }) => {
      if (!inScope(t, scope, groups)) return false
      if (hits && !hits.has(t.id)) return false
      if (fStatus !== 'all' && s !== fStatus) return false
      if (fDue === 'overdue' && !(t.due && t.due <= now)) return false
      if (fDue === 'today' && !(t.due && t.due <= endToday.getTime())) return false
      if (fDue === 'week' && !(t.due && t.due <= now + 7 * DAY)) return false
      return true
    })
  }, [derived, scope, groups, hits, fStatus, fDue, now])

  const wizard = courseWizard && (
    <NewCourse sections={layout.sections} defaultSection={scope.kind === 'group' && layout.sections.some((s) => s.id === scope.id) ? scope.id : undefined}
      onCreated={(id, color, section) => setCreated({ id, color, section })} />
  )

  if (!data) return null
  if (!data.courses.length) {
    return (
      <Empty title="Create your first course">
        <p>A course is a folder for one subject. Give it a name and a colour, then upload lecture files or a whole folder, or start empty and add them later. Each file becomes a lesson. PDF and DOCX work on a best-effort basis; .md gives the cleanest topics.</p>
        <div className="row-flex">
          <button className="btn primary" onClick={() => setCourseWizard([])}><Icon.folderPlus /> New course</button>
          <button className="btn ghost" onClick={() => setAdding(true)}><Icon.plus /> Add a topic by hand</button>
        </div>
        <p className="help">You can also drop files or folders anywhere in this window to start a course with them.</p>
        {adding && <AddTopic onClose={() => setAdding(false)} />}
        {wizard}
      </Empty>
    )
  }

  // Group visible topics: lesson > unit
  const byDoc = new Map<string, Map<string, Derived[]>>()
  for (const d of visible) {
    const l = byDoc.get(d.t.docId) ?? new Map<string, Derived[]>()
    l.set(d.t.unit, [...(l.get(d.t.unit) ?? []), d])
    byDoc.set(d.t.docId, l)
  }
  const filtering = !!q || fStatus !== 'all' || fDue !== 'any'
  const home = !scopeCourse && !filtering
  const showEmptyGroups = !filtering
  const emptyDocs = new Set(filtering ? [] : data.docs.filter((d) => !byDoc.has(d.id) && inScope({ courseId: d.courseId, docId: d.id }, scope, groups)).map((d) => d.id))
  const docShown = (id: string): boolean => byDoc.has(id) || emptyDocs.has(id)
  const docCount = (id: string): number => [...(byDoc.get(id)?.values() ?? [])].reduce((a, r) => a + r.length, 0)
  const lessonIds = (cid: string): string[] => leaves(layout.lessons[cid] ?? [])
  const courseShown = (cid: string): boolean => (scope.kind === 'course' && scope.id === cid) || lessonIds(cid).some(docShown)
  const courseCount = (cid: string): number => lessonIds(cid).reduce((a, id) => a + docCount(id), 0)

  const toggleCheck = (id: string): void => setChecked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const sel = [...checked].filter((id) => data.topics.some((t) => t.id === id))
  const setPrefs = (p: Partial<Prefs>): void => update((l) => { l.prefs = { ...l.prefs, ...p } })

  const confirmDeleteDoc = (d: Doc): void => setConfirm({
    title: `Delete "${d.title}"?`, label: 'Delete lesson', danger: true,
    body: <p>This removes the lesson, its topics and their study history. Export a backup first if unsure.</p>,
    run: async () => { await api.deleteDoc(d.id) }
  })
  const confirmDeleteCourse = (c: Course): void => setConfirm({
    title: `Delete course "${c.name}"?`, label: 'Delete course', danger: true,
    body: <p>This removes every lesson and topic in the course, with their history.</p>,
    run: async () => { await api.deleteCourse(c.id) }
  })
  const reorganize = async (d: Doc): Promise<void> => {
    const n = await api.historyCount(d.id)
    const run = async (): Promise<void> => { await api.reorganize(d.id); toast('Re-organizing with AI. History carries over to matching topics.') }
    if (n > 0) {
      setConfirm({
        title: `Re-organize "${d.title}"?`, label: 'Re-organize',
        body: <p>{n} topic(s) in this lesson have study history. The AI will rebuild the topic list; history moves to new topics whose name or text still matches, and unmatched topics start fresh.</p>, run
      })
    } else await act(run)
  }

  // ---------- layout edits ----------
  const sectionLists = (l: Layout): Item[][] => l.sections.map((s) => s.items)
  const newSection = (): void => {
    const id = uid()
    update((l) => { l.sections.push({ id, name: 'New section', color: null, items: [] }) })
    setFresh(id)
  }
  const newFolder = (into: Item[] | ((l: Layout) => Item[] | undefined), parentId: string): void => {
    const id = uid()
    update((l) => {
      const list = typeof into === 'function' ? into(l) : into
      list?.unshift({ kind: 'folder', id, name: 'New folder', color: null, items: [] })
    })
    if (collapsed.has(parentId)) toggle(parentId)
    setFresh(id)
  }
  const findFolder = (lists: Item[][], id: string): Folder | undefined => {
    for (const list of lists) for (const it of list) {
      if (it.kind !== 'folder') continue
      if (it.id === id) return it
      const f = findFolder([it.items], id)
      if (f) return f
    }
    return undefined
  }
  const editFolder = (id: string, course: string | undefined, fn: (f: Folder) => void): void => update((l) => {
    const f = findFolder(course ? [l.lessons[course] ?? []] : sectionLists(l), id)
    if (f) fn(f)
  })
  const deleteSection = (id: string): void => {
    if (layout.sections.length < 2) { toast('Keep at least one section. Rename it instead.', true); return }
    const i = layout.sections.findIndex((s) => s.id === id)
    const into = layout.sections[i === 0 ? 1 : i - 1]
    update((l) => {
      const k = l.sections.findIndex((s) => s.id === id)
      const [s] = l.sections.splice(k, 1)
      const dest = l.sections.find((x) => x.id === into.id)
      dest?.items.push(...s.items)
    })
    if (layout.sections[i].items.length) toast(`Moved its contents to "${into.name}"`)
  }

  // ---------- drag and drop ----------
  const applyDrop = (d: DragSrc, t: DropTgt, pos: Pos): void => update((l) => {
    if (d.type === 'section') moveSection(l, d.id, t.id, pos)
    else if (d.type === 'item') moveItem(sectionLists(l), new Map(l.sections.map((s) => [s.id, s.items])), d.id, t.id, pos)
    else if (d.course) {
      const root = l.lessons[d.course]
      if (root) moveItem([root], new Map([[d.course, root]]), d.id, t.id, pos)
    }
  })
  const dnd = (src: DragSrc, tgt: DropTgt, open: boolean, axis: 'x' | 'y' = 'y') => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>): void => {
      if ((e.target as HTMLElement).closest('input, .popover')) { e.preventDefault(); return }
      e.stopPropagation()
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', src.id)
      setDrag(src)
    },
    onDragEnd: (): void => { setDrag(null); setOver(null) },
    onDragOver: (e: DragEvent<HTMLElement>): void => {
      if (!drag) return
      const ps = allowed(drag, tgt, open)
      if (!ps.length) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      const pos = posAt(e, ps, axis)
      if (over?.id !== tgt.id || over.pos !== pos) setOver({ id: tgt.id, pos })
    },
    onDragLeave: (e: DragEvent<HTMLElement>): void => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null) && over?.id === tgt.id) setOver(null)
    },
    onDrop: (e: DragEvent<HTMLElement>): void => {
      if (!drag) return
      const ps = allowed(drag, tgt, open)
      if (!ps.length) return
      e.preventDefault()
      e.stopPropagation()
      applyDrop(drag, tgt, posAt(e, ps, axis))
      setDrag(null); setOver(null)
    }
  })
  const dz = (id: string, srcId: string): string =>
    `${over?.id === id ? ` dz-${over.pos}` : ''}${drag?.id === srcId ? ' dragging' : ''}`
  const ind = (depth: number): CSSProperties => ({ paddingLeft: 10 + depth * 16 })
  const Count = ({ n }: { n: number }) => prefs.counts ? <span className="num">{n} topic{n === 1 ? '' : 's'}</span> : null

  // ---------- table columns ----------
  const on = COLS.filter((c) => prefs.cols[c.id])
  const tmpl = (narrow: boolean): string => ['20px', narrow ? 'minmax(140px, 1fr)' : 'minmax(160px, 1fr)',
    ...on.filter((c) => !narrow || (c.id !== 'spent' && c.id !== 'last')).map((c) => c.w)].join(' ')
  const header = (
    <div className="thead" role="row">
      <span /><span>Topic</span>
      {on.map((c) => <span key={c.id} className={`${c.id === 'status' ? '' : 'r'}${c.id === 'spent' ? ' c-spent' : c.id === 'last' ? ' c-last' : ''}`}>{c.label}</span>)}
    </div>
  )

  // ---------- rendering ----------
  const renderTopics = (rows: Derived[], depth: number): ReactNode => rows.sort((a, b) => a.t.ord - b.t.ord).map(({ t, m, s }) => {
    const overdue = !!t.due && t.due <= now
    return (
      <div key={t.id} className="trow" role="row" aria-selected={selected === t.id} style={vars({ '--indent': `${depth * 16}px` })}
        onClick={() => setSelected(t.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(t.id) }}>
        <input type="checkbox" checked={checked.has(t.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleCheck(t.id)} aria-label={`Select ${t.name}`} />
        <span className="namecell">
          <InlineEdit value={t.name} onSave={(v) => void act(() => api.renameTopic(t.id, v))} className={`name${t.provisional ? ' prov' : ''}`} />
          {prefs.deck && <Deck docId={t.docId} />}
        </span>
        {prefs.cols.status && <span><StatusChip s={s} /></span>}
        {prefs.cols.time && <span className="r num">{t.minutes}m</span>}
        {prefs.cols.spent && <span className="r num muted c-spent">{t.spent ? fmtMin(t.spent) : ''}</span>}
        {prefs.cols.last && <span className="r num muted c-last">{fmtRel(t.last, now)}</span>}
        {prefs.cols.due && <span className={`r num${overdue ? ' overdue' : ''}`}>{t.due ? fmtRel(t.due, now) : ''}</span>}
        {prefs.cols.mastery && <MasteryBar v={m} overdue={overdue && m < 50} />}
      </div>
    )
  })

  // Lessons are dropdowns: closed until opened, except while searching/filtering or when the lesson is the scope.
  const lessonOpen = (id: string): boolean =>
    filtering || (scope.kind === 'lesson' && scope.id === id) || (scope.kind === 'unit' && scope.docId === id) || openLessons.has(id)
  const renderLesson = (d: Doc, depth: number): ReactNode => {
    if (!docShown(d.id)) return null
    const units = byDoc.get(d.id) ?? new Map<string, Derived[]>()
    const rows = [...units.values()].flat()
    const due = rows.filter((r) => r.t.due && r.t.due <= now).length
    const avg = rows.length ? Math.round(rows.reduce((a, r) => a + r.m, 0) / rows.length) : 0
    const lOpen = lessonOpen(d.id)
    return (
      <div key={d.id} className={`lesson-dd${lOpen ? ' open' : ''}`}>
        <div className={`group lesson${dz(d.id, d.id)}`} style={ind(depth)} onClick={() => toggleLesson(d.id)} role="button" tabIndex={0} aria-expanded={lOpen}
          onKeyDown={(e) => e.key === 'Enter' && toggleLesson(d.id)}
          {...dnd({ type: 'lesson', id: d.id, course: d.courseId }, { kind: 'lesson', id: d.id, course: d.courseId }, false)}>
          <Icon.chevron className={`chev${lOpen ? ' open' : ''}`} />
          <InlineEdit value={d.title} onSave={(v) => void act(() => api.renameDoc(d.id, v))} className="gname" />
          {prefs.deck && deckName(d) !== d.title && <span className="deck" title={d.fileName}><Icon.file size={12} /><span>{deckName(d)}</span></span>}
          {d.ext === 'pdf' || d.ext === 'docx' ? <span className="muted small" title={d.importNote ?? ''}>{d.ext.toUpperCase()}, best effort</span> : null}
          <span className="meta">
            <DocState d={d} />
            {rows.length > 0 && <Count n={rows.length} />}
            {due > 0 && <span className="num overdue">{due} due</span>}
            {rows.length > 0 && !lOpen && prefs.cols.mastery && <MasteryBar v={avg} />}
            {d.ext !== 'manual' && (d.status === 'organized' || d.status === 'needs') && <button className="btn ghost small" title="Re-organize with AI" onClick={(e) => { e.stopPropagation(); void reorganize(d) }}><Icon.sparkle /> Re-organize</button>}
            <button className="btn ghost icon" title="Delete lesson" aria-label="Delete lesson" onClick={(e) => { e.stopPropagation(); confirmDeleteDoc(d) }}><Icon.trash /></button>
          </span>
        </div>
        {lOpen && [...units.entries()].map(([u, urows]) => {
          const key = `u:${d.id}:${u}`
          const uOpen = units.size < 2 || !collapsed.has(key)
          return (
            <div key={u}>
              {units.size > 1 && (
                <div className="group unit" style={ind(depth + 1)} role="button" tabIndex={0} aria-expanded={uOpen}
                  onClick={() => toggle(key)} onKeyDown={(e) => e.key === 'Enter' && toggle(key)}>
                  <Icon.chevron className={`chev${uOpen ? ' open' : ''}`} /><span className="gname">{u}</span>
                  <span className="meta"><span className="num">{urows.length}</span></span>
                </div>
              )}
              {uOpen && renderTopics(urows, depth + (units.size > 1 ? 1 : 0))}
            </div>
          )
        })}
        {lOpen && units.size === 0 && <div className="status-line" style={ind(depth + 1)}>{d.status === 'error' ? <span className="err-text">{d.error}</span> : 'No topics in this lesson.'}</div>}
      </div>
    )
  }

  const renderLessonItems = (items: Item[], course: string, depth: number): ReactNode => items.map((it) => {
    if (it.kind === 'lesson') { const d = docs.get(it.id); return d ? renderLesson(d, depth) : null }
    if (it.kind !== 'folder') return null
    const ids = leaves(it.items)
    if (!ids.some(docShown) && !showEmptyGroups) return null
    const open = !collapsed.has(it.id)
    return (
      <div key={it.id} style={vars({ '--g': colorCss(it.color) })}>
        <div className={`group lfolder${dz(it.id, it.id)}`} style={ind(depth)} onClick={() => toggle(it.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && toggle(it.id)}
          {...dnd({ type: 'lesson', id: it.id, course }, { kind: 'lfolder', id: it.id, course }, open)}>
          <Icon.chevron className={`chev${open ? ' open' : ''}`} /><Icon.folder className="ficon" />
          <InlineEdit value={it.name} startEditing={fresh === it.id} className="gname" onSave={(v) => editFolder(it.id, course, (f) => { f.name = v })} />
          <span className="meta">
            <Count n={ids.reduce((a, id) => a + docCount(id), 0)} />
            <GroupMenu title="Folder options" color={it.color} onColor={(v) => editFolder(it.id, course, (f) => { f.color = v })}
              folderLabel="New folder inside" onFolder={() => newFolder((l) => findFolder([l.lessons[course] ?? []], it.id)?.items, it.id)}
              deleteLabel="Remove folder (keeps lessons)" onDelete={() => update((l) => unfolder([l.lessons[course] ?? []], it.id))} />
          </span>
        </div>
        {open && renderLessonItems(it.items, course, depth + 1)}
        {open && it.items.length === 0 && <div className="status-line" style={ind(depth + 1)}>Empty folder. Drag lessons onto it.</div>}
      </div>
    )
  })

  // ---------- course folders (home) ----------
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  const courseStats = (cid: string): { lessons: number; topics: number; due: number; fresh: number; mastery: number } => {
    const rows = derived.filter((d) => d.t.courseId === cid)
    return {
      lessons: data.docs.filter((d) => d.courseId === cid).length,
      topics: rows.length,
      due: rows.filter((r) => r.t.due && r.t.due <= now).length,
      fresh: rows.filter((r) => r.s === 'new').length,
      mastery: rows.length ? Math.round(rows.reduce((a, r) => a + r.m, 0) / rows.length) : 0
    }
  }
  const courseMenu = (c: Course): ReactNode => (
    <GroupMenu title="Course options" color={layout.colors[c.id]} onColor={(v) => update((l) => { if (v) l.colors[c.id] = v; else delete l.colors[c.id] })}
      folderLabel="New folder for lessons" onFolder={() => newFolder((l) => l.lessons[c.id], c.id)}
      deleteLabel="Delete course…" onDelete={() => confirmDeleteCourse(c)} />
  )
  const openCourse = (cid: string): void => setScope({ kind: 'course', id: cid })

  const folderCard = (cid: string): ReactNode => {
    const c = data.courses.find((x) => x.id === cid)
    if (!c || (scopeGroup?.courses && !scopeGroup.courses.has(cid))) return null
    const st = courseStats(cid)
    const sheets = leaves(layout.lessons[cid] ?? []).map((id) => docs.get(id)).filter((d): d is Doc => !!d).slice(0, 3)
    const state = st.due ? `${st.due} due now` : !st.lessons ? 'No lessons yet' : !st.topics ? 'Awaiting topics' : st.fresh === st.topics ? 'Not started' : 'Nothing due'
    return (
      <div key={cid} className={`fcard ${courseClass(c)}${dz(cid, cid)}`} style={vars({ '--c': colorCss(layout.colors[cid]) })}
        role="button" tabIndex={0} aria-label={`Open ${c.name}`} onClick={() => openCourse(cid)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCourse(cid) } }}
        {...dnd({ type: 'item', id: cid }, { kind: 'course', id: cid, course: cid }, false, 'x')}>
        <span className="fcard-back" aria-hidden="true" />
        <span className="fcard-sheets" aria-hidden="true">
          {sheets.map((d) => <span key={d.id} className="sheet">{deckName(d)}</span>)}
        </span>
        <span className="fcard-front">
          <span className="fcard-name">{c.name}</span>
          <span className="fcard-sub">{plural(st.lessons, 'lesson')}, {plural(st.topics, 'topic')}</span>
          <span className="fcard-foot">
            <span className={st.due ? 'overdue' : 'muted'}>{state}</span>
            <MasteryBar v={st.mastery} />
          </span>
        </span>
        <span className="fcard-menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{courseMenu(c)}</span>
      </div>
    )
  }

  // A user-made group of courses spans the row and holds its own folders.
  const folderCards = (items: Item[]): ReactNode => items.map((it) => {
    if (it.kind === 'course') return folderCard(it.id)
    if (it.kind !== 'folder') return null
    return (
      <div key={it.id} className="shelf-group" style={vars({ '--g': colorCss(it.color) })}>
        <div className={`shelf-h sub${dz(it.id, it.id)}`} {...dnd({ type: 'item', id: it.id }, { kind: 'folder', id: it.id }, true)}>
          <Icon.folder className="ficon" />
          <InlineEdit value={it.name} startEditing={fresh === it.id} className="gname" onSave={(v) => editFolder(it.id, undefined, (f) => { f.name = v })} />
          <GroupMenu title="Group options" color={it.color} onColor={(v) => editFolder(it.id, undefined, (f) => { f.color = v })}
            deleteLabel="Ungroup (keeps courses)" onDelete={() => update((l) => unfolder(sectionLists(l), it.id))} />
        </div>
        <div className="folders">{folderCards(it.items)}</div>
        {!it.items.length && <p className="shelf-empty">Empty group. Drag course folders onto its name.</p>}
      </div>
    )
  })

  const multi = layout.sections.length > 1
  const shelf = (
    <div className="shelf">
      {layout.sections.map((s, i) => {
        if (scopeGroup?.courses && scope.kind === 'group' && scope.id !== s.id && !leaves(s.items).some((id) => scopeGroup.courses?.has(id))) return null
        return (
          <section key={s.id} className="shelf-sec" style={vars({ '--g': colorCss(s.color) })} aria-label={s.name}>
            {multi && (
              <div className={`shelf-h${dz(s.id, s.id)}`} {...dnd({ type: 'section', id: s.id }, { kind: 'section', id: s.id }, true)}>
                <InlineEdit value={s.name} startEditing={fresh === s.id} className="gname" onSave={(v) => update((l) => { const x = l.sections.find((y) => y.id === s.id); if (x) x.name = v })} />
                <GroupMenu title="Section options" color={s.color} onColor={(v) => update((l) => { const x = l.sections.find((y) => y.id === s.id); if (x) x.color = v })}
                  folderLabel="New group in this section" onFolder={() => newFolder((l) => l.sections.find((y) => y.id === s.id)?.items, s.id)}
                  deleteLabel="Remove section (keeps courses)" onDelete={() => deleteSection(s.id)} />
              </div>
            )}
            <div className="folders">
              {folderCards(s.items)}
              {i === 0 && scope.kind === 'all' && (
                <div className="fcard add" role="button" tabIndex={0} onClick={() => setCourseWizard([])}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCourseWizard([]) } }}>
                  <span className="fcard-back" aria-hidden="true" />
                  <span className="fcard-front">
                    <Icon.folderPlus size={20} />
                    <span className="fcard-name">Add a course</span>
                    <span className="fcard-sub">Name it, pick a colour, add files</span>
                  </span>
                </div>
              )}
            </div>
            {multi && !s.items.length && <p className="shelf-empty">Empty section. Drag course folders onto its name.</p>}
          </section>
        )
      })}
    </div>
  )

  // ---------- one course: its lessons as dropdowns ----------
  const courseHead = (cid: string): ReactNode => {
    const c = data.courses.find((x) => x.id === cid)
    if (!c) return null
    const st = courseStats(cid)
    return (
      <header className={`course-head ${courseClass(c)}`} style={vars({ '--c': colorCss(layout.colors[cid]) })}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <button className="crumb" onClick={() => setScope({ kind: 'all' })}>All courses</button>
          {scope.kind !== 'course' && <><Icon.chevron size={12} /><button className="crumb" onClick={() => openCourse(cid)}>{c.name}</button></>}
        </nav>
        <div className="course-title">
          <InlineEdit value={c.name} onSave={(v) => void act(() => api.renameCourse(c.id, v))} className="ctitle" />
          {courseMenu(c)}
        </div>
        <p className="course-sub">
          {plural(st.lessons, 'lesson')}, {plural(st.topics, 'topic')}
          {st.due > 0 && <>, <span className="overdue">{st.due} due now</span></>}
        </p>
      </header>
    )
  }

  // Search or filters with no course open: matches grouped under each course.
  const resultCourses = layout.sections.flatMap((s) => leaves(s.items)).filter(courseShown)
  const results = resultCourses.map((cid) => {
    const c = data.courses.find((x) => x.id === cid)
    if (!c) return null
    return (
      <div key={cid} className={courseClass(c)} style={vars({ '--c': colorCss(layout.colors[cid]) })}>
        <div className="group course" role="button" tabIndex={0} title="Open course" onClick={() => openCourse(cid)} onKeyDown={(e) => e.key === 'Enter' && openCourse(cid)}>
          <span className="dot" /><span className="gname">{c.name}</span><span className="meta"><Count n={courseCount(cid)} /></span>
        </div>
        {renderLessonItems(layout.lessons[cid] ?? [], cid, 1)}
      </div>
    )
  })
  const anyShown = scopeCourse ? lessonIds(scopeCourse).some(docShown) : resultCourses.length > 0
  const emptyCourse = !!scopeCourse && !filtering && !data.docs.some((d) => d.courseId === scopeCourse)
  const upload = (cid: string): ReactNode => (
    <Pop title={`Upload lessons to ${courses.get(cid)?.name ?? 'this course'}`} className="" label={<><Icon.upload /> Upload</>}>
      {(close) => (
        <div className="menu">
          <div className="menu-h">Add lessons to {courses.get(cid)?.name}</div>
          <button className="menu-i" onClick={() => { close(); void importFlow.pick('files', cid) }}><Icon.file /> Files…</button>
          <button className="menu-i" onClick={() => { close(); void importFlow.pick('folder', cid) }}><Icon.folder /> A folder…</button>
          <p className="menu-note">Each file becomes a lesson. You can also drop files anywhere in this window.</p>
        </div>
      )}
    </Pop>
  )

  const boardCls = `board d-${prefs.density}${prefs.tree ? '' : ' no-tree'}${prefs.inspector ? '' : ' no-insp'}${prefs.tint ? ' tint' : ''}${drag ? ' is-dragging' : ''}`
  return (
    <div className={boardCls} style={vars({ '--hs': prefs.headings, '--t': `${prefs.topicSize}px`, '--cols': tmpl(false), '--cols-n': tmpl(true) })}>
      {prefs.tree && <ScopeTree derived={derived} layout={layout} groups={groups} />}
      <section className="pane list" aria-label="Topics">
        <div className="toolbar">
          <div className="search"><Icon.search /><input className="input" placeholder="Search topics, terms and text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></div>
          <select className="input" value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)} aria-label="Status filter">
            <option value="all">Any status</option><option value="new">New</option><option value="progress">In progress</option><option value="review">Needs review</option><option value="solid">Solid</option>
          </select>
          <select className="input" value={fDue} onChange={(e) => setFDue(e.target.value as typeof fDue)} aria-label="Due filter">
            <option value="any">Any due date</option><option value="overdue">Overdue</option><option value="today">Due by tonight</option><option value="week">Due within 7 days</option>
          </select>
          <div style={{ flex: 1 }} />
          {sel.length >= 2 && <button className="btn" onClick={() => setConfirm({
            title: `Merge ${sel.length} topics?`, label: 'Merge',
            body: <p>The text is joined in lesson order. The study history of the most-reviewed topic is kept; time spent is added up.</p>,
            run: async () => { const id = await api.mergeTopics(sel); setChecked(new Set()); setSelected(id) }
          })}><Icon.merge /> Merge {sel.length}</button>}
          {sel.length >= 1 && <button className="btn danger" onClick={() => setConfirm({
            title: `Delete ${sel.length} topic(s)?`, label: 'Delete', danger: true, body: <p>Their study history is removed too.</p>,
            run: async () => { await api.deleteTopics(sel); setChecked(new Set()) }
          })}><Icon.trash /> Delete</button>}
          <CustomizePanel layout={layout} setPrefs={setPrefs} onNewSection={newSection} onReset={() => { reset(); toast('Layout reset') }} />
          <button className="btn" onClick={() => setAdding(true)}><Icon.plus /> Add topic</button>
          {scopeCourse ? upload(scopeCourse)
            : <button className="btn" onClick={() => setCourseWizard([])} title="Create a course"><Icon.folderPlus /> New course</button>}
          <button className="btn primary" onClick={() => setView('session')} title="Choose a pool and start"><Icon.play /> Study</button>
        </div>
        {home ? <div className="rows home">{shelf}</div> : (
          <div className="rows" role="table" aria-label="Topic list">
            {scopeCourse && courseHead(scopeCourse)}
            {emptyCourse ? (
              <Empty title="No lessons yet">
                <p>Upload lecture files or a whole folder; each file becomes a lesson in {courses.get(scopeCourse)?.name ?? 'this course'}. You can also drop them anywhere in this window.</p>
                <div className="row-flex">
                  <button className="btn primary" onClick={() => void importFlow.pick('files', scopeCourse)}><Icon.file /> Upload files</button>
                  <button className="btn" onClick={() => void importFlow.pick('folder', scopeCourse)}><Icon.folder /> Upload a folder</button>
                  <button className="btn ghost" onClick={() => setAdding(true)}><Icon.plus /> Add a topic by hand</button>
                </div>
              </Empty>
            ) : header}
            {!anyShown && !emptyCourse && (
              <Empty title={q ? 'No topics match this search' : 'Nothing matches these filters'}><p>Clear the search or filters to see all topics in this scope.</p></Empty>
            )}
            {scopeCourse ? renderLessonItems(layout.lessons[scopeCourse] ?? [], scopeCourse, 0) : results}
          </div>
        )}
      </section>
      {prefs.inspector && <Inspector key={selected ?? 'none'} docsMap={docs} />}
      {adding && <AddTopic onClose={() => setAdding(false)} />}
      {wizard}
      {confirm && <Confirm title={confirm.title} body={confirm.body} confirm={confirm.label} danger={confirm.danger}
        onNo={() => setConfirm(null)} onYes={() => { const c = confirm; setConfirm(null); void act(c.run) }} />}
    </div>
  )
}
