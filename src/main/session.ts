// Study session engine. The main process is the timer authority: everything is computed from timestamps,
// state is persisted on every change, so a hidden window, sleep, restart or crash never loses a session.
import type { Deadline, PendingReview, Pool, Rating, RibbonBlock, SessionState, Settings, Suggestion, Topic } from '../shared/types'
import { applyReview, rank, type PickDeadline } from '../shared/sched'
import { parseDayKey } from '../shared/util'
import { uid, type Repo } from './repo'

export interface SessionDeps {
  repo: Repo
  settings: () => Settings
  now?: () => number
  alert: (a: { title: string; body: string; kind: 'work' | 'break' | 'rate' }) => void
  emit: (s: SessionState | null) => void
}

export function pomodoroPlan(s: Settings['pomo']): number[] {
  if (s.perTopic === 'n') return Array.from({ length: Math.max(1, Math.round(s.n)) }, () => s.work)
  if (s.perTopic === 'minutes') {
    const total = Math.max(1, s.minutes)
    const k = Math.ceil(total / s.work)
    const plan = Array.from({ length: k }, () => s.work)
    plan[k - 1] = Math.round((total - (k - 1) * s.work) * 10) / 10
    return plan.filter((m) => m > 0)
  }
  return [s.work]
}

export class SessionEngine {
  state: SessionState | null
  private now: () => number

  constructor(private d: SessionDeps) {
    this.now = d.now ?? Date.now
    this.state = d.repo.store.kvGet<SessionState>('session') ?? null
    if (this.state && !this.state.active) this.state = null
  }

  private save(): void {
    this.d.repo.store.kvSet('session', this.state ?? undefined)
    this.d.emit(this.state ? { ...this.state } : null)
  }

  remainingMs(): number {
    const s = this.state
    if (!s || (s.phase !== 'work' && s.phase !== 'break')) return 0
    return Math.max(0, s.endAt - (s.pausedAt ?? this.now()))
  }

  // ---------- pool and picking ----------
  poolTopics(pool: Pool, sandboxOverlay?: PendingReview[]): Topic[] {
    const all = this.d.repo.store.all<Topic>('topics')
    let ts: Topic[]
    switch (pool.kind) {
      case 'topic': case 'sandbox': ts = all.filter((t) => pool.ids.includes(t.id)); break
      case 'unit': ts = all.filter((t) => t.docId === pool.docId && t.unit === pool.unit); break
      case 'lesson': ts = all.filter((t) => t.docId === pool.docId); break
      case 'course': ts = all.filter((t) => pool.courseIds.includes(t.courseId)); break
      case 'global': ts = all; break
    }
    if (sandboxOverlay?.length) {
      const byId = new Map(ts.map((t) => [t.id, t]))
      for (const r of sandboxOverlay) {
        const t = byId.get(r.topicId)
        if (t) byId.set(t.id, applyReview(t, { rating: r.rating, quiz: r.quiz, minutes: r.minutes, at: r.at }))
      }
      ts = [...byId.values()]
    }
    return ts
  }

  deadlines(): PickDeadline[] {
    return this.d.repo.store.all<Deadline>('deadlines').map((x) => ({
      title: x.title, date: parseDayKey(x.date).getTime() + 12 * 3600000, courseId: x.courseId, docId: x.docId, topicIds: x.topicIds
    }))
  }

  suggest(pool: Pool, sandbox: boolean, limit = 8): Suggestion[] {
    const s = this.state
    const overlay = sandbox && s?.sandbox ? s.sandboxReviews : undefined
    return rank(this.poolTopics(pool, overlay), {
      now: this.now(), lastTopicId: s?.lastTopicId, lastDocId: s?.lastDocId, lastWasReview: s?.lastWasReview, deadlines: this.deadlines()
    }).slice(0, limit)
  }

  // ---------- lifecycle ----------
  start(o: { mode: 'timed' | 'pomodoro'; pool: Pool; poolLabel: string; topicId?: string | null }): SessionState {
    // A suggestion picked from a preview can be merged or replaced before the click lands;
    // refuse it up front instead of leaving an active session with no topic.
    if (o.topicId && !this.d.repo.store.get<Topic>('topics', o.topicId)) {
      throw new Error('That topic no longer exists (it was merged or reorganized). Pick it again from the updated list.')
    }
    const sandbox = o.pool.kind === 'sandbox'
    this.state = {
      active: true, id: uid(), mode: o.mode, pool: o.pool, poolLabel: o.poolLabel, sandbox, phase: 'next', breakKind: null,
      topicId: null, topicName: '', courseId: null, endAt: 0, pausedAt: null, durationMs: 0, workMs: 0, blockIndex: 0,
      blocksForTopic: 0, blockPlan: [], cycles: 0, blocks: [], proposal: null, lastTopicId: null, lastDocId: null,
      lastWasReview: false, sandboxReviews: [], message: null
    }
    const first = o.topicId ?? this.suggest(o.pool, sandbox, 1)[0]?.topicId
    if (!first) { this.state = null; throw new Error('There are no topics in this pool yet.') }
    this.beginTopic(first)
    return this.state!
  }

