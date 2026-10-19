// Session view: choose a pool and mode, then study timed blocks or Pomodoros, rate, quiz, and accept or
// override the next suggestion. All timing lives in the main process, so switching views never loses it.
import { useEffect, useMemo, useState } from 'react'
import type { Pool, Rating, Suggestion } from '../../../shared/types'
import { RATINGS } from '../../../shared/sched'
import { api } from '../api'
import { courseClass, useAction, useApp } from '../state'
import { Icon } from '../icons'
import { Confirm, Deck, Empty, deckName, fmtClock, fmtMin, Spinner } from '../ui'
import { QuizPanel } from '../components/Quiz'
import { useCountdown } from '../components/Ribbon'

const RATE_HELP: Record<Rating, string> = {
  lost: 'Could not recall the main ideas', shaky: 'Partly, with gaps', okay: 'Mostly, with some effort', solid: 'Clearly and confidently'
}
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)

let handledQuick = 0

type PoolKind = 'global' | 'course' | 'lesson' | 'unit' | 'topic' | 'sandbox'

function Suggestions({ items, onPick, busy }: { items: Suggestion[] | null; onPick: (id: string) => void; busy?: boolean }) {
  const { topics, courses } = useApp()
  if (!items) return <Spinner />
  if (!items.length) return <div className="muted">No topics in this pool.</div>
  return (
    <div>
      {items.map((s) => (
        <button key={s.topicId} className={`sugg ${courseClass(courses.get(topics.get(s.topicId)?.courseId ?? ''))}`} disabled={busy} onClick={() => onPick(s.topicId)}>
          <span className="dot" /><span className="n">{s.name} <Deck topicId={s.topicId} /></span><span className="num muted small">{s.score.toFixed(2)}</span>
          <span className="why">{s.reason}</span>
        </button>
      ))}
    </div>
  )
}

