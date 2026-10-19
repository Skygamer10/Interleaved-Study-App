// Domain operations on top of the thin Store: courses, lessons, topics (with text kept separately),
// history carry-over, reviews, overrides, daily stats, snapshots, organize-job creation and estimates.
import crypto from 'crypto'
import type {
  Course, DataSnapshot, Daily, Deadline, Doc, Estimate, Job, JobKind, OverrideAction, Para, Settings, Snapshot, Topic
} from '../shared/types'
import { applyReview, markSolid, mastery, resetSched, setDue, status, type ReviewInput } from '../shared/sched'
import { addTime, clamp, dayKey, suggestedMinutes, wordCount } from '../shared/util'
import { DEFAULT_REQUEST_MS } from '../shared/defaults'
import type { Store } from './store/types'
import { buildWindows, estTokens, firstSentenceName, provisionalTopics, safeName, sliceText } from './preprocess'
import { ORGANIZE_SYSTEM, ambiguousPairs, cacheKey, finalizeWindows, windowCacheContent, type WinResult } from './organize'
import { carryHistory, hasHistory, matchTopics } from './history'

export const uid = (): string => crypto.randomUUID()

export interface DocPrep { paras: Para[]; outline: string }

export const PRIORITY: Record<JobKind, number> = { quiz: 1, grade: 1, deadlines: 2, enrich: 4, dedupe: 4, organize: 5 }

export class Repo {
  constructor(public store: Store, public settings: () => Settings, public now: () => number = Date.now) {}

  // ---------- courses ----------
  ensureCourse(name: string): Course {
    const clean = name.trim() || 'Unsorted'
    const found = this.store.all<Course>('courses').find((c) => c.name.toLowerCase() === clean.toLowerCase())
    if (found) return found
    const count = this.store.all<Course>('courses').length
    const c: Course = { id: uid(), name: clean, color: count % 8, createdAt: this.now() }
    this.store.put('courses', c)
    return c
  }

  renameCourse(id: string, name: string): void {
    const c = this.store.get<Course>('courses', id)
    if (!c || !name.trim()) return
    this.store.put('courses', { ...c, name: name.trim() })
  }

  deleteCourse(id: string): void {
    this.store.tx(() => {
      for (const d of this.store.byParent<Doc>('docs', id)) this.deleteDoc(d.id)
      for (const t of this.store.all<Topic>('topics').filter((x) => x.courseId === id)) this.deleteTopic(t.id)
      for (const dl of this.store.all<Deadline>('deadlines').filter((x) => x.courseId === id)) this.store.put('deadlines', { ...dl, courseId: null })
      this.store.del('courses', id)
    })
  }

  // ---------- docs ----------
  docPrep(docId: string): DocPrep | null {
    const raw = this.store.getText(`doc:${docId}`)
    if (!raw) return null
    try { return JSON.parse(raw) as DocPrep } catch { return null }
  }

  saveDocPrep(docId: string, prep: DocPrep): void {
    this.store.putText(`doc:${docId}`, JSON.stringify(prep))
  }

  renameDoc(id: string, title: string): void {
    const d = this.store.get<Doc>('docs', id)
    if (!d || !title.trim()) return
    this.store.put('docs', { ...d, title: title.trim(), titleLocked: true, updatedAt: this.now() })
  }

  deleteDoc(id: string): void {
    this.store.tx(() => {
      for (const t of this.store.byParent<Topic>('topics', id)) this.deleteTopic(t.id)
      for (const j of this.store.byParent<Job>('jobs', id)) this.store.del('jobs', j.id)
      for (const w of this.store.byParent<{ id: string }>('wins', id)) this.store.del('wins', w.id)
      for (const dl of this.store.all<Deadline>('deadlines').filter((x) => x.docId === id)) this.store.put('deadlines', { ...dl, docId: null })
      this.store.delText(`doc:${id}`)
      this.store.del('docs', id)
    })
  }

  historyCount(docId: string): number {
    return this.store.byParent<Topic>('topics', docId).filter(hasHistory).length
  }

  // ---------- topics ----------
  newTopic(p: Partial<Topic> & { docId: string; courseId: string; name: string }): Topic {
    return {
      id: uid(), unit: '', ord: 0, start: null, end: null, words: 0, minutes: 10, summary: '', terms: [], prereqs: [],
      difficulty: null, provisional: false, notes: '', createdAt: this.now(), reviews: [], spent: 0,
      stab: null, due: null, last: null, evid: null, override: null, ...p
    }
  }

