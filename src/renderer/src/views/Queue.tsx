// AI queue: estimate before a run, live progress, pause/resume (including after a provider rate limit), failures with retry.
import { useEffect, useState } from 'react'
import type { Estimate } from '../../../shared/types'
import { api } from '../api'
import { useAction, useApp } from '../state'
import { Icon } from '../icons'
import { Spinner } from '../ui'

const STATUS_TEXT: Record<string, string> = { awaiting: 'Awaiting AI organization', queued: 'Organizing', organized: 'Organized', needs: 'Needs organizing', error: 'Import problem' }

function useTick(active: boolean): number {
  const [t, setT] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setT(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return t
}

export function QueueView() {
  const { queue, data, setView } = useApp()
  const act = useAction()
  const [est, setEst] = useState<Estimate | null>(null)
  const nowT = useTick(!!queue?.pausedUntil)
  const awaiting = data?.docs.filter((d) => d.status === 'awaiting' || d.status === 'needs') ?? []
  useEffect(() => { void api.estimate().then(setEst).catch(() => setEst(null)) }, [data])
  if (!queue || !data) return <div className="empty"><Spinner /></div>
  const s = queue
  const eta = s.etaSec >= 60 ? `${Math.ceil(s.etaSec / 60)} min` : `${s.etaSec} s`
  return (
    <div className="page">
      <div className="page-inner">
        <h1>AI queue</h1>
        {s.noKey && <div className="banner alert"><span>Add an API key for the selected AI provider to organize lessons and make quizzes.</span><button className="btn primary" onClick={() => setView('settings')}>Open Settings</button></div>}
        {s.userPaused && !s.rateLimit && <div className="banner info"><span>{s.pauseReason ?? 'The queue is paused.'}</span><button className="btn primary" onClick={() => void act(() => api.resumeQueue())}><Icon.play /> Resume</button></div>}
        {!s.userPaused && s.pausedUntil && (
          <div className="banner alert"><span>{s.pauseReason ?? 'Waiting before trying again.'} Next try in <span className="num">{Math.max(0, Math.ceil((s.pausedUntil - nowT) / 1000))} s</span>.</span>
            <button className="btn" onClick={() => void act(() => api.resumeQueue())}>Try now</button></div>
        )}
        <div className="block">
          <h2>Waiting to be organized</h2>
          {awaiting.length === 0 ? <p className="muted">Every lesson is organized or in the queue.</p> : (
            <>
              <p>{awaiting.length} lesson{awaiting.length === 1 ? '' : 's'} not organized yet{est ? `: about ${est.requests} requests, ${est.tokens.toLocaleString()} tokens, about ${Math.max(1, Math.ceil(est.minutes))} minutes${est.cached ? ` (${est.cached} windows cached)` : ''}` : ''}.</p>
              <button className="btn primary" disabled={s.noKey} onClick={() => void act(() => api.startQueue(), 'Organizing started')}><Icon.sparkle /> Start organizing</button>
            </>
          )}
        </div>
        <div className="block">
          <div className="row-flex" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0, marginRight: 'auto' }}>Progress</h2>
            {s.userPaused
              ? <button className="btn" onClick={() => void act(() => api.resumeQueue())}><Icon.play /> {s.rateLimit ? 'Continue' : 'Resume'}</button>
              : <button className="btn" onClick={() => void act(() => api.pauseQueue())}><Icon.pause /> Pause</button>}
          </div>
          <div className="statline">
            <div className="stat"><b className="num">{s.docsDone}/{s.docsTotal}</b><span>lessons done</span></div>
            <div className="stat"><b className="num">{s.chunksDone}/{s.chunksTotal}</b><span>windows done</span></div>
            <div className="stat"><b className="num">{s.queued ? eta : 'idle'}</b><span>estimated time left</span></div>
          </div>
          {s.running && <p className="row-flex"><Spinner /> {s.running}</p>}
          <p className="help">One request at a time, as fast as the provider allows. If its rate limit is reached, everything pauses and you get a notification; Continue picks up exactly where it stopped. If the app closes mid-run, the queue resumes on the next launch.</p>
        </div>
        {s.failed.length > 0 && (
          <div className="block">
            <h2>Failed</h2>
            <table className="table"><tbody>
              {s.failed.map((f) => (
                <tr key={f.id}>
                  <td>{f.label}<div className="err-text small">{f.error}</div></td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn" onClick={() => void act(() => api.retryJob(f.id))}><Icon.refresh /> Retry</button>{' '}
                    <button className="btn ghost" onClick={() => void act(() => api.discardJob(f.id))}>Discard</button>
                  </td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
        <div className="block">
          <h2>Lessons</h2>
          {data.docs.length === 0 ? <p className="muted">No lessons imported yet.</p> : (
            <table className="table">
              <thead><tr><th>Lesson</th><th>Status</th><th className="r">Words</th><th className="r">Topics</th><th /></tr></thead>
              <tbody>
                {data.docs.map((d) => (
                  <tr key={d.id}>
                    <td className="serif">{d.title}{d.importNote && <div className="help">{d.importNote}</div>}</td>
                    <td className={d.status === 'needs' || d.status === 'error' ? 'overdue' : ''}>{STATUS_TEXT[d.status]}{d.status === 'queued' ? ` ${d.winsDone}/${d.windows}` : ''}{d.error && <div className="small">{d.error}</div>}</td>
                    <td className="r num">{d.words.toLocaleString()}</td>
                    <td className="r num">{data.topics.filter((t) => t.docId === d.id).length}</td>
                    <td className="r">
                      {(d.status === 'needs' || d.status === 'error') && <button className="btn small" onClick={() => void act(() => api.retryDoc(d.id))}><Icon.refresh /> Retry</button>}
                    </td>
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