function StartPanel() {
  const { data, settings, saveSettings, quickstart, scope } = useApp()
  const act = useAction()
  const [mode, setMode] = useState<'timed' | 'pomodoro'>(() => (localStorage.getItem('mode') as 'timed' | 'pomodoro') || 'timed')
  const initialKind: PoolKind = scope.kind === 'course' ? 'course' : scope.kind === 'lesson' ? 'lesson' : scope.kind === 'unit' ? 'unit' : 'global'
  const [kind, setKind] = useState<PoolKind>(initialKind)
  const [courseIds, setCourseIds] = useState<string[]>(scope.kind === 'course' ? [scope.id] : [])
  const [docId, setDocId] = useState(scope.kind === 'lesson' ? scope.id : scope.kind === 'unit' ? scope.docId : data?.docs[0]?.id ?? '')
  const [unit, setUnit] = useState(scope.kind === 'unit' ? scope.unit : '')
  const [ids, setIds] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<Suggestion[] | null>(null)

  const units = useMemo(() => [...new Set((data?.topics ?? []).filter((t) => t.docId === docId).sort((a, b) => a.ord - b.ord).map((t) => t.unit))], [data, docId])
  useEffect(() => { if (kind === 'unit' && !units.includes(unit)) setUnit(units[0] ?? '') }, [kind, units, unit])

  const pool: Pool | null = useMemo(() => {
    switch (kind) {
      case 'global': return { kind: 'global' }
      case 'course': return courseIds.length ? { kind: 'course', courseIds } : null
      case 'lesson': return docId ? { kind: 'lesson', docId } : null
      case 'unit': return docId && unit ? { kind: 'unit', docId, unit } : null
      case 'topic': return ids.length ? { kind: 'topic', ids: ids.slice(0, 1) } : null
      case 'sandbox': return ids.length ? { kind: 'sandbox', ids } : null
    }
  }, [kind, courseIds, docId, unit, ids])

  const label = (): string => {
    if (!data) return ''
    if (kind === 'global') return 'Everything'
    if (kind === 'course') return courseIds.map((id) => data.courses.find((c) => c.id === id)?.name).join(', ')
    if (kind === 'lesson') return data.docs.find((d) => d.id === docId)?.title ?? 'Lesson'
    if (kind === 'unit') return unit
    if (kind === 'topic') return data.topics.find((t) => t.id === ids[0])?.name ?? 'Topic'
    return `Sandbox of ${ids.length} topics`
  }

  useEffect(() => {
    if (!pool) { setPreview([]); return }
    let live = true
    setPreview(null)
    api.sessionPreview(pool, pool.kind === 'sandbox').then((s) => { if (live) setPreview(s) }).catch(() => live && setPreview([]))
    return () => { live = false }
  }, [pool, data])

  const start = async (topicId?: string): Promise<void> => {
    if (!pool) return
    localStorage.setItem('mode', mode)
    await act(() => api.sessionStart({ mode, pool, poolLabel: label(), topicId: topicId ?? null }))
  }

  useEffect(() => {
    if (quickstart > handledQuick) { handledQuick = quickstart; void start() }
  }) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !settings) return null
  if (!data.topics.length) return <Empty title="No topics to study yet"><p>Import lessons on the Topics page first.</p></Empty>

  const toggleId = (id: string, multi: boolean): void => setIds((p) => (multi ? (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]) : [id]))
  const filtered = data.topics.filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase())).slice(0, 300)

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Start a session</h1>
        <div className="cols">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <h2>Mode</h2>
              <div className="seg" role="group" aria-label="Mode">
                <button aria-pressed={mode === 'timed'} onClick={() => setMode('timed')}>Timed topics</button>
                <button aria-pressed={mode === 'pomodoro'} onClick={() => setMode('pomodoro')}>Interleaved Pomodoro</button>
              </div>
              {mode === 'timed' ? (
                <div className="row-flex" style={{ marginTop: 8 }}>
                  <span>Each topic gets</span>
                  <input className="input num" type="number" min={1} max={240} style={{ width: 70 }} value={settings.study.minutes}
                    onChange={(e) => void saveSettings({ study: { minutes: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Minutes per topic" />
                  <span>minutes</span>
                  <label className="check"><input type="checkbox" checked={settings.study.useSuggested} onChange={(e) => void saveSettings({ study: { useSuggested: e.target.checked } })} /><span>Use each topic’s suggested time instead</span></label>
                </div>
              ) : (
                <div className="row-flex" style={{ marginTop: 8 }}>
                  <span>Work</span><input className="input num" type="number" min={1} style={{ width: 60 }} value={settings.pomo.work} onChange={(e) => void saveSettings({ pomo: { work: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Work minutes" />
                  <span>break</span><input className="input num" type="number" min={1} style={{ width: 60 }} value={settings.pomo.brk} onChange={(e) => void saveSettings({ pomo: { brk: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Break minutes" />
                  <span>long break</span><input className="input num" type="number" min={1} style={{ width: 60 }} value={settings.pomo.long} onChange={(e) => void saveSettings({ pomo: { long: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Long break minutes" />
                  <span>every</span><input className="input num" type="number" min={1} style={{ width: 54 }} value={settings.pomo.cycles} onChange={(e) => void saveSettings({ pomo: { cycles: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Cycles before long break" /><span>blocks</span>
                  <select className="input" style={{ width: 'auto' }} value={settings.pomo.perTopic} onChange={(e) => void saveSettings({ pomo: { perTopic: e.target.value as 'one' | 'n' | 'minutes' } })} aria-label="Topic length">
                    <option value="one">1 Pomodoro per topic</option><option value="n">N Pomodoros per topic</option><option value="minutes">Custom minutes per topic</option>
                  </select>
                  {settings.pomo.perTopic === 'n' && <input className="input num" type="number" min={1} style={{ width: 54 }} value={settings.pomo.n} onChange={(e) => void saveSettings({ pomo: { n: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Pomodoros per topic" />}
                  {settings.pomo.perTopic === 'minutes' && <><input className="input num" type="number" min={1} style={{ width: 64 }} value={settings.pomo.minutes} onChange={(e) => void saveSettings({ pomo: { minutes: Math.max(1, Number(e.target.value) || 1) } })} aria-label="Minutes per topic" /><span>min</span></>}
                </div>
              )}
            </div>
            <div>
              <h2>What to interleave</h2>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as PoolKind)} aria-label="Pool">
                <option value="global">Everything</option>
                <option value="course">One or more courses</option>
                <option value="lesson">One lesson</option>
                <option value="unit">One unit</option>
                <option value="topic">One topic</option>
                <option value="sandbox">Sandbox: hand-picked topics, kept off the schedule</option>
              </select>
              <div style={{ marginTop: 8 }}>
                {kind === 'course' && <div className="pick-list">{data.courses.map((c) => (
                  <label key={c.id} className="check"><input type="checkbox" checked={courseIds.includes(c.id)} onChange={() => setCourseIds((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))} /><span>{c.name}</span></label>
                ))}</div>}
                {(kind === 'lesson' || kind === 'unit') && (
                  <select className="input" value={docId} onChange={(e) => setDocId(e.target.value)} aria-label="Lesson">
                    {data.courses.map((c) => <optgroup key={c.id} label={c.name}>{data.docs.filter((d) => d.courseId === c.id).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</optgroup>)}
                  </select>
                )}
                {kind === 'unit' && <select className="input" style={{ marginTop: 6 }} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit">{units.map((u) => <option key={u} value={u}>{u}</option>)}</select>}
                {(kind === 'topic' || kind === 'sandbox') && (
                  <>
                    <input className="input" placeholder="Filter topics" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 6 }} />
                    <div className="pick-list">{filtered.map((t) => (
                      <label key={t.id} className="check"><input type={kind === 'topic' ? 'radio' : 'checkbox'} name="pick" checked={ids.includes(t.id)} onChange={() => toggleId(t.id, kind === 'sandbox')} /><span><span className="serif">{t.name}</span> <Deck topicId={t.id} /></span></label>
                    ))}</div>
                    {kind === 'sandbox' && <p className="help">Ratings in a sandbox stay separate. At the end you choose to save them to the schedule or discard them.</p>}
                  </>
                )}
              </div>
            </div>
            <div className="row-flex">
              <button className="btn primary" disabled={!pool || !preview?.length} onClick={() => void start()}><Icon.play /> Start with the top suggestion <kbd>S</kbd></button>
            </div>
          </div>
          <div>
            <h2>Suggested order</h2>
            <p className="help">Overdue reviews come first, new material is mixed in, the same lesson is not repeated back to back, and close deadlines add priority. Click any topic to start with it.</p>
            <Suggestions items={preview} onPick={(id) => void start(id)} />
          </div>
        </div>
      </div>
    </div>
  )
}

export function SessionView() {
  const { session, topics, docs, courses, pending, setPending, data } = useApp()
  const act = useAction()
  const left = useCountdown()
  const [quiz, setQuiz] = useState(false)
  const [others, setOthers] = useState<Suggestion[] | null>(null)
  const [confirmEnd, setConfirmEnd] = useState(false)

  useEffect(() => { setQuiz(false); setOthers(null) }, [session?.topicId, session?.phase])
  useEffect(() => {
    if (!session || session.phase === 'work') return
    let live = true
    api.sessionPreview(session.pool, session.sandbox).then((s) => { if (live) setOthers(s) }).catch(() => live && setOthers([]))
    return () => { live = false }
  }, [session?.phase, session?.topicId, session?.pool, session?.sandbox, data]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return <StartPanel />
  const t = session.topicId ? topics.get(session.topicId) : undefined
  const d = t ? docs.get(t.docId) : undefined
  const c = t ? courses.get(t.courseId) : undefined
  const paused = session.pausedAt !== null
  const pick = (id: string): void => void act(() => api.sessionAccept(id))

  return (
    <div className="session">
      <section className="stage">
        {session.message && <div className="banner alert">{session.message}</div>}
        {session.phase === 'done' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 className="topic-title">Sandbox finished</h2>
            <p>{session.sandboxReviews.length} block(s) recorded in this sandbox, {fmtMin(session.sandboxReviews.reduce((a, r) => a + r.minutes, 0))} in total. They have not touched your schedule.</p>
            <div className="row-flex">
              <button className="btn primary" onClick={() => void act(() => api.sessionSandbox(true), 'Saved to schedule')}>Save to schedule</button>
              <button className="btn" onClick={() => void act(() => api.sessionSandbox(false), 'Sandbox discarded')}>Discard</button>
            </div>
          </div>
        ) : (
          <>
            <div>
              {session.phase === 'next'
                ? <div className="muted">Finished: {session.blocks.filter((b) => b.state !== 'current').slice(-1)[0]?.name ?? session.topicName}</div>
                : <div className={`row-flex muted ${courseClass(c)}`}><span className="dot" /><span>{c?.name}{d ? ` / ${d.title}` : ''}</span></div>}
              {session.phase !== 'next' && session.phase !== 'break' && d && <div className="deck-big"><Icon.file /> Study from: <b>{deckName(d)}</b></div>}
              <h2 className="topic-title sel">{session.phase === 'break' ? (session.breakKind === 'long' ? 'Long break' : 'Break') : session.phase === 'next' ? 'Choose the next topic' : session.topicName}</h2>
              {session.phase === 'break' && session.blockIndex < session.blockPlan.length - 1 && <div className="muted">Then back to {session.topicName} (block {session.blockIndex + 2} of {session.blocksForTopic}).</div>}
            </div>
            {(session.phase === 'work' || session.phase === 'break') && (
              <div>
                <div className={`big-time${paused ? ' muted' : ''}`}>{fmtClock(left)}</div>
                <div className="muted">{paused ? 'Paused' : session.phase === 'work' ? `${session.mode === 'pomodoro' ? `Pomodoro ${session.blockIndex + 1} of ${session.blocksForTopic}` : 'Timed block'}` : 'Stand up, look away, drink water.'}</div>
                <div className="row-flex" style={{ marginTop: 14 }}>
                  <button className="btn primary" onClick={() => void act(() => (paused ? api.sessionResume() : api.sessionPause()))}>{paused ? <><Icon.play /> Resume</> : <><Icon.pause /> Pause</>} <kbd>space</kbd></button>
                  <button className="btn" onClick={() => void act(() => api.sessionExtend(5))}><Icon.plus /> 5 min</button>
                  {session.phase === 'work' && <button className="btn" onClick={() => void act(() => api.sessionSkip())} title="Records time spent only"><Icon.skip /> Skip topic <kbd>N</kbd></button>}
                  {session.phase === 'work' && <button className="btn" onClick={() => void act(() => api.sessionEndEarly())}><Icon.check /> Done, rate now</button>}
                  {session.phase === 'break' && <button className="btn" onClick={() => void act(() => api.sessionSkipBreak())}><Icon.skip /> Skip break <kbd>N</kbd></button>}
                </div>
              </div>
            )}
            {session.phase === 'rate' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>How well do you know it now?</div>
                <div className="rate-row" role="group" aria-label="Rating">
                  {RATINGS.map((r, i) => (
                    <button key={r} className="rate" aria-pressed={pending.rating === r} onClick={() => setPending({ rating: r })}>
                      <b>{cap(r)} <span className="kbd">{i + 1}</span></b><span>{RATE_HELP[r]}</span>
                    </button>
                  ))}
                </div>
                <div className="row-flex">
                  {pending.quiz !== null ? <span>Quiz score {Math.round(pending.quiz * 100)}% (counts double)</span> : <button className="btn" onClick={() => setQuiz((x) => !x)}><Icon.quiz /> Quick quiz</button>}
                </div>
                {quiz && pending.quiz === null && <div className="section-rule"><QuizPanel topicId={session.topicId!} onScore={(q) => { setPending({ quiz: q }); setQuiz(false) }} /></div>}
                <textarea className="input serif" rows={2} placeholder="Optional note for this review" value={pending.note} onChange={(e) => setPending({ note: e.target.value })} style={{ maxWidth: 640 }} />
                <div className="row-flex">
                  <button className="btn primary" disabled={!pending.rating} onClick={() => void act(() => api.sessionRate({ rating: pending.rating, quiz: pending.quiz, note: pending.note || undefined }))}>Save rating <kbd>Enter</kbd></button>
                  <button className="btn" onClick={() => void act(() => api.sessionRate({ rating: null }))} title="Records the time without a rating">Skip rating</button>
                  <button className="btn ghost" onClick={() => void act(() => api.sessionExtend(5))}>Keep going 5 more min</button>
                </div>
              </div>
            )}
            {(session.phase === 'next' || session.phase === 'break') && (
              <div className="section-rule" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {session.proposal ? (
                  <>
                    <div className="muted">Up next</div>
                    <div className="serif" style={{ fontSize: 22 }}>{session.proposal.name}</div>
                    <div><Deck topicId={session.proposal.topicId} /></div>
                    <div className="help">{session.proposal.reason}</div>
                    <div className="row-flex">
                      <button className="btn primary" onClick={() => pick(session.proposal!.topicId)}><Icon.play /> {session.phase === 'break' ? 'Start it now' : 'Start'} <kbd>Enter</kbd></button>
                      <button className="btn" onClick={() => void act(() => api.sessionSkipSuggestion())} title="Suggest a different topic instead"><Icon.skip /> Skip suggestion <kbd>X</kbd></button>
                    </div>
                  </>
                ) : <div className="muted">Nothing left to suggest in this pool. Pick a topic below or end the session.</div>}
              </div>
            )}
          </>
        )}
      </section>
      <aside className="side">
        <div>
          <div className="muted small">{session.mode === 'pomodoro' ? 'Interleaved Pomodoro' : 'Timed topics'}{session.sandbox ? ', sandbox' : ''}</div>
          <div className="serif" style={{ fontSize: 17 }}>{session.poolLabel}</div>
        </div>
        {session.phase === 'work' && t && (
          <div>
            {t.summary && <p className="serif" style={{ margin: 0 }}>{t.summary}</p>}
            {t.terms.length > 0 && <div className="terms" style={{ marginTop: 8 }}>{t.terms.map((x) => <span className="chip" key={x}>{x}</span>)}</div>}
          </div>
        )}
        {session.phase !== 'work' && session.phase !== 'done' && (
          <div>
            <h3 className="small muted" style={{ margin: '0 0 4px' }}>Or choose any topic in the pool</h3>
            <Suggestions items={others} onPick={pick} busy={session.phase === 'rate'} />
            {session.phase === 'rate' && <p className="help">Rate or skip the rating first.</p>}
          </div>
        )}
        <div>
          <h3 className="small muted" style={{ margin: '0 0 4px' }}>This session</h3>
          {session.blocks.filter((b) => b.state !== 'current').length === 0 ? <div className="muted small">No finished blocks yet.</div> : (
            <div className="hist">
              {session.blocks.filter((b) => b.state !== 'current').map((b, i) => (
                <div key={i} style={{ display: 'contents' }}>
                  <span className={courseClass(courses.get(b.courseId))}><span className="dot" style={{ display: 'inline-block' }} /></span>
                  <span><span className="serif">{b.name}</span> <Deck topicId={b.topicId} /></span>
                  <span className="muted num">{b.state === 'skipped' ? 'skipped' : b.rating}, {Math.round(b.minutes)}m</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {session.phase !== 'done' && <button className="btn ghost danger" onClick={() => setConfirmEnd(true)}><Icon.stop /> End session</button>}
      </aside>
      {confirmEnd && <Confirm title="End this session?" confirm="End session" body={<p>Time already spent on the current topic is recorded without a rating.{session.sandbox ? ' You can then save the sandbox to your schedule or discard it.' : ''}</p>}
        onNo={() => setConfirmEnd(false)} onYes={() => { setConfirmEnd(false); void act(() => api.sessionEnd()) }} />}
    </div>
  )
}
