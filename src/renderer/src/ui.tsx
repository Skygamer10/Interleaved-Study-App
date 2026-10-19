// Shared small UI pieces: modal, confirm, toast, status chip, mastery bar, empty state, formatters.
import { useEffect, useRef, type ReactNode } from 'react'
import type { Doc } from '../../shared/types'
import { useApp } from './state'
import { Icon } from './icons'
import type { Status } from '../../shared/sched'
import { STATUS_LABEL } from '../../shared/sched'
import { DAY } from '../../shared/util'

export function Modal({ title, children, footer, onClose, wide }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button.primary, button')
    first?.focus()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('keydown', onKey, true); prev?.focus() }
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header>{title}</header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export function Confirm({ title, body, confirm, danger, onYes, onNo }: { title: string; body: ReactNode; confirm: string; danger?: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <Modal title={title} onClose={onNo} footer={<>
      <button className="btn ghost" onClick={onNo}>Cancel</button>
      <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onYes}>{confirm}</button>
    </>}>
      <div>{body}</div>
    </Modal>
  )
}

export function StatusChip({ s }: { s: Status }) {
  return <span className={`chip ${s}`}>{STATUS_LABEL[s]}</span>
}

export function MasteryBar({ v, overdue }: { v: number; overdue?: boolean }) {
  return (
    <span className="mbar" title={`Mastery ${v} of 100`}>
      <span className="track"><span className={`fill${overdue ? ' ov' : ''}`} style={{ width: `${Math.max(0, Math.min(100, v))}%`, display: 'block' }} /></span>
      <span className="v">{v}</span>
    </span>
  )
}

/** The lecture deck a lesson came from, as the student named the file (falls back to the lesson title). */
export function deckName(d: Doc | undefined): string {
  if (!d) return ''
  if (!d.fileName || d.ext === 'manual') return d.title
  return d.fileName.replace(/\.[^.]+$/, '')
}

/** Small "from file" label shown next to a topic name. */
export function Deck({ topicId, docId }: { topicId?: string | null; docId?: string | null }) {
  const { topics, docs } = useApp()
  const d = docs.get(docId ?? topics.get(topicId ?? '')?.docId ?? '')
  const n = deckName(d)
  if (!d || !n) return null
  return <span className="deck" title={`Lecture file: ${d.fileName || d.title}\nLesson: ${d.title}`}><Icon.file size={12} /><span>{n}</span></span>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h2>{title}</h2>{children}</div>
}

export function fmtMin(m: number): string {
  if (!m) return '0m'
  if (m < 60) return `${Math.round(m)}m`
  const h = Math.floor(m / 60)
  const r = Math.round(m % 60)
  return r ? `${h}h ${r}m` : `${h}h`
}

export function fmtRel(t: number | null | undefined, now: number): string {
  if (!t) return ''
  const d = (t - now) / DAY
  const a = Math.abs(d)
  if (a < 1 / 24) return d < 0 ? 'just now' : 'now'
  if (a < 1) { const h = Math.round(a * 24); return d < 0 ? `${h}h ago` : `in ${h}h` }
  if (a < 60) { const n = Math.round(a); return d < 0 ? `${n}d ago` : `in ${n}d` }
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function fmtDate(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

export function Spinner() { return <span className="spinner" role="status" aria-label="Loading" /> }