  topicText(id: string): string {
    return this.store.getText(`topic:${id}`) ?? ''
  }

  saveTopic(t: Topic, text?: string): void {
    this.store.put('topics', t)
    if (text !== undefined) this.store.putText(`topic:${t.id}`, text)
    const body = `${t.summary}\n${t.terms.join(' ')}\n${t.unit}\n${text ?? this.topicText(t.id)}`
    this.store.index(t.id, t.name, body)
  }

  deleteTopic(id: string): void {
    this.store.del('topics', id)
    this.store.delText(`topic:${id}`)
    this.store.del('quizzes', id)
    this.store.unindex(id)
  }

  renameTopic(id: string, name: string): void {
    const t = this.store.get<Topic>('topics', id)
    const n = name.trim()
    if (!t || !n) return
    this.saveTopic({ ...t, name: safeName(n, this.topicText(id), n), provisional: false })
  }

  updateTopic(id: string, patch: { notes?: string; unit?: string; minutes?: number }): void {
    const t = this.store.get<Topic>('topics', id)
    if (!t) return
    const next = { ...t }
    if (patch.notes !== undefined) next.notes = patch.notes
    if (patch.unit !== undefined && patch.unit.trim()) next.unit = patch.unit.trim()
    if (patch.minutes !== undefined && Number.isFinite(patch.minutes)) next.minutes = clamp(Math.round(patch.minutes), 1, 240)
    this.saveTopic(next)
  }

  renumber(docId: string): void {
    const ts = this.store.byParent<Topic>('topics', docId).sort((a, b) => a.ord - b.ord)
    ts.forEach((t, i) => { if (t.ord !== i) this.store.put('topics', { ...t, ord: i }) })
  }

  /**
   * Replace a lesson's topics, carrying history over to new topics that match old ones by name or text.
   * Returns how many were carried and how many old topics with history could not be matched.
   */
  replaceDocTopics(docId: string, items: { topic: Topic; text: string }[]): { carried: number; dropped: number } {
    const olds = this.store.byParent<Topic>('topics', docId)
    const oldItems = olds.map((o) => ({ id: o.id, name: o.name, text: this.topicText(o.id) }))
    const match = matchTopics(oldItems, items.map((i) => ({ id: i.topic.id, name: i.topic.name, text: i.text })))
    const oldById = new Map(olds.map((o) => [o.id, o]))
    let carried = 0
    const usedOld = new Set<string>()
    this.store.tx(() => {
      for (const o of olds) this.deleteTopic(o.id)
      for (const it of items) {
        const oldId = match.get(it.topic.id)
        let t = it.topic
        if (oldId) {
          const o = oldById.get(oldId)!
          usedOld.add(oldId)
          if (hasHistory(o)) carried++
          t = carryHistory(t, o)
          t.id = o.id // keep the id so deadlines and quizzes stay linked
        }
        this.saveTopic(t, it.text)
      }
    })
    const dropped = olds.filter((o) => !usedOld.has(o.id) && hasHistory(o)).length
    return { carried, dropped }
  }

  /** Create provisional topics (heading or first-sentence names, never "Part N") for a lesson. */
  provisionalItems(doc: Doc, prep: DocPrep): { topic: Topic; text: string }[] {
    const pace = this.settings().study.pace
    return provisionalTopics(prep.paras, doc.title).map((p, i) => {
      const text = sliceText(prep.paras, p.start, p.end)
      return {
        topic: this.newTopic({
          docId: doc.id, courseId: doc.courseId, name: p.name, unit: p.unit, ord: i, start: p.start, end: p.end,
          words: p.words, minutes: suggestedMinutes(p.words, null, pace), provisional: true
        }),
        text
      }
    })
  }

