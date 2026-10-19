// New course flow: the student names the course and picks its colour (and shelf section), then optionally adds
// lecture files or a whole folder, or drops them on the window. The course is never named after the files.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { api, errMsg } from '../api'
import { addPaths, useApp } from '../state'
import { Icon } from '../icons'
import { Modal } from '../ui'
import { colorCss } from '../layout'
import { ColorRow } from './BoardCustomize'
import { importFlow } from './ImportFlow'

const LESSON_FILE = /\.(md|markdown|txt|pdf|docx)$/i
const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const dir = (p: string): string => p.slice(0, p.length - base(p).length).replace(/[\\/]+$/, '')

export function NewCourse({ sections, defaultSection, onCreated }: {
  sections: { id: string; name: string }[]
  defaultSection?: string
  onCreated: (id: string, color: string | null, sectionId: string | null) => void
}) {
  const { data, courseWizard, setCourseWizard, setScope, toast } = useApp()
  const staged = courseWizard ?? []
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [section, setSection] = useState(defaultSection ?? sections[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = useCallback(() => setCourseWizard(null), [setCourseWizard])
  // Step 2 focuses its content, not a button, so the Enter that advanced cannot also click Upload files.
  const formRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  useEffect(() => { (step === 2 ? formRef : nameRef).current?.focus() }, [step])

  const clean = name.trim()
  const taken = !!clean && !!data?.courses.some((c) => c.name.toLowerCase() === clean.toLowerCase())
  const canNext = !!clean && !taken
  const auto = `c${(data?.courses.length ?? 0) % 8}` // the palette colour a course gets when none is picked

  const pick = async (k: 'files' | 'folder'): Promise<void> => {
    try {
      const paths = await api.pickPaths(k)
      if (paths.length) setCourseWizard((p) => addPaths(p, paths))
    } catch (e) { toast(errMsg(e), true) }
  }
  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const id = await api.createCourse(clean)
      onCreated(id, color, sections.length > 1 ? section : null)
      close()
      setScope({ kind: 'course', id })
      if (staged.length) await importFlow.paths(staged, id)
      else toast(`Created ${clean}`)
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  const footer = step === 1 ? (
    <>
      <button className="btn ghost" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={!canNext} onClick={() => setStep(2)}>Next</button>
    </>
  ) : (
    <>
      <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => setStep(1)}>Back</button>
      <button className="btn ghost" onClick={close}>Cancel</button>
      <button className="btn primary" disabled={busy} onClick={() => void create()}>
        {busy ? <span className="spinner" /> : null}
        {staged.length ? `Create and add ${staged.length} item${staged.length === 1 ? '' : 's'}` : 'Create empty course'}
      </button>
    </>
  )

  return (
    <Modal title="New course" onClose={close} footer={footer}>
      <ol className="nc-steps" aria-label="Steps">
        <li aria-current={step === 1 ? 'step' : undefined} className={step > 1 ? 'done' : undefined}><b>{step > 1 ? <Icon.check size={11} /> : 1}</b> Name and colour</li>
        <li aria-current={step === 2 ? 'step' : undefined}><b>2</b> Lecture files</li>
      </ol>
      <div className="nc">
        <div className={`fcard nc-preview ${auto}`} style={color ? { '--c': colorCss(color) } as CSSProperties : undefined} aria-hidden="true">
          <span className="fcard-back" />
          <span className="fcard-sheets">{staged.slice(0, 3).map((p) => <span key={p} className="sheet">{base(p)}</span>)}</span>
          <span className="fcard-front">
            <span className={`fcard-name${clean ? '' : ' muted'}`}>{clean || 'Course name'}</span>
            <span className="fcard-sub">{staged.length ? `${staged.length} item${staged.length === 1 ? '' : 's'} to add` : 'No lessons yet'}</span>
          </span>
        </div>
        <div className="nc-form" ref={formRef} tabIndex={-1}>
          {step === 1 ? (
            <>
              <label className="field"><span>Course name</span>
                <input ref={nameRef} className="input serif nc-name" value={name} placeholder="e.g. Organic Chemistry or CHM110" aria-invalid={taken}
                  onChange={(e) => setName(e.target.value)} onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (canNext) setStep(2)
                  }} />
              </label>
              {taken && <p className="err-text small">There is already a course called “{clean}”.</p>}
              <div className="nc-field"><span>Colour</span><ColorRow value={color} onPick={setColor} /></div>
              {sections.length > 1 && (
                <label className="field"><span>Shelf section</span>
                  <select className="input" value={section} onChange={(e) => setSection(e.target.value)}>
                    {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              )}
            </>
          ) : (
            <>
              <p>Add the lecture files for <b>{clean}</b>. Each file becomes a lesson, which the AI then splits into topics. You can skip this and add files later.</p>
              <div className="nc-opts">
                <button className="nc-opt" onClick={() => void pick('files')}>
                  <Icon.file size={18} /><b>Upload files</b><span>.md, .txt, .pdf or .docx</span>
                </button>
                <button className="nc-opt" onClick={() => void pick('folder')}>
                  <Icon.folder size={18} /><b>Upload a folder</b><span>Every lesson file inside it</span>
                </button>
              </div>
              <p className="help">Or drop files and folders anywhere in this window.</p>
              {staged.length > 0 && (
                <ul className="nc-list" aria-label="To add">
                  {staged.map((p) => (
                    <li key={p}>
                      {LESSON_FILE.test(p) ? <Icon.file size={14} /> : <Icon.folder size={14} className="ficon" />}
                      <span className="nm">{base(p)}</span>
                      <span className="dir muted small" title={p}>{dir(p)}</span>
                      <button className="btn ghost icon" title="Remove" aria-label={`Remove ${base(p)}`} onClick={() => setCourseWizard((l) => (l ?? []).filter((x) => x !== p))}><Icon.close size={12} /></button>
                    </li>
                  ))}
                </ul>
              )}
              {error && <p className="err-text small">{error}</p>}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
