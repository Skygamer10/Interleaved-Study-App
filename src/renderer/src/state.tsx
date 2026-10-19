// App-wide state: data snapshot from main (refetched on change events), queue and session state pushed
// from main, plus UI state that must survive view switches (selection, scope, pending rating).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { Bootstrap, Course, DataSnapshot, Doc, QueueStatus, Rating, SessionState, Settings, Topic } from '../../shared/types'
import type { DeepPartial } from '../../shared/api'
import { api, errMsg } from './api'

export type View = 'board' | 'session' | 'plan' | 'progress' | 'queue' | 'settings'
export type ScopeSel = { kind: 'all' } | { kind: 'course'; id: string } | { kind: 'lesson'; id: string } | { kind: 'unit'; docId: string; unit: string }
  | { kind: 'group'; id: string } // a Topics-tab section or folder

interface Ctx {
  boot: Bootstrap | null
  settings: Settings | null
  saveSettings: (p: DeepPartial<Settings>) => Promise<void>
  data: DataSnapshot | null
  dataError: string | null
  reload: () => Promise<void>
  queue: QueueStatus | null
  session: SessionState | null
  now: number
  view: View
  setView: (v: View) => void
  selected: string | null
  setSelected: (id: string | null) => void
  scope: ScopeSel
  setScope: (s: ScopeSel) => void
  toast: (msg: string, error?: boolean) => void
  toastMsg: { msg: string; error: boolean } | null
  courses: Map<string, Course>
  docs: Map<string, Doc>
  topics: Map<string, Topic>
  pending: { rating: Rating | null; quiz: number | null; note: string }
  setPending: (p: Partial<{ rating: Rating | null; quiz: number | null; note: string }>) => void
  refreshBoot: () => Promise<void>
  advanceKey: number
  quickstart: number
  requestQuickstart: () => void
  /** Files and folders waiting in the New course flow; null while it is closed. */
  courseWizard: string[] | null
  setCourseWizard: Dispatch<SetStateAction<string[] | null>>
}

const C = createContext<Ctx | null>(null)

export function useApp(): Ctx {
  const c = useContext(C)
  if (!c) throw new Error('useApp outside provider')
  return c
}

/** Run an async action and report errors as a toast. */
export function useAction(): <T>(fn: () => Promise<T>, ok?: string) => Promise<T | undefined> {
  const { toast } = useApp()
  return useCallback(async <T,>(fn: () => Promise<T>, ok?: string) => {
    try {
      const r = await fn()
      if (ok) toast(ok)
      return r
    } catch (e) {
      toast(errMsg(e), true)
      return undefined
    }
  }, [toast])
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [data, setData] = useState<DataSnapshot | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueStatus | null>(null)
  const [session, setSession] = useState<SessionState | null>(null)
  const [now, setNow] = useState(Date.now())
  const [view, setViewState] = useState<View>(() => (localStorage.getItem('view') as View) || 'board')
  const [selected, setSelected] = useState<string | null>(null)
  const [scope, setScope] = useState<ScopeSel>({ kind: 'all' })
  const [toastMsg, setToastMsg] = useState<{ msg: string; error: boolean } | null>(null)
  const [pending, setPendingState] = useState<{ rating: Rating | null; quiz: number | null; note: string }>({ rating: null, quiz: null, note: '' })
  const [advanceKey, setAdvanceKey] = useState(0)
  const [quickstart, setQuickstart] = useState(0)
  const [courseWizard, setCourseWizard] = useState<string[] | null>(null)
  const toastTimer = useRef<number | null>(null)
  const lastTopicRef = useRef<string | null>(null)

  const toast = useCallback((msg: string, error = false) => {
    setToastMsg({ msg, error })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMsg(null), error ? 7000 : 3200)
  }, [])

  const reload = useCallback(async () => {
    try {
      setData(await api.snapshot())
      setDataError(null)
    } catch (e) {
      setDataError(errMsg(e))
    }
  }, [])

  const refreshBoot = useCallback(async () => {
    const b = await api.bootstrap()
    setBoot(b)
    setSettingsState(b.settings)
  }, [])

  useEffect(() => {
    void refreshBoot()
    void reload()
    void api.queueStatus().then(setQueue)
    void api.sessionState().then(setSession)
    const offs = [
      api.on('data', () => void reload()),
      api.on('queue', (q) => setQueue(q as QueueStatus)),
      api.on('session', (s) => setSession(s as SessionState | null)),
      api.on('nav', (p) => {
        const n = p as { view: View; action?: string }
        setViewState(n.view)
        if (n.action === 'quickstart') setQuickstart((x) => x + 1)
      })
    ]
    const t = window.setInterval(() => setNow(Date.now()), 30000)
    return () => { offs.forEach((o) => o()); window.clearInterval(t) }
  }, [reload, refreshBoot])

  // Theme follows the OS setting (main sets nativeTheme.themeSource from Settings).
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => { document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light' }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings?.theme])

  // Ribbon advance moment + reset pending rating when the topic changes
  useEffect(() => {
    const id = session?.phase === 'work' ? session.topicId : null
    if (id && id !== lastTopicRef.current) {
      setAdvanceKey((k) => k + 1)
      setPendingState({ rating: null, quiz: null, note: '' })
    }
    lastTopicRef.current = session?.topicId ?? null
  }, [session?.topicId, session?.phase])

  const saveSettings = useCallback(async (p: DeepPartial<Settings>) => {
    const s = await api.setSettings(p)
    setSettingsState(s)
  }, [])

  const setView = useCallback((v: View) => { setViewState(v); localStorage.setItem('view', v) }, [])
  const setPending = useCallback((p: Partial<{ rating: Rating | null; quiz: number | null; note: string }>) => setPendingState((x) => ({ ...x, ...p })), [])

  const maps = useMemo(() => ({
    courses: new Map((data?.courses ?? []).map((c) => [c.id, c])),
    docs: new Map((data?.docs ?? []).map((d) => [d.id, d])),
    topics: new Map((data?.topics ?? []).map((t) => [t.id, t]))
  }), [data])

  const value: Ctx = {
    boot, settings, saveSettings, data, dataError, reload, queue, session, now, view, setView, selected, setSelected,
    scope, setScope, toast, toastMsg, ...maps, pending, setPending, refreshBoot, advanceKey, quickstart,
    requestQuickstart: () => setQuickstart((x) => x + 1), courseWizard, setCourseWizard
  }
  return <C.Provider value={value}>{children}</C.Provider>
}

export function courseClass(c: Course | undefined): string {
  return `c${(c?.color ?? 0) % 8}`
}

/** Add paths to a list without duplicates. */
export function addPaths(list: string[] | null, paths: string[]): string[] {
  return [...new Set([...(list ?? []), ...paths])]
}