  mergeTopics(ids: string[], name?: string): string {
    const ts = ids.map((id) => this.store.get<Topic>('topics', id)).filter((t): t is Topic => !!t)
    if (ts.length < 2) throw new Error('Select at least two topics to merge')
    const base = [...ts].sort((a, b) => (b.reviews.length - a.reviews.length) || (b.spent - a.spent) || (a.ord - b.ord))[0]
    const ordered = [...ts].sort((a, b) => (a.docId === b.docId ? a.ord - b.ord : a.docId.localeCompare(b.docId)))
    const text = ordered.map((t) => this.topicText(t.id)).filter(Boolean).join('\n\n')
    const sameDoc = ts.every((t) => t.docId === base.docId)
    const words = wordCount(text)
    const merged: Topic = {
      ...base,
      name: name?.trim() ? safeName(name, text, base.name) : base.name,
      start: sameDoc && ts.every((t) => t.start != null) ? Math.min(...ts.map((t) => t.start!)) : null,
      end: sameDoc && ts.every((t) => t.end != null) ? Math.max(...ts.map((t) => t.end!)) : null,
      words,
      minutes: suggestedMinutes(words, base.difficulty, this.settings().study.pace),
      spent: ts.reduce((a, t) => a + (t.spent || 0), 0),
      terms: [...new Set(ordered.flatMap((t) => t.terms))].slice(0, 6),
      prereqs: [...new Set(ordered.flatMap((t) => t.prereqs))].slice(0, 3),
      summary: base.summary || ordered.map((t) => t.summary).filter(Boolean).join(' '),
      notes: ordered.map((t) => t.notes).filter((n) => n && n.trim()).join('\n\n'),
      ord: Math.min(...ts.filter((t) => t.docId === base.docId).map((t) => t.ord)),
      provisional: false
    }
    this.store.tx(() => {
      for (const t of ts) if (t.id !== base.id) this.deleteTopic(t.id)
      this.store.del('quizzes', base.id)
      this.saveTopic(merged, text)
      this.renumber(base.docId)
    })
    return base.id
  }

  splitTopic(id: string, at: number, name?: string): string {
    const t = this.store.get<Topic>('topics', id)
    if (!t) throw new Error('Topic not found')
    const paras = this.topicText(id).split(/\n{2,}/)
    if (at < 1 || at >= paras.length) throw new Error('Choose a split point between two paragraphs')
    const aText = paras.slice(0, at).join('\n\n')
    const bText = paras.slice(at).join('\n\n')
    const pace = this.settings().study.pace
    const ranged = t.start != null && t.end != null && t.end - t.start + 1 === paras.length
    const aWords = wordCount(aText), bWords = wordCount(bText)
    const a: Topic = { ...t, words: aWords, minutes: suggestedMinutes(aWords, t.difficulty, pace), end: ranged ? t.start! + at - 1 : t.end }
    if (!ranged) { a.start = null; a.end = null }
    const bName = safeName(name || firstSentenceName(bText), bText, t.name)
    const b = this.newTopic({
      docId: t.docId, courseId: t.courseId, name: bName, unit: t.unit, ord: t.ord + 0.5,
      start: ranged ? t.start! + at : null, end: ranged ? t.end : null, words: bWords,
      minutes: suggestedMinutes(bWords, t.difficulty, pace), difficulty: t.difficulty, terms: [], prereqs: []
    })
    this.store.tx(() => {
      this.store.del('quizzes', t.id)
      this.saveTopic(a, aText)
      this.saveTopic(b, bText)
      this.renumber(t.docId)
    })
    return b.id
  }

  addTopic(input: { docId?: string | null; courseId?: string | null; courseName?: string; lessonTitle?: string; unit?: string; name: string; text: string }): Topic {
    let doc = input.docId ? this.store.get<Doc>('docs', input.docId) : undefined
    if (!doc) {
      const course = input.courseId ? this.store.get<Course>('courses', input.courseId) : this.ensureCourse(input.courseName || 'Unsorted')
      if (!course) throw new Error('Course not found')
      const title = (input.lessonTitle || 'Manual topics').trim()
      doc = this.store.byParent<Doc>('docs', course.id).find((d) => d.title.toLowerCase() === title.toLowerCase())
      if (!doc) {
        doc = {
          id: uid(), courseId: course.id, title, titleLocked: true, fileName: '', path: '', ext: 'manual', hash: '', words: 0,
          paraCount: 0, windows: 0, winsDone: 0, status: 'organized', error: null, importNote: null, createdAt: this.now(), updatedAt: this.now()
        }
        this.store.put('docs', doc)
      }
    }
    const words = wordCount(input.text)
    const ord = this.store.byParent<Topic>('topics', doc.id).length
    const name = safeName(input.name, input.text, doc.title)
    const t = this.newTopic({
      docId: doc.id, courseId: doc.courseId, name, unit: input.unit?.trim() || doc.title, ord, words,
      minutes: suggestedMinutes(words, null, this.settings().study.pace), manual: true
    })
    this.saveTopic(t, input.text.trim())
    return t
  }

