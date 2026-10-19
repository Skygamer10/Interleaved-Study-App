import '@fontsource/newsreader/400.css'
import '@fontsource/newsreader/500.css'
import '@fontsource/newsreader/400-italic.css'
import '@fontsource/schibsted-grotesk/400.css'
import '@fontsource/schibsted-grotesk/500.css'
import '@fontsource/schibsted-grotesk/600.css'
import './style.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider, useApp, type View } from './state'
import { api, errMsg } from './api'
import { Icon } from './icons'
import { Ribbon } from './components/Ribbon'
import { ImportFlow, importFlow, importTarget } from './components/ImportFlow'
import { Board } from './views/Board'
import { SessionView } from './views/Session'
import { Plan } from './views/Plan'
import { Progress } from './views/Progress'
import { QueueView } from './views/Queue'
import { SettingsView } from './views/Settings'
import { providerInfo } from '../../shared/defaults'
import { RATINGS } from '../../shared/sched'

const TABS: { id: View; label: string }[] = [
  { id: 'board', label: 'Topics' }, { id: 'session', label: 'Session' }, { id: 'plan', label: 'Plan' },
  { id: 'progress', label: 'Progress' }, { id: 'queue', label: 'Queue' }, { id: 'settings', label: 'Settings' }
]

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

function Shortcuts() {
  const { session, pending, setPending, setView, requestQuickstart, toast } = useApp()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      if (document.querySelector('.scrim')) return
      const s = session
      const run = (p: Promise<unknown>): void => { p.catch((x) => toast(errMsg(x), true)) }
      if (e.key === ' ' && s && (s.phase === 'work' || s.phase === 'break')) {
        e.preventDefault()
        run(s.pausedAt !== null ? api.sessionResume() : api.sessionPause())
      } else if (e.key === 'n' && s) {
        e.preventDefault()
        run(api.sessionSkip())
      } else if (/^[1-4]$/.test(e.key) && s && (s.phase === 'rate' || s.phase === 'work')) {
        e.preventDefault()
        setPending({ rating: RATINGS[Number(e.key) - 1] })
        setView('session')
      } else if (e.key === 'Enter' && s && s.phase === 'rate' && pending.rating) {
        e.preventDefault()
        run(api.sessionRate({ rating: pending.rating, quiz: pending.quiz, note: pending.note || undefined }))
      } else if (e.key === 'Enter' && s && s.phase === 'next' && s.proposal) {
        e.preventDefault()
        run(api.sessionAccept(s.proposal.topicId))
      } else if (e.key === 'x' && s && (s.phase === 'next' || s.phase === 'break') && s.proposal) {
        e.preventDefault()
        run(api.sessionSkipSuggestion())
      } else if (e.key === 's') {
        e.preventDefault()
        setView('session')
        if (!s) requestQuickstart()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, pending, setPending, setView, requestQuickstart, toast])
  return null
}

function DropTarget() {
  const { view, courseWizard, courses } = useApp()
  const [over, setOver] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const reset = (): void => { depth = 0; setOver(false) }
    const enter = (e: DragEvent): void => { if (hasFiles(e)) { depth++; setOver(true) } }
    // A cancelled drag (Esc, or leaving the window) can skip leave events, so leaving the window resets the count.
    const outside = (e: DragEvent): boolean => e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight
    const leave = (e: DragEvent): void => {
      depth--
      if (depth <= 0 || outside(e)) reset()
    }
    const overFn = (e: DragEvent): void => { if (hasFiles(e)) e.preventDefault() }
    const drop = (e: DragEvent): void => {
      e.preventDefault()
      reset()
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths = files.map((f) => api.pathForFile(f)).filter(Boolean)
      if (paths.length) importFlow.drop(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', overFn)
    window.addEventListener('drop', drop)
    window.addEventListener('dragend', reset)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', overFn)
      window.removeEventListener('drop', drop)
      window.removeEventListener('dragend', reset)
    }
  }, [])
  if (!over) return null
  const target = view === 'board' && !courseWizard ? courses.get(importTarget.course ?? '') : undefined
  return (
    <div className="dropzone">
      <div>
        {courseWizard ? 'Drop files or folders to add them to the new course' : target ? `Drop lesson files or folders to add them to ${target.name}` : 'Drop lesson files or folders to start a new course'}
        <span className="muted small" style={{ display: 'block', marginTop: 4 }}>.md and .txt; PDF and DOCX best effort</span>
      </div>
    </div>
  )
}