  private beginTopic(topicId: string): void {
    const s = this.state
    if (!s) return
    const t = this.d.repo.store.get<Topic>('topics', topicId)
    if (!t) { s.message = 'That topic no longer exists.'; this.save(); return }
    const set = this.d.settings()
    const plan = s.mode === 'pomodoro' ? pomodoroPlan(set.pomo) : [set.study.useSuggested ? t.minutes : set.study.minutes]
    s.topicId = t.id
    s.topicName = t.name
    s.courseId = t.courseId
    s.blockPlan = plan
    s.blocksForTopic = plan.length
    s.blockIndex = 0
    s.workMs = 0
    s.phase = 'work'
    s.breakKind = null
    s.pausedAt = null
    s.durationMs = Math.round(plan[0] * 60000)
    s.endAt = this.now() + s.durationMs
    s.proposal = null
    s.passed = []
    s.message = null
    s.blocks = s.blocks.filter((b) => b.state !== 'current')
    s.blocks.push({ topicId: t.id, name: t.name, courseId: t.courseId, state: 'current', minutes: 0 })
    this.save()
  }

  private currentTopic(): Topic | undefined {
    return this.state?.topicId ? this.d.repo.store.get<Topic>('topics', this.state.topicId) : undefined
  }

  /** Called every second by the main process and on powerMonitor resume. */
  tick(): void {
    const s = this.state
    if (!s || s.pausedAt !== null) return
    if (s.phase === 'work' && this.now() >= s.endAt) this.completeWork(false)
    else if (s.phase === 'break' && this.now() >= s.endAt) this.completeBreak()
  }

  private elapsedMs(): number {
    const s = this.state!
    return Math.max(0, s.durationMs - this.remainingMs())
  }

  private completeWork(early: boolean): void {
    const s = this.state!
    s.workMs += early ? this.elapsedMs() : s.durationMs
    s.pausedAt = null
    if (s.mode === 'pomodoro' && !early) s.cycles++
    if (s.mode === 'pomodoro' && !early && s.blockIndex < s.blockPlan.length - 1) {
      this.startBreak()
      this.d.alert({ title: 'Work block done', body: `Take a ${s.breakKind === 'long' ? 'long ' : ''}break. ${s.topicName} continues after it.`, kind: 'break' })
      return
    }
    s.phase = 'rate'
    s.endAt = 0
    this.save()
    if (!early) this.d.alert({ title: "Time's up", body: `Rate how well you know: ${s.topicName}`, kind: 'rate' })
  }

  private startBreak(): void {
    const s = this.state!
    const p = this.d.settings().pomo
    const long = s.cycles > 0 && s.cycles % Math.max(1, p.cycles) === 0
    s.breakKind = long ? 'long' : 'short'
    s.phase = 'break'
    s.durationMs = Math.round((long ? p.long : p.brk) * 60000)
    s.endAt = this.now() + s.durationMs
    s.pausedAt = null
    this.save()
  }

  private completeBreak(): void {
    const s = this.state!
    s.pausedAt = null
    const continuing = s.topicId && s.blocks.some((b) => b.state === 'current') && s.blockIndex < s.blockPlan.length - 1
    if (continuing) {
      s.blockIndex++
      s.phase = 'work'
      s.breakKind = null
      s.durationMs = Math.round(s.blockPlan[s.blockIndex] * 60000)
      s.endAt = this.now() + s.durationMs
      this.save()
      this.d.alert({ title: 'Break over', body: `Back to ${s.topicName}`, kind: 'work' })
      return
    }
    s.phase = 'next'
    s.breakKind = null
    s.endAt = 0
    this.save()
    const next = s.proposal
    this.d.alert({ title: 'Break over', body: next ? `Next: ${next.name}` : 'Pick the next topic', kind: 'work' })
    if (next && this.d.settings().pomo.autoStartNext) this.beginTopic(next.topicId)
  }

  pause(): void {
    const s = this.state
    if (!s || (s.phase !== 'work' && s.phase !== 'break') || s.pausedAt !== null) return
    s.pausedAt = this.now()
    this.save()
  }

  resume(): void {
    const s = this.state
    if (!s || s.pausedAt === null) return
    s.endAt += this.now() - s.pausedAt
    s.pausedAt = null
    this.save()
  }