  // ---------- reviews and overrides ----------
  review(topicId: string, r: ReviewInput, countDaily = true): void {
    const t = this.store.get<Topic>('topics', topicId)
    if (!t) return
    this.store.put('topics', applyReview(t, r))
    if (countDaily) this.addDaily(r.minutes, r.rating ? 1 : 0, r.at)
  }

  addDaily(minutes: number, topics: number, at = this.now()): void {
    const id = dayKey(at)
    const d = this.store.get<Daily>('daily', id) ?? { id, minutes: 0, topics: 0, goal: null }
    this.store.put('daily', { ...d, minutes: Math.round((d.minutes + Math.max(0, minutes)) * 10) / 10, topics: d.topics + topics })
  }

  setDayGoal(goal: Daily['goal']): void {
    const id = dayKey(this.now())
    const d = this.store.get<Daily>('daily', id) ?? { id, minutes: 0, topics: 0, goal: null }
    this.store.put('daily', { ...d, goal })
  }

  override(id: string, a: OverrideAction): void {
    const t = this.store.get<Topic>('topics', id)
    if (!t) return
    const now = this.now()
    let n: Topic
    switch (a.kind) {
      case 'due': n = setDue(t, a.at, now); break
      case 'dueNow': n = setDue(t, now, now); break
      case 'push': n = setDue(t, addTime(Math.max(now, t.due ?? now), a.amount, a.unit), now); break
      case 'solid': n = markSolid(t, now); break
      case 'reset': n = resetSched(t); break
      case 'score': n = { ...t, override: clamp(Math.round(a.value), 0, 100) }; break
      case 'clearScore': n = { ...t, override: null }; break
    }
    this.store.put('topics', n)
  }

  snapshotToday(): boolean {
    const id = dayKey(this.now())
    if (this.store.get<Snapshot>('snapshots', id)) return false
    const now = this.now()
    const ts = this.store.all<Topic>('topics')
    const s: Snapshot = { id, avg: 0, solid: 0, progress: 0, review: 0, fresh: 0, total: ts.length }
    let sum = 0
    for (const t of ts) {
      sum += mastery(t, now)
      const st = status(t, now)
      if (st === 'solid') s.solid++
      else if (st === 'progress') s.progress++
      else if (st === 'review') s.review++
      else s.fresh++
    }
    s.avg = ts.length ? Math.round(sum / ts.length) : 0
    this.store.put('snapshots', s)
    return true
  }

  // ---------- organize jobs ----------
  createJob(j: Omit<Job, 'id' | 'status' | 'attempts' | 'nextAt' | 'createdAt' | 'priority' | 'error'> & { priority?: number }): Job {
    const job: Job = { id: uid(), status: 'queued', attempts: 0, nextAt: 0, error: null, createdAt: this.now(), priority: j.priority ?? PRIORITY[j.kind], ...j }
    // Ensure strict creation order even within the same millisecond
    const last = this.store.kvGet<number>('jobSeq') ?? 0
    job.createdAt = Math.max(job.createdAt, last + 1)
    this.store.kvSet('jobSeq', job.createdAt)
    this.store.put('jobs', job)
    return job
  }

  windowsFor(docId: string): { prep: DocPrep; wins: ReturnType<typeof buildWindows> } | null {
    const prep = this.docPrep(docId)
    if (!prep || !prep.paras.length) return null
    return { prep, wins: buildWindows(prep.paras, this.settings().ai.windowTokens) }
  }

  windowCost(prep: DocPrep, tokens: number): number {
    const overhead = estTokens(ORGANIZE_SYSTEM.length + prep.outline.length + 300)
    return tokens + overhead
  }

  enqueueOrganize(docId: string, fresh = false): number {
    const doc = this.store.get<Doc>('docs', docId)
    const w = this.windowsFor(docId)
    if (!doc) return 0
    if (!w) {
      this.store.put('docs', { ...doc, status: 'error', error: 'No stored text for this lesson. Re-import the file.' })
      return 0
    }
    this.store.tx(() => {
      for (const j of this.store.byParent<Job>('jobs', docId)) if (j.kind === 'organize' && j.status !== 'running') this.store.del('jobs', j.id)
      for (const x of this.store.byParent<{ id: string }>('wins', docId)) this.store.del('wins', x.id)
      w.wins.forEach((win) => {
        this.createJob({
          kind: 'organize', docId, topicId: null, label: `Organize "${doc.title}" (${win.index + 1}/${w.wins.length})`,
          payload: { win: win.index, from: win.from, to: win.to, of: w.wins.length, fresh },
          estTokens: this.windowCost(w.prep, win.tokens)
        })
      })
      this.store.put('docs', { ...doc, status: 'queued', windows: w.wins.length, winsDone: 0, error: null, updatedAt: this.now() })
    })
    return w.wins.length
  }

