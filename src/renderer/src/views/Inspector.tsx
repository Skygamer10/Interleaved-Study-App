// Right inspector: why the topic is due, AI summary, terms, prerequisites, history, notes, all overrides,
// rename/split/delete, quiz and "study now".
import { useEffect, useState } from 'react'
import type { Doc, Rating } from '../../../shared/types'
import { RATINGS, mastery, status, why } from '../../../shared/sched'
import { DAY, localDateTime, type PushUnit } from '../../../shared/util'
import { api } from '../api'
import { useAction, useApp } from '../state'
import { Icon } from '../icons'
import { Confirm, MasteryBar, Modal, StatusChip, deckName, fmtDate, fmtDateTime, fmtMin, Spinner } from '../ui'
import { QuizPanel } from '../components/Quiz'

export function Inspector({ docsMap }: { docsMap: Map<string, Doc> }) {
  const { selected, topics, courses, now, setSelected, session, setView } = useApp()
  const act = useAction()
  const t = selected ? topics.get(selected) : undefined
  const [notes, setNotes] = useState(t?.notes ?? '')
  const [text, setText] = useState<string[] | null>(null)
  const [showText, setShowText] = useState(false)
  const [splitAt, setSplitAt] = useState<number | null>(null)
  const [splitName, setSplitName] = useState('')
  const [dueAt, setDueAt] = useState(localDateTime(t?.due ?? now + DAY))
  const [push, setPush] = useState(3)
  const [pushUnit, setPushUnit] = useState<PushUnit>('days')
  const [score, setScore] = useState(t?.override ?? 50)
  const [quiz, setQuiz] = useState(false)
  const [quizScore, setQuizScore] = useState<number | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [minutes, setMinutes] = useState(t?.minutes ?? 30)

  useEffect(() => { setNotes(t?.notes ?? '') }, [t?.notes])
  useEffect(() => { setMinutes(t?.minutes ?? 30) }, [t?.minutes])
  useEffect(() => {
    if (!showText || !t) return
    let live = true
    setText(null)
    void api.topicText(t.id).then((r) => { if (live) setText(r.paras) })
    return () => { live = false }
  }, [showText, t?.id, t?.words]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!t) {
    return <aside className="pane inspector"><div className="muted" style={{ marginTop: 40, textAlign: 'center' }}>Select a topic to see why it is due, its history and overrides.</div></aside>
  }
  const d = docsMap.get(t.docId)
  const c = courses.get(t.courseId)
  const m = mastery(t, now)
  const st = status(t, now)

  const studyNow = async (): Promise<void> => {
    if (session) { setView('session'); if (session.phase === 'next' || session.phase === 'break') await act(() => api.sessionAccept(t.id)); return }
    const mode = (localStorage.getItem('mode') as 'timed' | 'pomodoro') || 'timed'
    await act(() => api.sessionStart({ mode, pool: { kind: 'topic', ids: [t.id] }, poolLabel: t.name, topicId: t.id }))
    setView('session')
  }

  return (
    <aside className="pane inspector" aria-label="Topic details">
      <div>
        <div className="muted small">{c?.name}{d ? ` / ${d.title}` : ''}{t.unit && t.unit !== d?.title ? ` / ${t.unit}` : ''}</div>
        <h1 className="sel">{t.name}</h1>
        <div className="deck-big"><Icon.file /> Lecture file: <b>{deckName(d)}</b></div>
        {t.provisional && <div className="help">Provisional name until the AI organizes this lesson.</div>}
      </div>
      <div className="row-flex"><StatusChip s={st} /><MasteryBar v={m} overdue={!!t.due && t.due <= now && m < 50} /></div>
      <div>
        <h3>Why it’s due</h3>
        <div className={`why${t.due && t.due <= now ? ' overdue' : ''}`}>{why(t, now)}</div>
      </div>
      <div className="row-flex">
        <button className="btn primary" onClick={() => void studyNow()}><Icon.play /> Study now</button>
        <button className="btn" onClick={() => { setQuizScore(null); setQuiz(true) }}><Icon.quiz /> Quiz</button>
        <button className="btn ghost" onClick={() => setShowText((x) => !x)}>{showText ? 'Hide text' : 'Show text'}</button>
      </div>
      {t.summary && <div><h3>Summary</h3><div className="summary sel">{t.summary}</div></div>}
      {t.terms.length > 0 && <div><h3>Key terms</h3><div className="terms">{t.terms.map((x) => <span className="chip" key={x}>{x}</span>)}</div></div>}
      {t.prereqs.length > 0 && <div><h3>Prerequisites</h3><div className="terms">{t.prereqs.map((x) => <span className="chip" key={x}>{x}</span>)}</div></div>}
      <dl className="facts">
        <dt>Suggested time</dt>
        <dd><input className="input num" style={{ width: 70, minHeight: 24, padding: '1px 6px' }} type="number" min={1} max={240} value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))} onBlur={() => minutes !== t.minutes && void act(() => api.updateTopic(t.id, { minutes }))} /> min</dd>
        <dt>Time spent</dt><dd>{fmtMin(t.spent)}</dd>
        <dt>Reviews</dt><dd>{t.reviews.length}</dd>
        <dt>Interval</dt><dd>{t.stab ? `${t.stab.toFixed(1)} days` : 'none yet'}</dd>
        {t.difficulty ? <><dt>Difficulty</dt><dd>{t.difficulty} of 5</dd></> : null}
        <dt>Length</dt><dd>{t.words.toLocaleString()} words</dd>
        {t.due ? <><dt>Next due</dt><dd>{fmtDateTime(t.due)}</dd></> : null}
      </dl>

      {showText && (
        <div className="section-rule">
          <h3>Text {splitAt === null ? '' : '(choose where the new topic starts)'}</h3>
          {!text ? <Spinner /> : splitAt === null ? (
            <>
              <div className="textview">{text.join('\n\n') || 'No stored text.'}</div>
              {text.length > 1 && <button className="btn small" style={{ marginTop: 8 }} onClick={() => setSplitAt(Math.ceil(text.length / 2))}><Icon.split /> Split this topic</button>}
            </>
          ) : (
            <>
              {text.map((p, i) => (
                <label key={i} className="split-para">
                  <input type="radio" name="split" disabled={i === 0} checked={splitAt === i} onChange={() => setSplitAt(i)} aria-label={`New topic starts at paragraph ${i + 1}`} />
                  <span className="small serif" style={{ opacity: i >= splitAt ? 1 : 0.6 }}>{p.length > 220 ? `${p.slice(0, 220)}…` : p}</span>
                </label>
              ))}
              <label className="field" style={{ marginTop: 8 }}><span>Name of the new topic (optional)</span><input className="input" value={splitName} onChange={(e) => setSplitName(e.target.value)} placeholder="Taken from its first sentence if empty" /></label>
              <div className="row-flex" style={{ marginTop: 8 }}>
                <button className="btn ghost" onClick={() => setSplitAt(null)}>Cancel</button>
                <button className="btn primary" onClick={() => void act(async () => { const id = await api.splitTopic(t.id, splitAt, splitName || undefined); setSplitAt(null); setSplitName(''); setSelected(id) }, 'Topic split')}>Split here</button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="section-rule">
        <h3>Overrides</h3>
        <div className="row-flex">
          <span>Due by</span>
          <input className="input" type="datetime-local" style={{ width: 200 }} value={dueAt} onChange={(e) => setDueAt(e.target.value)} aria-label="Next due date and time" />
          <button className="btn" disabled={!dueAt} onClick={() => void act(() => api.override(t.id, { kind: 'due', at: new Date(dueAt).getTime() }), 'Due date set')}>Set</button>
          <button className="btn" onClick={() => void act(() => api.override(t.id, { kind: 'dueNow' }), 'Due now')}>Due now</button>
        </div>
        <div className="row-flex" style={{ marginTop: 6 }}>
          <span>Push later by</span>
          <input className="input num" type="number" min={1} max={999} style={{ width: 64 }} value={push} onChange={(e) => setPush(Number(e.target.value))} aria-label="Amount" />
          <select className="input" style={{ width: 'auto' }} value={pushUnit} onChange={(e) => setPushUnit(e.target.value as PushUnit)} aria-label="Unit">
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="months">months</option>
          </select>
          <button className="btn" disabled={!(push > 0)} onClick={() => void act(() => api.override(t.id, { kind: 'push', amount: push, unit: pushUnit }), `Pushed ${push} ${push === 1 ? pushUnit.slice(0, -1) : pushUnit}`)}>Push</button>
          <button className="btn" onClick={() => void act(() => api.override(t.id, { kind: 'solid' }), 'Marked solid for 30 days')}>Mark solid</button>
        </div>
        <div className="row-flex" style={{ marginTop: 6 }}>
          <span>Score</span>
          <input className="input num" type="number" min={0} max={100} style={{ width: 64 }} value={score} onChange={(e) => setScore(Number(e.target.value))} aria-label="Score" />
          <button className="btn" onClick={() => void act(() => api.override(t.id, { kind: 'score', value: score }), 'Score set')}>Set score</button>
          {t.override !== null && t.override !== undefined && <button className="btn ghost" onClick={() => void act(() => api.override(t.id, { kind: 'clearScore' }), 'Score override cleared')}>Clear score</button>}
          <span style={{ flex: 1 }} />
          <button className="btn ghost danger" onClick={() => setConfirmReset(true)}>Reset</button>
        </div>
      </div>

      <div className="section-rule">
        <h3>History</h3>
        {t.reviews.length === 0 ? <div className="muted small">No reviews yet.</div> : (
          <div className="hist">
            {[...t.reviews].reverse().slice(0, 30).map((r, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <span className="muted">{fmtDate(r.at)}</span>
                <span>{r.self && r.self !== r.rating ? `${r.self}, with quiz ${r.rating}` : r.rating}{r.note ? <span className="muted">: {r.note}</span> : null}</span>
                <span className="num muted">{Math.round(r.minutes)}m{r.quiz !== null && r.quiz !== undefined ? `, quiz ${Math.round(r.quiz * 100)}%` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section-rule">
        <h3>Notes</h3>
        <textarea className="input serif" rows={5} value={notes} onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== t.notes && void act(() => api.updateTopic(t.id, { notes }))} placeholder="Your notes on this topic" />
      </div>
      <div><button className="btn ghost danger" onClick={() => setConfirmDelete(true)}><Icon.trash /> Delete topic</button></div>

      {quiz && (
        <Modal title={`Quiz: ${t.name}`} wide onClose={() => setQuiz(false)}>
          {quizScore === null ? (
            <QuizPanel topicId={t.id} onScore={setQuizScore} scoreLabel="Record as a review" />
          ) : (
            <div>
              <p>Quiz score {Math.round(quizScore * 100)}%. How well do you know it? The quiz counts double.</p>
              <div className="rate-row">
                {RATINGS.map((r: Rating) => (
                  <button key={r} className="rate" onClick={() => void act(async () => { await api.reviewTopic(t.id, r, quizScore, 0); setQuiz(false) }, 'Review recorded')}><b>{r[0].toUpperCase() + r.slice(1)}</b></button>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
      {confirmReset && <Confirm title="Reset this topic?" danger confirm="Reset" body={<p>Clears its schedule, reviews, time spent and score override. It becomes new again.</p>}
        onNo={() => setConfirmReset(false)} onYes={() => { setConfirmReset(false); void act(() => api.override(t.id, { kind: 'reset' }), 'Topic reset') }} />}
      {confirmDelete && <Confirm title={`Delete "${t.name}"?`} danger confirm="Delete" body={<p>The topic and its study history are removed.</p>}
        onNo={() => setConfirmDelete(false)} onYes={() => { setConfirmDelete(false); void act(async () => { await api.deleteTopics([t.id]); setSelected(null) }) }} />}
    </aside>
  )
}
