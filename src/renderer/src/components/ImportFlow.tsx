// Import flow shared by drag-and-drop and the Import buttons: confirm replacing changed lessons that carry
// study history, then show the AI estimate before organizing starts.
import { useEffect, useState } from 'react'
import type { Estimate, ImportResult } from '../../../shared/types'
import { api, errMsg } from '../api'
import { useApp } from '../state'
import { Modal } from '../ui'

type Handler = { paths: (p: string[]) => Promise<void>; pick: (k: 'files' | 'folder') => Promise<void>; estimate: (docIds?: string[]) => Promise<void> }
export const importFlow: Handler = { paths: async () => {}, pick: async () => {}, estimate: async () => {} }

function merge(a: ImportResult, b: ImportResult): ImportResult {
  return {
    added: a.added + b.added, unchanged: a.unchanged + b.unchanged, replaced: a.replaced + b.replaced, needsConfirm: b.needsConfirm,
    errors: [...a.errors, ...b.errors], notes: [...new Set([...a.notes, ...b.notes])], docIds: [...a.docIds, ...b.docIds]
  }
}

export function ImportFlow() {
  const { toast, setView } = useApp()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [estimate, setEstimate] = useState<{ est: Estimate; docIds?: string[] } | null>(null)

  const finish = async (res: ImportResult): Promise<void> => {
    if (res.needsConfirm.length) { setResult(res); return }
    setResult(null)
    if (res.errors.length || res.notes.length) setResult({ ...res, needsConfirm: [] })
    if (res.docIds.length) {
      const est = await api.estimate(res.docIds)
      setEstimate({ est, docIds: res.docIds })
    } else if (!res.errors.length) {
      toast(res.unchanged ? `Nothing new: ${res.unchanged} file(s) unchanged since the last import.` : 'No lessons found.')
    }
  }

  useEffect(() => {
    importFlow.paths = async (paths) => {
      setBusy(true)
      try { await finish(await api.importPaths(paths)) } catch (e) { toast(errMsg(e), true) } finally { setBusy(false) }
    }
    importFlow.pick = async (k) => {
      try {
        setBusy(true)
        const r = await api.pickImport(k)
        if (r) await finish(r)
      } catch (e) { toast(errMsg(e), true) } finally { setBusy(false) }
    }
    importFlow.estimate = async (docIds) => {
      try { setEstimate({ est: await api.estimate(docIds), docIds }) } catch (e) { toast(errMsg(e), true) }
    }
  })

  const confirmReplace = async (): Promise<void> => {
    if (!result) return
    setBusy(true)
    try {
      const r2 = await api.importPaths(result.needsConfirm.map((c) => c.path), true)
      await finish(merge({ ...result, needsConfirm: [] }, r2))
    } catch (e) { toast(errMsg(e), true) } finally { setBusy(false) }
  }

  const start = async (): Promise<void> => {
    try {
      await api.startQueue(estimate?.docIds)
      setEstimate(null)
      setResult(null)
      toast('Organizing started. Follow progress on the Queue page.')
    } catch (e) { toast(errMsg(e), true) }
  }

  return (
    <>
      {busy && <div className="toast" role="status"><span className="spinner" /> Importing…</div>}
      {result && result.needsConfirm.length > 0 && (
        <Modal title="Some lessons changed" onClose={() => void finish({ ...result, needsConfirm: [] })} footer={<>
          <button className="btn ghost" onClick={() => void finish({ ...result, needsConfirm: [] })}>Keep the old versions</button>
          <button className="btn primary" onClick={() => void confirmReplace()}>Replace and carry history over</button>
        </>}>
          <p>These files changed since you imported them, and their topics have study history. Replacing them rebuilds the topics. History moves to new topics whose name or text still matches (at least 60% overlap); unmatched topics start fresh.</p>
          <table className="table"><thead><tr><th>Lesson</th><th className="r">Topics with history</th></tr></thead>
            <tbody>{result.needsConfirm.map((c) => <tr key={c.docId}><td>{c.title}</td><td className="r">{c.withHistory}</td></tr>)}</tbody>
          </table>
        </Modal>
      )}
      {estimate && (
        <Modal title="Organize with AI" onClose={() => { setEstimate(null); setResult(null) }} footer={<>
          <button className="btn ghost" onClick={() => { setEstimate(null); setResult(null) }}>Later</button>
          <button className="btn primary" onClick={() => void start()} disabled={estimate.est.docs === 0}>
            {estimate.est.requests === 0 && estimate.est.cached > 0 ? 'Apply cached results' : 'Start organizing'}
          </button>
        </>}>
          {result && (result.errors.length > 0 || result.notes.length > 0) && (
            <div>
              {result.notes.map((n) => <p key={n} className="help">{n}</p>)}
              {result.errors.map((e) => <p key={e.path} className="err-text small">{e.path.split('/').pop()}: {e.error}</p>)}
            </div>
          )}
          <p>
            {estimate.est.docs} lesson{estimate.est.docs === 1 ? '' : 's'} ready. The AI names topics, groups units, writes summaries and suggests study times.
          </p>
          <div className="statline">
            <div className="stat"><b>~{estimate.est.requests}</b><span>requests</span></div>
            <div className="stat"><b>~{estimate.est.tokens.toLocaleString()}</b><span>tokens</span></div>
            <div className="stat"><b>~{Math.max(1, Math.ceil(estimate.est.minutes))}</b><span>minutes</span></div>
            {estimate.est.cached > 0 && <div className="stat"><b>{estimate.est.cached}</b><span>windows already cached</span></div>}
          </div>
          <p className="help">Until then, lessons show provisional topic names taken from headings or first sentences, and you can already study them. You can start this later from the Queue page.</p>
          <button className="btn ghost" onClick={() => { setEstimate(null); setView('queue') }}>Open the Queue page</button>
        </Modal>
      )}
      {result && !estimate && result.needsConfirm.length === 0 && (result.errors.length > 0) && (
        <Modal title="Import finished with problems" onClose={() => setResult(null)} footer={<button className="btn primary" onClick={() => setResult(null)}>Close</button>}>
          {result.errors.map((e) => <p key={e.path} className="small"><span className="err-text">{e.path.split('/').pop()}</span>: {e.error}</p>)}
          {result.notes.map((n) => <p key={n} className="help">{n}</p>)}
        </Modal>
      )}
    </>
  )
}
