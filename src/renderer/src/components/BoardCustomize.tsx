// Topics-tab customisation UI: popovers, colour picker, per-group menu and the Customize panel.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { COLS, SWATCHES, colorCss, type Layout, type Prefs } from '../layout'
import { Icon } from '../icons'

/** A trigger button with a popover that closes on outside click or Escape. */
export function Pop({ label, title, className, children }: { label: ReactNode; title: string; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true) }
  }, [open])
  // Popovers hang right-aligned from their button; flip to left-aligned when that would cut them off
  // at the left edge of a scrolling ancestor (e.g. the menu beside a course title).
  const popRef = useRef<HTMLDivElement>(null)
  const [alignLeft, setAlignLeft] = useState(false)
  useLayoutEffect(() => {
    if (!open) { setAlignLeft(false); return }
    const pop = popRef.current
    if (!pop) return
    let left = 0
    for (let el = pop.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).overflowX !== 'visible') left = Math.max(left, el.getBoundingClientRect().left)
    }
    if (pop.getBoundingClientRect().left < left + 4) setAlignLeft(true)
  }, [open])
  return (
    <span className="pop-wrap" ref={ref} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <button className={`btn ${className ?? 'ghost icon'}`} title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div ref={popRef} className={`popover${alignLeft ? ' align-left' : ''}`} role="dialog" aria-label={title}>{children(() => setOpen(false))}</div>}
    </span>
  )
}

export function ColorRow({ value, onPick }: { value: string | null | undefined; onPick: (v: string | null) => void }) {
  const hex = value && value.startsWith('#') ? value : '#1f7a8c'
  return (
    <div className="swatches">
      <button className="sw none" title="Default colour" aria-pressed={!value} onClick={() => onPick(null)}><Icon.close size={12} /></button>
      {SWATCHES.map((s) => (
        <button key={s} className="sw" style={{ background: colorCss(s) }} aria-pressed={value === s} title="Pick colour" onClick={() => onPick(s)} />
      ))}
      <label className="sw custom" title="Custom colour" aria-pressed={!!value?.startsWith('#')} style={value?.startsWith('#') ? { background: value } : undefined}>
        <Icon.plus size={12} />
        <input type="color" value={hex} onChange={(e) => onPick(e.target.value)} />
      </label>
    </div>
  )
}

/** The "more" menu on a section, folder or course heading. */
export function GroupMenu({ title, color, onColor, folderLabel, onFolder, deleteLabel, onDelete }: {
  title: string; color: string | null | undefined; onColor: (v: string | null) => void
  folderLabel?: string; onFolder?: () => void; deleteLabel?: string; onDelete?: () => void
}) {
  return (
    <Pop title={title} label={<Icon.more />}>
      {(close) => (
        <div className="menu">
          <div className="menu-h">Colour</div>
          <ColorRow value={color} onPick={onColor} />
          {onFolder && <button className="menu-i" onClick={() => { close(); onFolder() }}><Icon.folderPlus /> {folderLabel}</button>}
          <div className="menu-note">Double-click a name to rename. Drag a heading to move it.</div>
          {onDelete && <button className="menu-i danger" onClick={() => { close(); onDelete() }}><Icon.trash /> {deleteLabel}</button>}
        </div>
      )}
    </Pop>
  )
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => <button key={String(o.v)} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  )
}

export function CustomizePanel({ layout, setPrefs, onNewSection, onReset }: {
  layout: Layout; setPrefs: (p: Partial<Prefs>) => void; onNewSection: () => void; onReset: () => void
}) {
  const p = layout.prefs
  return (
    <Pop title="Customize this view" className="" label={<><Icon.sliders /> Customize</>}>
      {(close) => (
        <div className="menu custom-panel">
          <div className="row-flex">
            <button className="btn primary" onClick={() => { close(); onNewSection() }}><Icon.plus /> New section</button>
          </div>
          <div className="menu-h">Density</div>
          <Seg value={p.density} onChange={(v) => setPrefs({ density: v })}
            options={[{ v: 'compact', label: 'Compact' }, { v: 'cozy', label: 'Cozy' }, { v: 'roomy', label: 'Roomy' }]} />
          <div className="menu-h">Heading size</div>
          <Seg value={p.headings} onChange={(v) => setPrefs({ headings: v })}
            options={[{ v: 1, label: 'Large' }, { v: 1.15, label: 'Larger' }, { v: 1.3, label: 'Largest' }]} />
          <div className="menu-h">Topic text <span className="num muted">{p.topicSize}px</span></div>
          <input type="range" min={12} max={19} step={0.5} value={p.topicSize} onChange={(e) => setPrefs({ topicSize: Number(e.target.value) })} aria-label="Topic text size" />
          <p className="menu-note">Headings always stay larger than the topics under them.</p>
          <div className="menu-h">Columns</div>
          <div className="cols-pick">
            {COLS.map((c) => (
              <label key={c.id} className="check"><input type="checkbox" checked={p.cols[c.id]} onChange={(e) => setPrefs({ cols: { ...p.cols, [c.id]: e.target.checked } })} /><span>{c.label}</span></label>
            ))}
          </div>
          <div className="menu-h">Show</div>
          <label className="check"><input type="checkbox" checked={p.tree} onChange={(e) => setPrefs({ tree: e.target.checked })} /><span>Sidebar</span></label>
          <label className="check"><input type="checkbox" checked={p.inspector} onChange={(e) => setPrefs({ inspector: e.target.checked })} /><span>Details pane</span></label>
          <label className="check"><input type="checkbox" checked={p.counts} onChange={(e) => setPrefs({ counts: e.target.checked })} /><span>Topic counts on headings</span></label>
          <label className="check"><input type="checkbox" checked={p.deck} onChange={(e) => setPrefs({ deck: e.target.checked })} /><span>Lecture file next to topics</span></label>
          <label className="check"><input type="checkbox" checked={p.tint} onChange={(e) => setPrefs({ tint: e.target.checked })} /><span>Tint rows with the course colour</span></label>
          <div className="menu-sep" />
          <button className="menu-i" onClick={() => { close(); onReset() }}><Icon.refresh /> Reset sections, folders, order and colours</button>
        </div>
      )}
    </Pop>
  )
}
