// Topics-tab layout: user-made sections and folders, drag order, colours and display options.
// Purely presentational and kept in the renderer (localStorage); courses, lessons and topics are untouched.
import { useCallback, useMemo, useState } from 'react'
import type { Course, Doc } from '../../shared/types'

export interface Leaf { kind: 'course' | 'lesson'; id: string }
export interface Folder { kind: 'folder'; id: string; name: string; color: string | null; items: Item[] }
export type Item = Leaf | Folder
export interface Section { id: string; name: string; color: string | null; items: Item[] }

export type Col = 'status' | 'time' | 'spent' | 'last' | 'due' | 'mastery'
export const COLS: { id: Col; label: string; w: string }[] = [
  { id: 'status', label: 'Status', w: '98px' }, { id: 'time', label: 'Time', w: '42px' }, { id: 'spent', label: 'Spent', w: '50px' },
  { id: 'last', label: 'Last', w: '58px' }, { id: 'due', label: 'Next due', w: '70px' }, { id: 'mastery', label: 'Mastery', w: '100px' }
]

export interface Prefs {
  density: 'compact' | 'cozy' | 'roomy'
  headings: 1 | 1.15 | 1.3 // scale applied to every group heading
  topicSize: number // px, topic names; headings are always sized above this
  cols: Record<Col, boolean>
  tree: boolean
  inspector: boolean
  tint: boolean
  counts: boolean
  deck: boolean // lecture file name next to topics
}

export interface Layout {
  v: 1
  sections: Section[]
  lessons: Record<string, Item[]> // per course: lesson leaves and lesson folders
  colors: Record<string, string> // course id -> colour token
  prefs: Prefs
}

export const DEFAULT_PREFS: Prefs = {
  density: 'cozy', headings: 1, topicSize: 15,
  cols: { status: true, time: true, spent: true, last: true, due: true, mastery: true },
  tree: true, inspector: true, tint: false, counts: true, deck: true
}

// Colour tokens: 'h:<hue>' follows the theme's lightness, 'n' is neutral, anything else is a literal CSS colour.
export const SWATCHES = ['h:25', 'h:50', 'h:75', 'h:100', 'h:130', 'h:155', 'h:180', 'h:200', 'h:225', 'h:250', 'h:275', 'h:300', 'h:325', 'h:350', 'n']
export function colorCss(v: string | null | undefined): string | undefined {
  if (!v) return undefined
  if (v === 'n') return 'var(--muted)'
  if (v.startsWith('h:')) return `oklch(var(--c-l) 0.09 ${Number(v.slice(2)) || 0})`
  return v
}

export const uid = (): string => crypto.randomUUID()

const KEY = 'board-layout-v1'

function empty(): Layout {
  return { v: 1, sections: [], lessons: {}, colors: {}, prefs: { ...DEFAULT_PREFS, cols: { ...DEFAULT_PREFS.cols } } }
}

export function load(): Layout {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<Layout> | null
    if (!p || p.v !== 1 || !Array.isArray(p.sections)) return empty()
    return {
      v: 1, sections: p.sections, lessons: p.lessons ?? {}, colors: p.colors ?? {},
      prefs: { ...DEFAULT_PREFS, ...p.prefs, cols: { ...DEFAULT_PREFS.cols, ...p.prefs?.cols } }
    }
  } catch {
    return empty()
  }
}

function save(l: Layout): void {
  try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* layout is a convenience; ignore quota errors */ }
}

function prune(items: Item[], keep: (l: Leaf) => boolean, seen: Set<string>): Item[] {
  const out: Item[] = []
  for (const it of items) {
    if (it.kind === 'folder') out.push({ ...it, items: prune(it.items, keep, seen) })
    else if (keep(it) && !seen.has(it.id)) { seen.add(it.id); out.push(it) }
  }
  return out
}

