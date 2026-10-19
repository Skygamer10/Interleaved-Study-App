// Progress: honest, simple charts. Time per course and topic, daily minutes, mastery over time,
// what's due today, recent reviews, streak and deadline countdown.
import { useMemo } from 'react'
import { computeStreak } from '../../../shared/streak'
import { addDays, dayKey, daysBetween, parseDayKey } from '../../../shared/util'
import { courseClass, useApp } from '../state'
import { useDerived } from './Board'
import { Deck, Empty, fmtDate, fmtMin } from '../ui'

function LineChart({ points, height = 140, max = 100, label }: { points: { x: string; y: number }[]; height?: number; max?: number; label: string }) {
  const w = 520, padL = 30, padB = 20, padT = 8
  if (points.length < 2) return <p className="muted small">{label}: one data point per day appears here once the app has been opened on two or more days.</p>
  const xs = (i: number): number => padL + (i * (w - padL - 8)) / (points.length - 1)
  const ys = (v: number): number => padT + (1 - v / max) * (height - padT - padB)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.y).toFixed(1)}`).join(' ')
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} width="100%" role="img" aria-label={label}>
      {[0, 50, 100].map((v) => <g key={v}><line className="axis" x1={padL} x2={w - 8} y1={ys(v)} y2={ys(v)} /><text x={padL - 6} y={ys(v) + 4} textAnchor="end">{v}</text></g>)}
      <path className="line" d={d} />
      <text x={padL} y={height - 4}>{points[0].x}</text>
      <text x={w - 8} y={height - 4} textAnchor="end">{points[points.length - 1].x}</text>
    </svg>
  )
}

function Bars({ values, labels, height = 120, label }: { values: number[]; labels: string[]; height?: number; label: string }) {
  const w = 520, padB = 18, padT = 6
  const max = Math.max(30, ...values)
  const bw = (w - 10) / values.length
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} width="100%" role="img" aria-label={label}>
      <line className="axis" x1={0} x2={w} y1={height - padB} y2={height - padB} />
      {values.map((v, i) => {
        const h = (v / max) * (height - padB - padT)
        return <rect key={i} className="bar" x={5 + i * bw + 1} y={height - padB - h} width={Math.max(1, bw - 2)} height={h}><title>{`${labels[i]}: ${fmtMin(v)}`}</title></rect>
      })}
      <text x={5} y={height - 4}>{labels[0]}</text>
      <text x={w - 5} y={height - 4} textAnchor="end">{labels[labels.length - 1]}</text>
      <text x={w - 5} y={padT + 8} textAnchor="end">{fmtMin(max)}</text>
    </svg>
  )
}

export function Progress() {
  const { data, settings, courses, now, setSelected, setView, topics } = useApp()
  const derived = useDerived()
  const stats = useMemo(() => {
    if (!data) return null
    const today = dayKey()
    const last30 = Array.from({ length: 30 }, (_, i) => addDays(today, i - 29))
    const daily = new Map(data.daily.map((d) => [d.id, d]))
    const perCourse = new Map<string, number>()
    for (const t of data.topics) perCourse.set(t.courseId, (perCourse.get(t.courseId) ?? 0) + (t.spent || 0))
    const endToday = parseDayKey(today).getTime() + 86400000 - 1
    const dueToday = derived.filter((d) => d.t.due && d.t.due <= endToday).sort((a, b) => (a.t.due ?? 0) - (b.t.due ?? 0))
    const reviews = data.topics.flatMap((t) => t.reviews.map((r) => ({ ...r, topicId: t.id, name: t.name, courseId: t.courseId }))).sort((a, b) => b.at - a.at).slice(0, 25)
    const weekMin = last30.slice(-7).reduce((a, k) => a + (daily.get(k)?.minutes ?? 0), 0)
    const total = data.daily.reduce((a, d) => a + d.minutes, 0)
    const avg = derived.length ? Math.round(derived.reduce((a, d) => a + d.m, 0) / derived.length) : 0
    return { last30, daily, perCourse, dueToday, reviews, weekMin, total, avg }
  }, [data, derived])
  if (!data || !settings || !stats) return null
  if (!data.topics.length) return <Empty title="Progress appears once you study"><p>Import lessons and run a session; time, ratings and mastery are tracked from then on.</p></Empty>
  const studiedDays = new Set(data.daily.filter((d) => d.minutes > 0).map((d) => d.id))
  const streak = computeStreak(studiedDays, dayKey(), settings.goal.restDaysPerWeek)
  const topTopics = [...data.topics].filter((t) => t.spent > 0).sort((a, b) => b.spent - a.spent).slice(0, 12)
  const courseRows = data.courses.map((c) => ({ c, m: stats.perCourse.get(c.id) ?? 0 })).filter((x) => x.m > 0).sort((a, b) => b.m - a.m)
  const maxCourse = Math.max(1, ...courseRows.map((x) => x.m))
  const maxTopic = Math.max(1, ...topTopics.map((t) => t.spent))
  const nextDeadlines = data.deadlines.filter((d) => d.date >= dayKey()).slice(0, 6)
  const open = (id: string): void => { setSelected(id); setView('board') }

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Progress</h1>
        <div className="statline">
          <div className="stat"><b>{fmtMin(stats.total)}</b><span>studied in total</span></div>
          <div className="stat"><b>{fmtMin(stats.weekMin)}</b><span>last 7 days</span></div>
          <div className="stat"><b>{stats.dueToday.length}</b><span>due by tonight</span></div>
          <div className="stat"><b>{stats.avg}</b><span>average mastery</span></div>
          <div className="stat"><b>{streak.current}</b><span>day streak</span></div>
        </div>
        <div className="cols">
          <div className="block">
            <h2>Minutes per day, last 30 days</h2>
            <Bars values={stats.last30.map((k) => stats.daily.get(k)?.minutes ?? 0)} labels={stats.last30.map((k) => parseDayKey(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} label="Minutes studied per day" />
          </div>
          <div className="block">
            <h2>Average mastery over time</h2>
            <LineChart points={data.snapshots.slice(-90).map((s) => ({ x: parseDayKey(s.id).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), y: s.avg }))} label="Average mastery" />
            <p className="help">Recorded once a day when the app starts. Mastery decays between reviews, so a flat line means reviews keep pace.</p>
          </div>
        </div>
        <div className="cols">
          <div className="block">
            <h2>Time per course</h2>
            {courseRows.length === 0 ? <p className="muted">No time recorded yet.</p> : (
              <div className="hbar">
                {courseRows.map(({ c, m }) => (
                  <div key={c.id} style={{ display: 'contents' }} className={courseClass(c)}>
                    <span>{c.name}</span>
                    <span className={`bar-track ${courseClass(c)}`}><span className="bar-fill" style={{ width: `${(100 * m) / maxCourse}%`, display: 'block' }} /></span>
                    <span className="num r">{fmtMin(m)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="block">
            <h2>Time per topic</h2>
            {topTopics.length === 0 ? <p className="muted">No time recorded yet.</p> : (
              <div className="hbar">
                {topTopics.map((t) => (
                  <div key={t.id} style={{ display: 'contents' }}>
                    <button className="btn ghost serif" style={{ justifyContent: 'flex-start', overflow: 'hidden' }} onClick={() => open(t.id)}>{t.name}&nbsp;<Deck topicId={t.id} /></button>
                    <span className={`bar-track ${courseClass(courses.get(t.courseId))}`}><span className="bar-fill" style={{ width: `${(100 * t.spent) / maxTopic}%`, display: 'block' }} /></span>
                    <span className="num">{fmtMin(t.spent)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="cols">
          <div className="block">
            <h2>Due by tonight</h2>
            {stats.dueToday.length === 0 ? <p className="muted">Nothing is due today.</p> : (
              <table className="table"><tbody>
                {stats.dueToday.slice(0, 20).map(({ t, m }) => (
                  <tr key={t.id} onClick={() => open(t.id)}>
                    <td><span className="serif">{t.name}</span> <Deck topicId={t.id} /></td>
                    <td className={`r ${t.due! <= now ? 'overdue' : 'muted'}`}>{t.due! <= now ? `overdue ${Math.max(0, (now - t.due!) / 86400000).toFixed(1)}d` : 'later today'}</td>
                    <td className="r">{m}</td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>
          <div className="block">
            <h2>Deadlines</h2>
            {nextDeadlines.length === 0 ? <p className="muted">No upcoming deadlines.</p> : (
              <table className="table"><tbody>
                {nextDeadlines.map((d) => {
                  const n = daysBetween(dayKey(), d.date)
                  return <tr key={d.id}><td>{d.title}</td><td className="r num">{parseDayKey(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td><td className={`r num ${n <= 7 ? 'overdue' : 'muted'}`}>{n === 0 ? 'today' : `${n} days`}</td></tr>
                })}
              </tbody></table>
            )}
          </div>
        </div>
        <div className="block">
          <h2>Recent reviews</h2>
          {stats.reviews.length === 0 ? <p className="muted">No reviews yet.</p> : (
            <table className="table">
              <thead><tr><th>Date</th><th>Topic</th><th>Rating</th><th className="r">Minutes</th><th className="r">Quiz</th></tr></thead>
              <tbody>
                {stats.reviews.map((r, i) => (
                  <tr key={i} onClick={() => topics.has(r.topicId) && open(r.topicId)}>
                    <td className="muted">{fmtDate(r.at)}</td><td><span className="serif">{r.name}</span> <Deck topicId={r.topicId} /></td><td>{r.rating}</td>
                    <td className="r">{Math.round(r.minutes)}</td><td className="r">{r.quiz !== null && r.quiz !== undefined ? `${Math.round(r.quiz * 100)}%` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
