// Electron main process: owns the DB, AI queue, API key, timer, tray, notifications and dock.
import {
  app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, safeStorage, shell
} from 'electron'
import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import type { Api, ApiEvent } from '../shared/api'
import { API_METHODS } from '../shared/api'
import type { Caps, Deadline, DeadlineExtract, DeadlineInput, Doc, ExtractedDeadline, Job, ModelCaps, Provider, Quiz, SheetData, Settings, Topic } from '../shared/types'
import { DEFAULT_BASE_URLS, baseUrlFor, baseUrlProblem, deepMerge, mergeSettings, providerInfo, PROVIDERS } from '../shared/defaults'
import { deadlineKey } from '../shared/deadlineMap'
import { dayKey } from '../shared/util'
import { openStore, type Store } from './store'
import type { BackupData } from './store/types'
import { Repo, uid } from './repo'
import { Queue } from './queue'
import { makeHandlers, QUIZ_TEXT_CHARS } from './jobs'
import { SessionEngine } from './session'
import { importPaths, ALL_EXT } from './importer'
import { testModel } from './ai/test'
import { sha256 } from './organize'
import { MAX_SHEET_MARKDOWN, chunkMarkdown, sheetsToMarkdown } from './deadlines'
import { INSTALL_HINT, findMarkitdown, markitdownConvert } from './markitdown'


const EXTERNAL_HOSTS = new Set(['aistudio.google.com', 'platform.claude.com', 'platform.openai.com', 'github.com'])
const isProvider = (p: unknown): p is Provider => PROVIDERS.some((x) => x.id === p)
let win: BrowserWindow | null = null
let tray: Tray | null = null // module-level reference so it is not garbage collected
let store: Store
let storeError: string | null = null
let settings: Settings
let repo: Repo
let queue: Queue
let engine: SessionEngine
let lastDay = dayKey()
let dataTimer: NodeJS.Timeout | null = null
let ticker: NodeJS.Timeout | null = null
let lastSheetPath: string | null = null // only the spreadsheet the person just picked may be read

// One Keychain-encrypted key file per provider. The Gemini file keeps its original name.
const keyFile = (p: Provider): string => path.join(app.getPath('userData'), p === 'gemini' ? 'api-key.bin' : `api-key-${p}.bin`)

function readKey(p: Provider): string | null {
  try {
    if (!fs.existsSync(keyFile(p)) || !safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(fs.readFileSync(keyFile(p)))
  } catch {
    return null
  }
}
const cachedKeys: Record<Provider, string | null> = { gemini: null, anthropic: null, openai: null }
/** The key for the provider that is currently selected in Settings. */
const activeKey = (): string | null => cachedKeys[settings.ai.provider]

function send(ev: ApiEvent, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(`ev:${ev}`, payload)
}

function emitData(): void {
  if (dataTimer) return
  dataTimer = setTimeout(() => { dataTimer = null; send('data') }, 120)
}

function saveSettings(): void {
  store.kvSet('settings', settings)
}

function fmtClock(ms: number): string {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function updateTray(): void {
  if (!tray) return
  const s = engine?.state
  let title = ''
  if (s) {
    if (s.pausedAt !== null && (s.phase === 'work' || s.phase === 'break')) title = 'Paused'
    else if (s.phase === 'work') title = fmtClock(engine.remainingMs())
    else if (s.phase === 'break') title = `Break ${fmtClock(engine.remainingMs())}`
    else if (s.phase === 'rate') title = 'Rate'
    else if (s.phase === 'next') title = 'Next'
    else if (s.phase === 'done') title = 'Save?'
  }
  tray.setTitle(title ? ` ${title}` : '', { fontType: 'monospacedDigit' })
  tray.setToolTip(s?.topicName ? `Interleaved Study: ${s.topicName}` : 'Interleaved Study')
}

function focusWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function alert(a: { title: string; body: string }): void {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: a.title, body: a.body, sound: settings.notify.sound, silent: false })
      n.on('click', focusWindow)
      n.show()
    }
  } catch { /* notifications unavailable */ }
  if (process.platform === 'darwin' && app.dock && !(win && win.isFocused())) {
    if (settings.notify.bounce) app.dock.bounce('informational')
    if (settings.notify.badge) app.dock.setBadge('1')
  }
}