  estimate(docIds?: string[]): Estimate {
    const s = this.settings()
    const docs = this.store.all<Doc>('docs').filter((d) => (docIds ? docIds.includes(d.id) : d.status === 'awaiting' || d.status === 'needs'))
    let requests = 0, cached = 0, tokens = 0
    for (const d of docs) {
      const w = this.windowsFor(d.id)
      if (!w) continue
      for (const win of w.wins) {
        const key = cacheKey('organize', windowCacheContent({ outline: w.prep.outline, paras: w.prep.paras, from: win.from, to: win.to, first: win.index === 0 }), s.ai.model, s.ai.includeModelInCacheKey)
        if (this.store.get('cache', key)) { cached++; continue }
        requests++
        tokens += this.windowCost(w.prep, win.tokens) + s.ai.maxOutputTokens
      }
    }
    // One request at a time, so time is requests × the measured average request time.
    const minutes = (requests * (this.store.kvGet<number>('avgRequestMs') ?? DEFAULT_REQUEST_MS)) / 60000
    return { docs: docs.length, requests, cached, tokens, minutes: Math.round(minutes * 10) / 10 }
  }

  /** All windows of a lesson are done: build final topics (with history carry-over) and queue ambiguous merges. */
  finalizeDoc(docId: string): { carried: number; dropped: number } | null {
    const doc = this.store.get<Doc>('docs', docId)
    const prep = this.docPrep(docId)
    if (!doc || !prep) return null
    const wins = this.store.byParent<{ id: string; idx: number; result: WinResult }>('wins', docId).sort((a, b) => a.idx - b.idx)
    const final = finalizeWindows(wins.map((w) => w.result), prep.paras, doc.title)
    const pace = this.settings().study.pace
    const title = !doc.titleLocked ? wins[0]?.result.title : null
    const items = final.map((f, i) => ({
      topic: this.newTopic({
        docId, courseId: doc.courseId, name: f.name, unit: f.unit, ord: i, start: f.start, end: f.end, words: f.words,
        minutes: suggestedMinutes(f.words, f.difficulty, pace), summary: f.summary, terms: f.terms, prereqs: f.prereqs,
        difficulty: f.difficulty, provisional: false
      }),
      text: sliceText(prep.paras, f.start, f.end)
    }))
    const res = this.replaceDocTopics(docId, items)
    this.store.tx(() => {
      for (const w of wins) this.store.del('wins', w.id)
      this.store.put('docs', {
        ...doc, title: title || doc.title, status: 'organized', winsDone: doc.windows, error: null, updatedAt: this.now(),
        importNote: res.dropped ? `${res.dropped} earlier topic(s) with study history had no match after organizing.` : doc.importNote ?? null
      })
    })
    const topics = this.store.byParent<Topic>('topics', docId).sort((a, b) => a.ord - b.ord)
    const pairs = ambiguousPairs(topics)
    if (pairs.length) {
      this.createJob({
        kind: 'dedupe', docId, topicId: null, label: `Check similar topics in "${title || doc.title}"`,
        payload: { pairs: pairs.map(([a, b]) => [topics[a].id, topics[b].id]) }, estTokens: 200 + pairs.length * 80
      })
    }
    return res
  }

  dataSnapshot(): DataSnapshot {
    return {
      courses: this.store.all<Course>('courses').sort((a, b) => a.name.localeCompare(b.name)),
      docs: this.store.all<Doc>('docs').sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
      topics: this.store.all<Topic>('topics'),
      deadlines: this.store.all<Deadline>('deadlines').sort((a, b) => a.date.localeCompare(b.date)),
      daily: this.store.all<Daily>('daily').sort((a, b) => a.id.localeCompare(b.id)),
      snapshots: this.store.all<Snapshot>('snapshots').sort((a, b) => a.id.localeCompare(b.id))
    }
  }
}
