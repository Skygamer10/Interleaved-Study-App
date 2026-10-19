import { describe, expect, it } from 'vitest'
import { SessionEngine, pomodoroPlan } from '../src/main/session'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import type { SessionState, Topic } from '../src/shared/types'
import { setup } from './helpers'

function env() {
  const e = setup()
  const course = e.repo.ensureCourse('Bio')
  const mk = (name: string, lesson: string) => e.repo.addTopic({ courseId: course.id, lessonTitle: lesson, name, text: `${name} text. `.repeat(30) })
  const a = mk('Osmosis', 'L1'), b = mk('Diffusion', 'L1'), c = mk('Pumps', 'L2')
  let now = Date.UTC(2026, 9, 11, 9)
  const alerts: string[] = []
  const emitted: (SessionState | null)[] = []
  const engine = new SessionEngine({ repo: e.repo, settings: () => e.settings, now: () => now, alert: (x) => alerts.push(x.title), emit: (s) => emitted.push(s) })
  return { ...e, a, b, c, engine, alerts, emitted, adv: (ms: number) => { now += ms; engine.tick() }, getNow: () => now }
}

describe('pomodoro plan', () => {
  it('splits custom minutes into work blocks, shortening the last one', () => {
    expect(pomodoroPlan({ ...DEFAULT_SETTINGS.pomo, perTopic: 'minutes', minutes: 40 })).toEqual([25, 15])
    expect(pomodoroPlan({ ...DEFAULT_SETTINGS.pomo, perTopic: 'n', n: 3 })).toEqual([25, 25, 25])
    expect(pomodoroPlan(DEFAULT_SETTINGS.pomo)).toEqual([25])
  })
})

describe('timed session (main-process timer authority)', () => {
  it('counts down from timestamps, survives pause, asks for a rating and proposes the next topic', () => {
    const x = env()
    x.settings.study.minutes = 1
    x.engine.start({ mode: 'timed', pool: { kind: 'global' }, poolLabel: 'All', topicId: x.a.id })
    expect(x.engine.state!.phase).toBe('work')
    x.adv(20_000)
    x.engine.pause()
    x.adv(10 * 60_000) // paused for 10 minutes (e.g. the Mac slept)
    expect(x.engine.state!.phase).toBe('work')
    expect(x.engine.remainingMs()).toBe(40_000)
    x.engine.resume()
    x.adv(40_000)
    expect(x.engine.state!.phase).toBe('rate')
    expect(x.alerts).toContain("Time's up")
    x.engine.rate({ rating: 'okay' })
    const t = x.store.get<Topic>('topics', x.a.id)!
    expect(t.reviews).toHaveLength(1)
    expect(t.spent).toBe(1)
    const s = x.engine.state!
    expect(s.phase).toBe('next')
    expect(s.proposal).not.toBeNull()
    expect(s.proposal!.topicId).not.toBe(x.a.id) // never back to back
    expect(s.blocks[0]).toMatchObject({ state: 'rated', rating: 'okay' })
  })

  it('skipping the suggestion proposes the next-ranked topic, then resets once a topic starts', () => {
    const x = env()
    x.engine.start({ mode: 'timed', pool: { kind: 'global' }, poolLabel: 'All', topicId: x.a.id })
    x.engine.rate({ rating: 'okay' })
    const first = x.engine.state!.proposal!.topicId
    x.engine.skipSuggestion()
    const second = x.engine.state!.proposal!.topicId
    expect(second).not.toBe(first)
    expect(second).not.toBe(x.a.id) // the just-studied topic is ranked last, not removed
    x.engine.skipSuggestion()
    expect([first, second]).not.toContain(x.engine.state!.proposal!.topicId)
    x.engine.skipSuggestion() // nothing left that has not been passed
    expect(x.engine.state!.message).toMatch(/No other topics/)
    x.engine.accept()
    expect(x.engine.state!.passed).toEqual([])
  })

  it('skip records time only; the state is persisted and restored', () => {
    const x = env()
    x.engine.start({ mode: 'timed', pool: { kind: 'lesson', docId: x.a.docId }, poolLabel: 'L1', topicId: x.a.id })
    x.adv(5 * 60_000)
    x.engine.skip()
    const t = x.store.get<Topic>('topics', x.a.id)!
    expect(t.reviews).toHaveLength(0)
    expect(t.spent).toBe(5)
    expect(x.engine.state!.proposal!.topicId).toBe(x.b.id) // only L1 topics in the pool
    x.engine.accept()
    const restored = new SessionEngine({ repo: x.repo, settings: () => x.settings, now: x.getNow, alert: () => {}, emit: () => {} })
    expect(restored.state!.topicId).toBe(x.b.id)
    expect(restored.state!.phase).toBe('work')
  })

  it('completes a block that ended while the app was closed', () => {
    const x = env()
    x.settings.study.minutes = 1
    x.engine.start({ mode: 'timed', pool: { kind: 'global' }, poolLabel: 'All', topicId: x.a.id })
    x.adv(0)
    let now = x.getNow() + 5 * 60_000
    const restored = new SessionEngine({ repo: x.repo, settings: () => x.settings, now: () => now, alert: () => {}, emit: () => {} })
    restored.tick()
    expect(restored.state!.phase).toBe('rate')
    now += 1
  })
})