  extend(minutes: number): void {
    const s = this.state
    if (!s) return
    if (s.phase === 'rate') { // reopen the block with extra time
      s.phase = 'work'
      s.durationMs = Math.round(minutes * 60000)
      s.endAt = this.now() + s.durationMs
      s.workMs = Math.max(0, s.workMs)
      this.save()
      return
    }
    if (s.phase !== 'work' && s.phase !== 'break') return
    s.endAt += minutes * 60000
    s.durationMs += minutes * 60000
    this.save()
  }

  endEarly(): void {
    const s = this.state
    if (!s || s.phase !== 'work') return
    this.completeWork(true)
  }

  /** Skip the current topic: records time spent only. During a break it skips the break. */
  skip(): void {
    const s = this.state
    if (!s) return
    if (s.phase === 'break') { this.completeBreak(); return }
    if (s.phase === 'next') { if (s.proposal) this.accept(s.proposal.topicId); return }
    if (s.phase === 'work' || s.phase === 'rate') this.rate({ rating: null }) // rate() adds running work time
  }

  /** Pass on the suggested next topic and propose the next-ranked one instead. Passed topics come back
   *  once another topic has been started. */
  skipSuggestion(): void {
    const s = this.state
    if (!s || !s.proposal || (s.phase !== 'next' && s.phase !== 'break')) return
    const passed = [...(s.passed ?? []), s.proposal.topicId]
    const next = this.suggest(s.pool, s.sandbox, Infinity).find((x) => !passed.includes(x.topicId))
    if (!next) { s.message = 'No other topics to suggest in this pool.'; this.save(); return }
    s.passed = passed
    s.proposal = next
    s.message = null
    this.save()
  }

  skipBreak(): void {
    if (this.state?.phase === 'break') this.completeBreak()
  }

  rate(r: { rating: Rating | null; quiz?: number | null; note?: string }): void {
    const s = this.state
    if (!s || !s.topicId || (s.phase !== 'rate' && s.phase !== 'work')) return
    if (s.phase === 'work') s.workMs += this.elapsedMs()
    const t = this.currentTopic()
    const minutes = Math.round((s.workMs / 60000) * 10) / 10
    const at = this.now()
    if (t) {
      if (s.sandbox) s.sandboxReviews.push({ topicId: t.id, rating: r.rating, quiz: r.quiz ?? null, minutes, note: r.note, at })
      else this.d.repo.review(t.id, { rating: r.rating, quiz: r.quiz ?? null, minutes, note: r.note, at })
    }
    const cur = s.blocks.find((b) => b.state === 'current')
    if (cur) Object.assign(cur, { state: r.rating ? 'rated' : 'skipped', rating: r.rating, minutes } satisfies Partial<RibbonBlock>)
    s.lastTopicId = s.topicId
    s.lastDocId = t?.docId ?? null
    s.lastWasReview = !!t?.due
    s.workMs = 0
    s.pausedAt = null
    s.proposal = this.suggest(s.pool, s.sandbox, 1)[0] ?? null
    if (s.mode === 'pomodoro') {
      if (s.blockIndex < s.blockPlan.length - 1) s.cycles++ // skipped mid-topic: count the partial block
      this.startBreak()
      return
    }
    s.phase = 'next'
    s.endAt = 0
    this.save()
  }

  accept(topicId?: string | null): void {
    const s = this.state
    if (!s) return
    const id = topicId ?? s.proposal?.topicId
    if (!id) { s.message = 'Nothing left to suggest in this pool.'; this.save(); return }
    if (s.phase === 'work') return
    this.beginTopic(id)
  }

  /** End the session. Running work time is recorded (time only). Sandbox sessions wait for save/discard. */
  end(): void {
    const s = this.state
    if (!s) return
    if (s.phase === 'work' || s.phase === 'rate') {
      if (s.phase === 'work') s.workMs += this.elapsedMs()
      if (s.workMs > 30000 && s.topicId) {
        const minutes = Math.round((s.workMs / 60000) * 10) / 10
        if (s.sandbox) s.sandboxReviews.push({ topicId: s.topicId, rating: null, minutes, at: this.now() })
        else this.d.repo.review(s.topicId, { rating: null, minutes, at: this.now() })
        const cur = s.blocks.find((b) => b.state === 'current')
        if (cur) Object.assign(cur, { state: 'skipped', minutes })
      }
    }
    if (s.sandbox && s.sandboxReviews.length) {
      s.phase = 'done'
      s.endAt = 0
      s.pausedAt = null
      s.blocks = s.blocks.filter((b) => b.state !== 'current')
      this.save()
      return
    }
    this.state = null
    this.save()
  }

  sandboxCommit(save: boolean): void {
    const s = this.state
    if (!s) return
    if (save) for (const r of s.sandboxReviews) this.d.repo.review(r.topicId, { rating: r.rating, quiz: r.quiz, minutes: r.minutes, note: r.note, at: r.at })
    this.state = null
    this.save()
  }
}