function TitleBar() {
  const { view, setView, queue } = useApp()
  const busy = queue && (queue.running || queue.queued > 0)
  return (
    <div className="titlebar">
      <nav className="tabs" aria-label="Views">
        {TABS.map((t) => (
          <button key={t.id} className="tab" aria-current={view === t.id ? 'page' : undefined} onClick={() => setView(t.id)}>{t.label}</button>
        ))}
      </nav>
      <div className="spacer" />
      {queue && (busy || queue.failed.length > 0 || queue.pausedUntil || queue.rateLimit) ? (
        <button className="qpill" onClick={() => setView('queue')} title="AI queue">
          {queue.running ? <span className="spinner" /> : <Icon.layers />}
          {queue.failed.length ? <span className="overdue">{queue.failed.length} failed</span> : null}
          {queue.queued ? <span className="num">{queue.chunksDone}/{queue.chunksTotal || queue.queued} organizing</span> : null}
          {queue.rateLimit ? <span className="overdue">rate limit · paused</span> : queue.userPaused ? <span>paused</span> : null}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Shown on every view while the provider's rate limit has paused the AI. Continue resumes the persisted queue:
 * the request that hit the limit is retried and everything already finished stays done.
 */
function RateLimitBanner() {
  const { queue, toast } = useApp()
  const rl = queue?.rateLimit ?? null
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!rl?.resetAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [rl?.resetAt])
  if (!rl) return null
  const name = providerInfo(rl.provider).label.replace(/ \(.*\)$/, '')
  const left = rl.resetAt ? Math.max(0, Math.ceil((rl.resetAt - now) / 1000)) : null
  const wait = left === null ? '' : left > 0 ? ` ${name} asked to wait ${left >= 120 ? `about ${Math.ceil(left / 60)} min` : `${left} s`}.` : ` ${name}’s wait time has passed.`
  return (
    <div className="banner alert" role="alert">
      <span>
        <b>{name} rate limit reached.</b> Everything is paused and nothing is lost; Continue picks up exactly where it stopped.{wait}
        <span className="muted small sel" style={{ display: 'block' }} title={rl.message}>{rl.model}: {rl.message.slice(0, 160)}</span>
      </span>
      <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => void api.resumeQueue().then(() => toast('Continuing'), (e) => toast(errMsg(e), true))}><Icon.play /> Continue</button>
    </div>
  )
}

function Toast() {
  const { toastMsg } = useApp()
  if (!toastMsg) return null
  return <div className={`toast${toastMsg.error ? ' error' : ''}`} role="status">{toastMsg.msg}</div>
}

function Shell() {
  const { view, data, dataError, reload } = useApp()
  let body
  if (dataError && !data) {
    body = <div className="empty"><h2>The data could not be loaded</h2><p className="err-text">{dataError}</p><button className="btn" onClick={() => void reload()}>Try again</button></div>
  } else if (!data) {
    body = <div className="empty"><span className="spinner" /></div>
  } else {
    body = (
      <>
        {view === 'board' && <Board />}
        {view === 'session' && <SessionView />}
        {view === 'plan' && <Plan />}
        {view === 'progress' && <Progress />}
        {view === 'queue' && <QueueView />}
        {view === 'settings' && <SettingsView />}
      </>
    )
  }
  return (
    <div className="app">
      <TitleBar />
      <div><Ribbon /><RateLimitBanner /></div>
      <main style={{ minHeight: 0, display: 'grid' }}>{body}</main>
      <ImportFlow />
      <DropTarget />
      <Shortcuts />
      <Toast />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <Shell />
    </AppProvider>
  </StrictMode>
)
