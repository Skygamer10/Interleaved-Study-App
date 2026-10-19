// On-demand quiz for one topic (built from that topic's text only, cached). Multiple choice is scored
// locally; short answers are self-marked against the key, or graded by the AI on request.
import { useEffect, useState } from 'react'
import type { Grade, Quiz as QuizT } from '../../../shared/types'
import { api, errMsg } from '../api'
import { Icon } from '../icons'
import { Spinner } from '../ui'

export function QuizPanel({ topicId, onScore, scoreLabel = 'Use this score' }: { topicId: string; onScore: (q: number) => void; scoreLabel?: string }) {
  const [quiz, setQuiz] = useState<QuizT | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [checked, setChecked] = useState(false)
  const [marks, setMarks] = useState<Record<number, boolean>>({})
  const [grades, setGrades] = useState<Record<number, Grade>>({})
  const [grading, setGrading] = useState(false)

  const load = (regenerate = false): void => {
    setLoading(true); setError(null); setChecked(false); setAnswers({}); setMarks({}); setGrades({})
    api.quiz(topicId, regenerate).then(setQuiz).catch((e) => setError(errMsg(e))).finally(() => setLoading(false))
  }
  useEffect(() => load(false), [topicId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="row-flex muted"><Spinner /> Preparing a quiz from this topic’s text (cached after the first time)…</div>
  if (error || !quiz) return <div><p className="err-text">{error ?? 'No quiz available.'}</p><button className="btn" onClick={() => load(false)}><Icon.refresh /> Try again</button></div>

  const qs = quiz.questions
  const shortIdx = qs.map((q, i) => (q.type === 'short' ? i : -1)).filter((i) => i >= 0)
  const correct = qs.reduce((a, q, i) => a + (q.type === 'mc' ? (Number(answers[i]) === q.answer ? 1 : 0) : (grades[i]?.correct ?? marks[i]) ? 1 : 0), 0)
  const allMarked = shortIdx.every((i) => marks[i] !== undefined || grades[i] !== undefined)
  const score = qs.length ? correct / qs.length : 0

  const gradeAi = async (): Promise<void> => {
    setGrading(true)
    try {
      const res = await api.grade(topicId, shortIdx.map((i) => ({ q: qs[i].q, key: String(qs[i].answer), answer: answers[i] ?? '' })))
      const g: Record<number, Grade> = {}
      shortIdx.forEach((i, k) => (g[i] = res[k]))
      setGrades(g)
    } catch (e) { setError(errMsg(e)) } finally { setGrading(false) }
  }

  return (
    <div>
      {qs.map((q, i) => (
        <div key={i} className="quiz-q">
          <div className="q">{i + 1}. {q.q}</div>
          {q.type === 'mc' ? q.options!.map((o, k) => {
            const cls = checked ? (k === q.answer ? ' right' : Number(answers[i]) === k ? ' wrong' : '') : ''
            return (
              <label key={k} className={`opt${cls}`}>
                <input type="radio" name={`q${i}`} disabled={checked} checked={answers[i] === String(k)} onChange={() => setAnswers({ ...answers, [i]: String(k) })} />
                <span>{o}</span>
              </label>
            )
          }) : (
            <textarea className="input" rows={2} disabled={checked} value={answers[i] ?? ''} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} placeholder="Your answer" />
          )}
          {checked && q.type === 'mc' && q.why && <div className="help">{q.why}</div>}
          {checked && q.type === 'short' && (
            <div className="small">
              <div><span className="muted">Answer key:</span> {String(q.answer)}</div>
              {grades[i] ? <div className={grades[i].correct ? '' : 'overdue'}>{grades[i].correct ? 'Graded correct' : 'Graded not correct'}: {grades[i].feedback}</div> : (
                <div className="row-flex" style={{ marginTop: 4 }}>
                  <button className="btn small" aria-pressed={marks[i] === true} onClick={() => setMarks({ ...marks, [i]: true })}>{marks[i] === true ? <Icon.check /> : null} I got it</button>
                  <button className="btn small" aria-pressed={marks[i] === false} onClick={() => setMarks({ ...marks, [i]: false })}>{marks[i] === false ? <Icon.check /> : null} Not quite</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="row-flex" style={{ marginTop: 10 }}>
        {!checked && <button className="btn primary" onClick={() => setChecked(true)}>Check answers</button>}
        {checked && shortIdx.length > 0 && !allMarked && <button className="btn" disabled={grading} onClick={() => void gradeAi()}>{grading ? <Spinner /> : <Icon.sparkle />} Grade short answers with AI</button>}
        {checked && allMarked && <span className="num">Score {correct}/{qs.length} ({Math.round(score * 100)}%)</span>}
        {checked && allMarked && <button className="btn primary" onClick={() => onScore(score)}>{scoreLabel}</button>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost small" onClick={() => load(true)}><Icon.refresh /> New questions</button>
      </div>
    </div>
  )
}