/** Reconcile the saved layout with the current data: drop vanished courses/lessons, append new ones. */
export function normalize(l: Layout, courses: Course[], docs: Doc[]): Layout {
  const cids = new Set(courses.map((c) => c.id))
  const seen = new Set<string>()
  const sections = l.sections.map((s) => ({ ...s, items: prune(s.items, (x) => x.kind === 'course' && cids.has(x.id), seen) }))
  const missing = courses.filter((c) => !seen.has(c.id))
  if (missing.length) {
    if (!sections.length) sections.push({ id: uid(), name: 'Courses', color: null, items: [] })
    sections[0] = { ...sections[0], items: [...sections[0].items, ...missing.map((c): Item => ({ kind: 'course', id: c.id }))] }
  }
  const lessons: Record<string, Item[]> = {}
  for (const c of courses) {
    const mine = docs.filter((d) => d.courseId === c.id)
    const ids = new Set(mine.map((d) => d.id))
    const s = new Set<string>()
    const tree = prune(l.lessons[c.id] ?? [], (x) => x.kind === 'lesson' && ids.has(x.id), s)
    for (const d of mine) if (!s.has(d.id)) tree.push({ kind: 'lesson', id: d.id })
    lessons[c.id] = tree
  }
  const colors: Record<string, string> = {}
  for (const [k, v] of Object.entries(l.colors)) if (cids.has(k)) colors[k] = v
  return { v: 1, sections, lessons, colors, prefs: l.prefs }
}

// ---------- tree operations (mutate a draft) ----------

export function findItem(lists: Item[][], id: string): Item | null {
  for (const list of lists) {
    for (const it of list) {
      if (it.id === id) return it
      if (it.kind === 'folder') { const f = findItem([it.items], id); if (f) return f }
    }
  }
  return null
}

function contains(it: Item, id: string): boolean {
  return it.kind === 'folder' && it.items.some((x) => x.id === id || contains(x, id))
}

function take(lists: Item[][], id: string): Item | null {
  for (const list of lists) {
    const i = list.findIndex((x) => x.id === id)
    if (i >= 0) return list.splice(i, 1)[0]
    for (const it of list) if (it.kind === 'folder') { const r = take([it.items], id); if (r) return r }
  }
  return null
}

function place(lists: Item[][], targetId: string, pos: 'before' | 'after' | 'inside', item: Item): boolean {
  for (const list of lists) {
    const i = list.findIndex((x) => x.id === targetId)
    if (i >= 0) {
      const t = list[i]
      if (pos === 'inside' && t.kind === 'folder') t.items.push(item)
      else list.splice(pos === 'after' ? i + 1 : i, 0, item)
      return true
    }
    for (const it of list) if (it.kind === 'folder' && place([it.items], targetId, pos, item)) return true
  }
  return false
}

export type Pos = 'before' | 'after' | 'inside'

/**
 * Move an item within a forest. `containers` maps a container id (section id or course id) to its root list;
 * dropping "inside" a container appends there. Returns false (and leaves lists intact) on an invalid move.
 */
export function moveItem(lists: Item[][], containers: Map<string, Item[]>, id: string, targetId: string, pos: Pos): boolean {
  if (id === targetId) return false
  const it = findItem(lists, id)
  if (!it || contains(it, targetId)) return false
  const root = containers.get(targetId)
  if (!root && !findItem(lists, targetId)) return false
  take(lists, id)
  if (root) root.push(it)
  else place(lists, targetId, pos, it)
  return true
}

export function moveSection(l: Layout, id: string, targetId: string, pos: Pos): void {
  if (id === targetId) return
  const i = l.sections.findIndex((s) => s.id === id)
  if (i < 0) return
  const [s] = l.sections.splice(i, 1)
  const j = l.sections.findIndex((x) => x.id === targetId)
  l.sections.splice(j < 0 ? l.sections.length : pos === 'after' ? j + 1 : j, 0, s)
}

/** Remove a folder, putting its contents where it was. */
export function unfolder(lists: Item[][], id: string): void {
  for (const list of lists) {
    const i = list.findIndex((x) => x.id === id)
    if (i >= 0) {
      const f = list[i]
      list.splice(i, 1, ...(f.kind === 'folder' ? f.items : []))
      return
    }
    for (const it of list) if (it.kind === 'folder') unfolder([it.items], id)
  }
}

export function leaves(items: Item[]): string[] {
  return items.flatMap((x) => (x.kind === 'folder' ? leaves(x.items) : [x.id]))
}

export function useBoardLayout(courses: Course[], docs: Doc[]): { layout: Layout; update: (fn: (d: Layout) => void) => void; reset: () => void } {
  const [raw, setRaw] = useState<Layout>(load)
  const layout = useMemo(() => normalize(raw, courses, docs), [raw, courses, docs])
  const update = useCallback((fn: (d: Layout) => void) => {
    setRaw((prev) => {
      const d = structuredClone(normalize(prev, courses, docs))
      fn(d)
      save(d)
      return d
    })
  }, [courses, docs])
  const reset = useCallback(() => {
    setRaw((prev) => { const d = { ...empty(), prefs: prev.prefs }; save(d); return d })
  }, [])
  return { layout, update, reset }
}