describe('interleaved Pomodoro', () => {
  it('runs N blocks per topic with breaks and a long break after the set cycles', () => {
    const x = env()
    Object.assign(x.settings.pomo, { work: 1, brk: 1, long: 3, cycles: 2, perTopic: 'n', n: 2 })
    x.engine.start({ mode: 'pomodoro', pool: { kind: 'global' }, poolLabel: 'All', topicId: x.a.id })
    x.adv(60_000)
    expect(x.engine.state!.phase).toBe('break')
    expect(x.engine.state!.breakKind).toBe('short')
    x.adv(60_000)
    expect(x.engine.state!).toMatchObject({ phase: 'work', blockIndex: 1, topicId: x.a.id })
    x.adv(60_000)
    expect(x.engine.state!.phase).toBe('rate')
    x.engine.rate({ rating: 'solid' })
    expect(x.engine.state!.phase).toBe('break')
    expect(x.engine.state!.breakKind).toBe('long') // 2 cycles done
    expect(x.store.get<Topic>('topics', x.a.id)!.spent).toBe(2)
    x.adv(3 * 60_000)
    expect(x.engine.state!.phase).toBe('next')
    x.engine.accept()
    expect(x.engine.state!.topicId).not.toBe(x.a.id)
  })
})

describe('sandbox', () => {
  it('keeps ratings off the schedule until saved', () => {
    const x = env()
    x.engine.start({ mode: 'timed', pool: { kind: 'sandbox', ids: [x.a.id, x.c.id] }, poolLabel: 'Sandbox', topicId: x.a.id })
    x.adv(2 * 60_000)
    x.engine.endEarly()
    x.engine.rate({ rating: 'solid' })
    expect(x.store.get<Topic>('topics', x.a.id)!.reviews).toHaveLength(0)
    expect(x.engine.state!.proposal!.topicId).toBe(x.c.id)
    x.engine.end()
    expect(x.engine.state!.phase).toBe('done')
    x.engine.sandboxCommit(true)
    expect(x.engine.state).toBeNull()
    expect(x.store.get<Topic>('topics', x.a.id)!.reviews).toHaveLength(1)
  })
  it('discard leaves the schedule untouched', () => {
    const x = env()
    x.engine.start({ mode: 'timed', pool: { kind: 'sandbox', ids: [x.a.id] }, poolLabel: 'Sandbox', topicId: x.a.id })
    x.adv(60_000)
    x.engine.endEarly()
    x.engine.rate({ rating: 'lost' })
    x.engine.end()
    x.engine.sandboxCommit(false)
    expect(x.store.get<Topic>('topics', x.a.id)!.reviews).toHaveLength(0)
  })
})

describe('starting while topics change underneath', () => {
  it('the global pool computes the same topics for preview and start, even after a merge', () => {
    const x = env()
    const preview = x.engine.suggest({ kind: 'global' }, false)
    expect(preview).toHaveLength(3)
    x.repo.mergeTopics([x.a.id, x.b.id]) // e.g. "Check similar topics" finishing between preview and click
    const s = x.engine.start({ mode: 'timed', pool: { kind: 'global' }, poolLabel: 'All' })
    expect(s.phase).toBe('work')
    expect(x.store.get<Topic>('topics', s.topicId!)).toBeDefined()
  })

  it('refuses a picked topic that was merged away instead of leaving an empty active session', () => {
    const x = env()
    const kept = x.repo.mergeTopics([x.a.id, x.b.id])
    const gone = kept === x.a.id ? x.b.id : x.a.id
    expect(() => x.engine.start({ mode: 'timed', pool: { kind: 'global' }, poolLabel: 'All', topicId: gone })).toThrow(/no longer exists/)
    expect(x.engine.state).toBeNull()
  })
})
