// The session ribbon: this session's blocks colored by course (rated, skipped, current), the next proposal,
// and the countdown. The one orchestrated motion: the ribbon advances when a new block starts.
import { useEffect, useState } from 'react'
import { useApp, courseClass } from '../state'
import { api, errMsg } from '../api'
import { Icon } from '../icons'
import { Deck, fmtClock } from '../ui'

export function useCountdown(): number {
  const { session } = useApp()
  const [, setT] = useState(0)
  useEffect(() => {
    if (!session || (session.phase !== 'work' && session.phase !== 'break')) return
    const id = window.setInterval(() => setT((x) => x + 1), 250)
    return () => window.clearInterval(id)
  }, [session])
  if (!session || (session.phase !== 'work' && session.phase !== 'break')) return 0
  return Math.max(0, session.endAt - (session.pausedAt ?? Date.now()))
}

const PHASE: Record<string, string> = { work: 'Studying', rate: 'Rate this block', next: 'Choose the next topic', done: 'Save or discard the sandbox' }

export function Ribbon() {
  const { session, courses, setView, toast, advanceKey, requestQuickstart, data } = useApp()
  const left = useCountdown()
  const [anim, setAnim] = useState(false)
  useEffect(() => {
    if (!advanceKey) return
    setAnim(true)
    const t = window.setTimeout(() => setAnim(false), 600)
    return () => window.clearTimeout(t)
  }, [advanceKey])
  const run = (p: Promise<unknown>): void => { p.catch((e) => toast(errMsg(e), true)) }

  if (!session) {
    return (
      <div className="ribbon">
        <div className="idle">
          <span>No session running.</span>
          <button className="btn primary" disabled={!data?.topics.length} onClick={() => { setView('session'); requestQuickstart() }}>
            <Icon.play /> Start next suggested <kbd>S</kbd>
          </button>
        </div>
        <div />
      </div>
    )
  }
  const done = session.blocks.filter((b) => b.state !== 'current')
  const cur = session.blocks.find((b) => b.state === 'current')
  const paused = session.pausedAt !== null
  const phaseText = session.phase === 'break' ? (session.breakKind === 'long' ? 'Long break' : 'Break') : PHASE[session.phase]
  return (
    <div className={`ribbon${anim ? ' advance' : ''}`}>
      <div className="strip" aria-label="Session blocks">
        {done.map((b, i) => (
          <span key={i} className={`blk ${b.state} ${courseClass(courses.get(b.courseId))}`}
            style={{ width: Math.max(18, Math.min(90, b.minutes * 2.2)) }}
            title={`${b.name}: ${b.state === 'skipped' ? 'skipped' : `rated ${b.rating}`}, ${Math.round(b.minutes)} min`} />
        ))}
        {cur && (
          <button className={`blk current ${courseClass(courses.get(cur.courseId))}`} onClick={() => setView('session')} title="Open the session">
            <span className="nm">{cur.name}</span><Deck topicId={cur.topicId} />
            {session.mode === 'pomodoro' && session.blocksForTopic > 1 && <span className="muted small num">{session.blockIndex + 1}/{session.blocksForTopic}</span>}
          </button>
        )}
        {session.proposal && session.phase !== 'work' && (
          <button className={`blk next ${courseClass(courses.get(data?.topics.find((t) => t.id === session.proposal!.topicId)?.courseId ?? ''))}`} onClick={() => setView('session')} title={session.proposal.reason}>
            <span className="small">Next</span><span className="nm">{session.proposal.name}</span><Deck topicId={session.proposal.topicId} />
          </button>
        )}
      </div>
      <div className="clock">
        {(session.phase === 'work' || session.phase === 'break') && (
          <>
            <button className="btn ghost icon" onClick={() => run(paused ? api.sessionResume() : api.sessionPause())} title={paused ? 'Resume (space)' : 'Pause (space)'} aria-label={paused ? 'Resume' : 'Pause'}>
              {paused ? <Icon.play /> : <Icon.pause />}
            </button>
            <button className="btn ghost icon" onClick={() => run(api.sessionSkip())} title={session.phase === 'break' ? 'Skip break (n)' : 'Skip topic, keep time (n)'} aria-label="Skip"><Icon.skip /></button>
          </>
        )}
        <div>
          <div className={`time${paused ? ' paused' : ''}`}>{session.phase === 'work' || session.phase === 'break' ? fmtClock(left) : '—'}</div>
          <div className="phase">{paused ? 'Paused' : phaseText}</div>
        </div>
      </div>
    </div>
  )
}