function createTray(): void {
  try {
    const p = path.join(app.getAppPath(), 'resources', 'trayTemplate.png')
    const img = fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty()
    img.setTemplateImage(true)
    tray = new Tray(img)
    tray.on('click', focusWindow)
    updateTray()
  } catch {
    tray = null
  }
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1080,
    minHeight: 640,
    show: false,
    title: 'Interleaved Study',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: dark ? '#141C22' : '#E9EDEF',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => { if (process.platform === 'darwin' && app.dock) app.dock.setBadge('') })
  win.on('closed', () => { win = null })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only the provider consoles and docs the app links to open in the browser.
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' && EXTERNAL_HOSTS.has(u.hostname)) void shell.openExternal(u.href)
    } catch { /* not a URL */ }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!(!app.isPackaged && devUrl && url.startsWith(devUrl))) e.preventDefault()
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const nav = (view: string): void => { focusWindow(); send('nav', { view }) }
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Study',
      submenu: [
        { label: 'Start next suggested session', accelerator: 'CmdOrCtrl+Shift+S', click: () => { focusWindow(); send('nav', { view: 'session', action: 'quickstart' }) } },
        { label: 'Pause or resume timer', accelerator: 'CmdOrCtrl+Shift+P', click: () => { const s = engine.state; if (s?.pausedAt !== null) engine.resume(); else engine.pause() } },
        { type: 'separator' },
        { label: 'Board', accelerator: 'CmdOrCtrl+1', click: () => nav('board') },
        { label: 'Session', accelerator: 'CmdOrCtrl+2', click: () => nav('session') },
        { label: 'Plan', accelerator: 'CmdOrCtrl+3', click: () => nav('plan') },
        { label: 'Progress', accelerator: 'CmdOrCtrl+4', click: () => nav('progress') },
        { label: 'Queue', accelerator: 'CmdOrCtrl+5', click: () => nav('queue') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => nav('settings') }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Where `npm run build` puts its private markitdown: next to the app when packaged, else in the project folder. */
function markitdownDirs(): string[] {
  return app.isPackaged ? [path.join(process.resourcesPath, 'markitdown')] : [path.join(app.getAppPath(), 'vendor', 'markitdown')]
}

/** Read every sheet as rows; dates become YYYY-MM-DD so both the preview and the Markdown fallback agree. */
function readSheets(file: string): SheetData['sheets'] {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: true, raw: file.toLowerCase().endsWith('.csv') })
  return wb.SheetNames.map((name) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false })
    return { name, rows: rows.slice(0, 5000).map((row) => row.map((c) => (c instanceof Date ? dayKey(c) : c))) }
  })
}

async function caps(): Promise<Caps> {
  return {
    platform: process.platform,
    storeKind: store.kind,
    storeError,
    safeStorage: safeStorage.isEncryptionAvailable(),
    notifications: Notification.isSupported(),
    tray: !!tray,
    dock: process.platform === 'darwin' && !!app.dock,
    dataPath: app.getPath('userData'),
    markitdown: (await findMarkitdown(settings.tools.markitdown, markitdownDirs()))?.label ?? null
  }
}

function modelCaps(): Record<string, ModelCaps> {
  return store.kvGet<Record<string, ModelCaps>>('modelCaps') ?? {}
}

function requireAiReady(): void {
  if (!activeKey()) throw new Error(`Add your ${providerInfo(settings.ai.provider).keyName} in Settings first.`)
  if (queue.rateLimit) throw new Error(`${providerInfo(queue.rateLimit.provider).label.replace(/ \(.*\)$/, '')} rate limit reached, so the AI is paused. Click Continue when you’re ready.`)
  if (queue.userPaused) throw new Error('The AI queue is paused. Resume it on the Queue page first.')
}

const handlers: Api = {
  async bootstrap() {
    const keys = Object.fromEntries(PROVIDERS.map((p) => [p.id, !!cachedKeys[p.id]])) as Record<Provider, boolean>
    return { settings, hasKey: !!activeKey(), keys, caps: await caps(), modelCaps: modelCaps() }
  },
  async setSettings(patch) {
    // Requests carry the API key, so a new address is checked here and a non-official host needs the
    // person's confirmation in a main-process dialog that the page cannot click through.
    for (const [p, raw] of Object.entries(patch?.ai?.baseUrls ?? {})) {
      if (!isProvider(p) || typeof raw !== 'string') throw new Error('Unknown provider.')
      const problem = baseUrlProblem(raw)
      if (problem) throw new Error(`That base URL ${problem}.`)
      const host = raw.trim() ? new URL(raw.trim()).host : ''
      if (!host || host === new URL(DEFAULT_BASE_URLS[p]).host || host === new URL(baseUrlFor(settings.ai, p)).host) continue
      const ok = await dialog.showMessageBox(win!, {
        type: 'warning', buttons: ['Use this address', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `Send your ${providerInfo(p).label} requests and API key to ${host}?`,
        detail: 'Lesson text and your API key will go to this address instead of the official one. Only continue if you run or trust it.'
      })
      if (ok.response !== 0) throw new Error('Base URL not changed.')
    }
    const before = settings.ai.provider
    settings = mergeSettings(deepMerge(settings, patch))
    saveSettings()
    nativeTheme.themeSource = settings.theme
    queue.emitStatus()
    if (settings.ai.provider !== before) {
      // A different provider has its own key: wake the queue if that key exists, or show the missing-key state.
      if (activeKey() && queue.pauseReason?.includes('API key')) { queue.pauseReason = null; queue.resume() } else queue.kick()
    }
    return settings
  },
  async setKey(key, provider) {
    const p = provider ?? settings.ai.provider
    if (!isProvider(p)) throw new Error('Unknown provider.')
    const k = key.trim()
    if (!k) return { ok: false, error: 'The key is empty.' }
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Keychain encryption is not available on this system, so the key cannot be stored safely.' }
    fs.writeFileSync(keyFile(p), safeStorage.encryptString(k), { mode: 0o600 })
    cachedKeys[p] = k
    if (p !== settings.ai.provider) return { ok: true }
    if (queue.pauseReason?.includes('API key')) { queue.pauseReason = null; queue.resume() } else queue.kick()
    return { ok: true }
  },
  async clearKey(provider) {
    const p = provider ?? settings.ai.provider
    if (!isProvider(p)) throw new Error('Unknown provider.')
    try { fs.unlinkSync(keyFile(p)) } catch { /* already gone */ }
    cachedKeys[p] = null
    queue.emitStatus()
  },
  async testModel(model) {
    const key = activeKey()
    if (!key) {
      return { ok: false, model: model || settings.ai.model, api: '-', latencyMs: 0, error: `Add your ${providerInfo(settings.ai.provider).keyName} first.`, caps: queue.caps(model || settings.ai.model), notes: [] }
    }
    const m = (model || settings.ai.model).trim()
    const res = await testModel({ provider: settings.ai.provider, baseUrl: baseUrlFor(settings.ai), key, endpoint: settings.ai.endpoint }, m)
    // A failed test only records the error; what was learned about the model before stays.
    queue.saveCaps(res.ok ? res.caps : { ...queue.caps(m), lastError: res.caps.lastError ?? res.error ?? null, testedAt: res.caps.testedAt ?? Date.now() })
    return res
  },
  async capsCheck() { return await caps() },

  async snapshot() { return repo.dataSnapshot() },
  async topicText(id) {
    const text = repo.topicText(id)
    return { text, paras: text ? text.split(/\n{2,}/) : [] }
  },
  async search(q) { return store.search(q) },
  async renameTopic(id, name) { repo.renameTopic(id, name); emitData() },
  async updateTopic(id, patch) { repo.updateTopic(id, patch); emitData() },
  async mergeTopics(ids) { const id = repo.mergeTopics(ids); emitData(); return id },
  async splitTopic(id, at, name) { const nid = repo.splitTopic(id, at, name); emitData(); return nid },
  async addTopic(input) {
    const t = repo.addTopic(input)
    if (input.enrich) {
      queue.enqueue(repo.createJob({ kind: 'enrich', docId: t.docId, topicId: t.id, label: `Describe "${t.name}"`, payload: {}, estTokens: Math.ceil(input.text.length / 4) + 200 }))
    }
    emitData()
    return t.id
  },
  async deleteTopics(ids) { store.tx(() => ids.forEach((id) => repo.deleteTopic(id))); emitData() },
  async override(id, action) { repo.override(id, action); emitData() },
  async reviewTopic(id, rating, quiz, minutes, note) { repo.review(id, { rating, quiz, minutes, note, at: Date.now() }); emitData() },
  async createCourse(name) { const c = repo.createCourse(name); emitData(); return c.id },
  async renameCourse(id, name) { repo.renameCourse(id, name); emitData() },
  async deleteCourse(id) { repo.deleteCourse(id); emitData(); queue.emitStatus() },
  async renameDoc(id, title) { repo.renameDoc(id, title); emitData() },
  async deleteDoc(id) { repo.deleteDoc(id); emitData(); queue.emitStatus() },
  async historyCount(docId) { return repo.historyCount(docId) },
  async reorganize(docId) { repo.enqueueOrganize(docId, true); queue.kick(); emitData() },
  async retryDoc(docId) {
    const failed = store.byParent<Job>('jobs', docId).filter((j) => j.status === 'failed')
    if (failed.length) failed.forEach((j) => queue.retry(j.id))
    else repo.enqueueOrganize(docId, false)
    const d = store.get<Doc>('docs', docId)
    if (d) store.put('docs', { ...d, status: 'queued', error: null })
    queue.kick()
    emitData()
  },

  async pickPaths(kind) {
    const r = await dialog.showOpenDialog(win!, {
      title: kind === 'folder' ? 'Choose a folder of lessons' : 'Choose lesson files',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      filters: kind === 'files' ? [{ name: 'Lessons', extensions: ALL_EXT.map((e) => e.slice(1)) }] : undefined
    })
    return r.canceled ? [] : r.filePaths
  },
  async importPaths(paths, confirm, courseId) {
    const res = await importPaths(repo, paths, confirm, courseId)
    emitData()
    return res
  },

  async estimate(docIds) { return repo.estimate(docIds) },
  async startQueue(docIds) {
    const docs = store.all<Doc>('docs').filter((d) => (docIds ? docIds.includes(d.id) : d.status === 'awaiting' || d.status === 'needs'))
    for (const d of docs) repo.enqueueOrganize(d.id, false)
    if (queue.userPaused) queue.resume()
    else queue.kick()
    emitData()
  },
  async pauseQueue() { queue.pause() },
  async resumeQueue() { queue.resume() },
  async queueStatus() { return queue.status() },
  async retryJob(id) {
    const j = store.get<Job>('jobs', id)
    queue.retry(id)
    if (j?.docId) { const d = store.get<Doc>('docs', j.docId); if (d && d.status === 'needs') store.put('docs', { ...d, status: 'queued', error: null }) }
    emitData()
  },
  async discardJob(id) { queue.discard(id); emitData() },

  async quiz(topicId, regenerate) {
    const t = store.get<Topic>('topics', topicId)
    if (!t) throw new Error('Topic not found')
    const text = repo.topicText(topicId).slice(0, QUIZ_TEXT_CHARS)
    const cached = store.get<Quiz>('quizzes', topicId)
    if (cached && !regenerate && cached.textHash === sha256(text)) return cached
    requireAiReady()
    const job = repo.createJob({ kind: 'quiz', docId: t.docId, topicId, label: `Quiz "${t.name}"`, payload: { regenerate: !!regenerate }, estTokens: Math.ceil(text.length / 4) + 250 })
    return (await queue.enqueue(job, true)) as Quiz
  },
  async grade(topicId, items) {
    requireAiReady()
    const job = repo.createJob({ kind: 'grade', docId: null, topicId, label: 'Grade short answers', payload: { items }, estTokens: Math.ceil(JSON.stringify(items).length / 4) + 150 })
    return (await queue.enqueue(job, true)) as Awaited<ReturnType<Api['grade']>>
  },

  async sessionState() { return engine.state },
  async sessionPreview(pool, sandbox) { return engine.suggest(pool, !!sandbox) },
  async sessionStart(o) { const s = engine.start(o); updateTray(); return s },
  async sessionPause() { engine.pause(); updateTray() },
  async sessionResume() { engine.resume(); updateTray() },
  async sessionExtend(m) { engine.extend(m); updateTray() },
  async sessionSkip() { engine.skip(); emitData(); updateTray() },
  async sessionEndEarly() { engine.endEarly(); updateTray() },
  async sessionRate(r) { engine.rate(r); emitData(); updateTray() },
  async sessionAccept(id) { engine.accept(id); updateTray() },
  async sessionSkipBreak() { engine.skipBreak(); updateTray() },
  async sessionSkipSuggestion() { engine.skipSuggestion() },
  async sessionEnd() { engine.end(); emitData(); updateTray() },
  async sessionSandbox(save) { engine.sandboxCommit(save); emitData(); updateTray() },

  async addDeadline(d) { addDeadline(d); emitData() },
  async updateDeadline(id, patch) {
    const d = store.get<Deadline>('deadlines', id)
    if (!d) return
    const n = { ...d, ...patch, id }
    n.key = deadlineKey(n.title, n.date, courseName(n.courseId))
    store.put('deadlines', n)
    emitData()
  },
  async deleteDeadline(id) { store.del('deadlines', id); emitData() },
  async openSheet() {
    const r = await dialog.showOpenDialog(win!, { title: 'Import deadlines', properties: ['openFile'], filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xls', 'csv'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    const file = r.filePaths[0]
    lastSheetPath = file
    return { path: file, sheets: readSheets(file) }
  },
  async extractDeadlines(file) {
    if (!lastSheetPath || file !== lastSheetPath) throw new Error('Pick the spreadsheet again with Import.')
    requireAiReady()
    // markitdown first; the built-in converter keeps the import working when it is missing or fails.
    let markdown = ''
    let converter: DeadlineExtract['converter'] = 'markitdown'
    let converterNote: string | null = null
    const md = await findMarkitdown(settings.tools.markitdown, markitdownDirs())
    if (md) {
      try { markdown = await markitdownConvert(md, file) } catch (e) {
        converterNote = `markitdown failed (${e instanceof Error ? e.message : String(e)}), so the built-in converter was used.`
      }
    } else {
      converterNote = `markitdown was not found, so the built-in converter was used. Install it with: ${INSTALL_HINT}`
    }
    if (!markdown.trim()) { converter = 'builtin'; markdown = sheetsToMarkdown(readSheets(file)) }
    if (!markdown.trim()) throw new Error('The spreadsheet is empty.')
    if (markdown.length > MAX_SHEET_MARKDOWN) throw new Error(`This spreadsheet is too large to send to the AI (${Math.round(markdown.length / 1000)}k characters of Markdown; the limit is ${MAX_SHEET_MARKDOWN / 1000}k). Map its columns manually instead.`)
    const chunks = chunkMarkdown(markdown, undefined, settings.ai.windowTokens * 4)
    const courses = store.all<{ name: string }>('courses').map((c) => c.name)
    const job = repo.createJob({
      kind: 'deadlines', docId: null, topicId: null, label: `Find deadlines in "${path.basename(file)}"`,
      payload: { chunks, today: dayKey(), courses },
      estTokens: Math.ceil(markdown.length / 4) + chunks.length * 450
    })
    const res = (await queue.enqueue(job, true)) as { items: ExtractedDeadline[]; dropped: number }
    return { path: file, converter, converterNote, items: res.items, dropped: res.dropped, chunks: chunks.length }
  },
  async importDeadlines(items) {
    let added = 0, skipped = 0
    store.tx(() => {
      for (const it of items) { if (addDeadline(it)) added++; else skipped++ }
    })
    emitData()
    return { added, skipped }
  },
  async setDayGoal(goal) { repo.setDayGoal(goal); emitData() },

  async exportBackup() {
    const r = await dialog.showSaveDialog(win!, { title: 'Export backup', defaultPath: `interleaved-study-backup-${dayKey()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return null
    store.flush()
    fs.writeFileSync(r.filePath, JSON.stringify(store.dump()))
    return r.filePath
  },
  async importBackup() {
    const r = await dialog.showOpenDialog(win!, { title: 'Import backup', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    let data: BackupData
    try {
      data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) as BackupData
    } catch (e) {
      return { ok: false, error: `Not a readable JSON file: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (data?.app !== 'interleaved-study' || !data.colls) return { ok: false, error: 'This file is not an Interleaved Study backup.' }
    const ok = await dialog.showMessageBox(win!, {
      type: 'warning', buttons: ['Replace all data', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Replace all current data with this backup?', detail: 'Your API keys, provider addresses and tool paths stay as they are. Consider exporting a backup of the current data first.'
    })
    if (ok.response !== 0) return null
    // Keep a safety copy of the current data next to the store
    fs.writeFileSync(path.join(app.getPath('userData'), `before-restore-${Date.now()}.json`), JSON.stringify(store.dump()))
    const keep = { baseUrls: settings.ai.baseUrls, tools: settings.tools }
    store.restore(data)
    settings = mergeSettings(store.kvGet('settings'))
    // Where the API key is sent and which programs run are this machine's choice, never a backup's.
    settings.ai.baseUrls = keep.baseUrls
    settings.tools = keep.tools
    saveSettings()
    nativeTheme.themeSource = settings.theme
    engine.state = store.kvGet('session') ?? null
    queue.start()
    emitData()
    send('session', engine.state)
    return { ok: true }
  },
  async testNotification() { alert({ title: 'Interleaved Study', body: `Notifications work. Sound: ${settings.notify.sound}.` }) },
  async openDataFolder() { await shell.openPath(app.getPath('userData')) }
}

function courseName(id?: string | null): string | null {
  return id ? store.get<{ name: string }>('courses', id)?.name ?? null : null
}

function addDeadline(d: DeadlineInput): boolean {
  let courseId = d.courseId ?? null
  if (!courseId && d.courseName) {
    const c = store.all<{ id: string; name: string }>('courses').find((x) => x.name.toLowerCase() === d.courseName!.toLowerCase())
    courseId = c?.id ?? null
  }
  const key = deadlineKey(d.title, d.date, d.courseName ?? courseName(courseId))
  if (store.all<Deadline>('deadlines').some((x) => x.key === key)) return false
  store.put('deadlines', {
    id: uid(), title: d.title.trim(), date: d.date, courseId, docId: d.docId ?? null, topicIds: d.topicIds ?? [],
    notes: (d.notes || '') + (d.courseName && !courseId ? `${d.notes ? '\n' : ''}Course: ${d.courseName}` : ''), key, createdAt: Date.now()
  } satisfies Deadline)
  return true
}

function registerIpc(): void {
  ipcMain.handle('api', async (e, method: keyof Api, ...args: unknown[]) => {
    if (!win || e.sender !== win.webContents) throw new Error('Unknown sender')
    if (!API_METHODS.includes(method)) throw new Error(`Unknown method ${String(method)}`)
    const fn = handlers[method] as (...a: unknown[]) => Promise<unknown>
    return fn(...args)
  })
}

async function init(): Promise<void> {
  const dir = app.getPath('userData')
  fs.mkdirSync(dir, { recursive: true })
  const opened = await openStore(dir)
  store = opened.store
  storeError = opened.error
  settings = mergeSettings(store.kvGet('settings'))
  saveSettings()
  nativeTheme.themeSource = settings.theme
  for (const p of PROVIDERS) cachedKeys[p.id] = readKey(p.id)
  repo = new Repo(store, () => settings)
  try { repo.nameCoursesByCode() } catch { /* a cosmetic rename must never block startup */ }
  repo.snapshotToday()
  queue = new Queue({
    store,
    settings: () => settings,
    getKey: activeKey,
    handlers: makeHandlers(repo),
    emit: (ev, payload) => (ev === 'queue' ? send('queue', payload) : emitData()),
    onRateLimit: (info) => {
      const name = providerInfo(info.provider).label.replace(/ \(.*\)$/, '')
      const wait = info.resetAt ? ` ${name} says to try again in about ${Math.max(1, Math.ceil((info.resetAt - Date.now()) / 60000))} min.` : ''
      alert({ title: `${name} rate limit reached`, body: `Everything is paused and nothing is lost.${wait} Click Continue in Interleaved Study to pick up where it stopped.` })
    },
    onFail: (job, msg) => {
      if (job.kind === 'organize' && job.docId) {
        const d = store.get<Doc>('docs', job.docId)
        if (d) store.put('docs', { ...d, status: 'needs', error: msg })
      }
    }
  })
  engine = new SessionEngine({
    repo,
    settings: () => settings,
    alert,
    emit: (s) => { send('session', s); updateTray() }
  })
}

app.setName('Interleaved Study')

app.whenReady().then(async () => {
  await init()
  registerIpc()
  buildMenu()
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    const icon = path.join(app.getAppPath(), 'build', 'icon.png')
    if (fs.existsSync(icon)) app.dock.setIcon(icon)
  }
  createWindow()
  createTray()
  queue.start()
  engine.tick()
  ticker = setInterval(() => {
    engine.tick()
    updateTray()
    const today = dayKey()
    if (today !== lastDay) { lastDay = today; if (repo.snapshotToday()) emitData() }
  }, 1000)
  powerMonitor.on('resume', () => { engine.tick(); updateTray(); queue.kick() })
  powerMonitor.on('unlock-screen', () => { engine.tick(); updateTray() })
  app.on('activate', () => { if (!win) createWindow(); else focusWindow() })
})

app.on('window-all-closed', () => {
  // Keep running on macOS so the menu bar timer and alerts continue; quit elsewhere.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (ticker) clearInterval(ticker)
  ticker = null
  try { store?.flush(); store?.close() } catch { /* closing */ }
})
