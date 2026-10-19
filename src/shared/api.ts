import type {
  Bootstrap, Caps, DataSnapshot, DeadlineExtract, DeadlineInput, Deadline, DayGoal, Estimate, Grade, ImportResult,
  OverrideAction, Pool, Provider, QueueStatus, Quiz, Rating, SessionState, Settings, SheetData, Suggestion, TestResult
} from './types'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// Every method the renderer can call. Main registers one handler per name; preload exposes them.
export interface Api {
  bootstrap(): Promise<Bootstrap>
  setSettings(patch: DeepPartial<Settings>): Promise<Settings>
  setKey(key: string, provider?: Provider): Promise<{ ok: boolean; error?: string }>
  clearKey(provider?: Provider): Promise<void>
  testModel(model?: string): Promise<TestResult>
  capsCheck(): Promise<Caps>

  snapshot(): Promise<DataSnapshot>
  topicText(id: string): Promise<{ text: string; paras: string[] }>
  search(q: string): Promise<string[]>
  renameTopic(id: string, name: string): Promise<void>
  updateTopic(id: string, patch: { notes?: string; unit?: string; minutes?: number }): Promise<void>
  mergeTopics(ids: string[]): Promise<string>
  splitTopic(id: string, atPara: number, name?: string): Promise<string>
  addTopic(input: { docId?: string | null; courseId?: string | null; courseName?: string; lessonTitle?: string; unit?: string; name: string; text: string; enrich: boolean }): Promise<string>
  deleteTopics(ids: string[]): Promise<void>
  override(id: string, action: OverrideAction): Promise<void>
  reviewTopic(id: string, rating: Rating | null, quiz: number | null, minutes: number, note?: string): Promise<void>
  createCourse(name: string): Promise<string>
  renameCourse(id: string, name: string): Promise<void>
  deleteCourse(id: string): Promise<void>
  renameDoc(id: string, title: string): Promise<void>
  deleteDoc(id: string): Promise<void>
  historyCount(docId: string): Promise<number>
  reorganize(docId: string): Promise<void>
  retryDoc(docId: string): Promise<void>

  /** Let the student choose files or folders; nothing is imported yet. Empty when cancelled. */
  pickPaths(kind: 'files' | 'folder'): Promise<string[]>
  importPaths(paths: string[], confirm?: boolean, courseId?: string | null): Promise<ImportResult>

  estimate(docIds?: string[]): Promise<Estimate>
  startQueue(docIds?: string[]): Promise<void>
  pauseQueue(): Promise<void>
  resumeQueue(): Promise<void>
  queueStatus(): Promise<QueueStatus>
  retryJob(id: string): Promise<void>
  discardJob(id: string): Promise<void>

  quiz(topicId: string, regenerate?: boolean): Promise<Quiz>
  grade(topicId: string, items: { q: string; key: string; answer: string }[]): Promise<Grade[]>

  sessionState(): Promise<SessionState | null>
  sessionPreview(pool: Pool, sandbox?: boolean): Promise<Suggestion[]>
  sessionStart(opts: { mode: 'timed' | 'pomodoro'; pool: Pool; poolLabel: string; topicId?: string | null }): Promise<SessionState>
  sessionPause(): Promise<void>
  sessionResume(): Promise<void>
  sessionExtend(minutes: number): Promise<void>
  sessionSkip(): Promise<void>
  sessionEndEarly(): Promise<void>
  sessionRate(r: { rating: Rating | null; quiz?: number | null; note?: string }): Promise<void>
  sessionAccept(topicId?: string | null): Promise<void>
  sessionSkipBreak(): Promise<void>
  sessionSkipSuggestion(): Promise<void>
  sessionEnd(): Promise<void>
  sessionSandbox(save: boolean): Promise<void>

  addDeadline(d: DeadlineInput): Promise<void>
  updateDeadline(id: string, patch: Partial<Deadline>): Promise<void>
  deleteDeadline(id: string): Promise<void>
  openSheet(): Promise<SheetData | null>
  extractDeadlines(path: string): Promise<DeadlineExtract>
  importDeadlines(items: DeadlineInput[]): Promise<{ added: number; skipped: number }>
  setDayGoal(goal: DayGoal | null): Promise<void>

  exportBackup(): Promise<string | null>
  importBackup(): Promise<{ ok: boolean; error?: string } | null>
  testNotification(): Promise<void>
  openDataFolder(): Promise<void>
}

export type ApiEvent = 'data' | 'queue' | 'session' | 'nav'

export const API_METHODS: (keyof Api)[] = [
  'bootstrap', 'setSettings', 'setKey', 'clearKey', 'testModel', 'capsCheck',
  'snapshot', 'topicText', 'search', 'renameTopic', 'updateTopic', 'mergeTopics', 'splitTopic', 'addTopic',
  'deleteTopics', 'override', 'reviewTopic', 'createCourse', 'renameCourse', 'deleteCourse', 'renameDoc', 'deleteDoc',
  'historyCount', 'reorganize', 'retryDoc',
  'pickPaths', 'importPaths',
  'estimate', 'startQueue', 'pauseQueue', 'resumeQueue', 'queueStatus', 'retryJob', 'discardJob',
  'quiz', 'grade',
  'sessionState', 'sessionPreview', 'sessionStart', 'sessionPause', 'sessionResume', 'sessionExtend',
  'sessionSkip', 'sessionEndEarly', 'sessionRate', 'sessionAccept', 'sessionSkipBreak', 'sessionSkipSuggestion', 'sessionEnd', 'sessionSandbox',
  'addDeadline', 'updateDeadline', 'deleteDeadline', 'openSheet', 'extractDeadlines', 'importDeadlines', 'setDayGoal',
  'exportBackup', 'importBackup', 'testNotification', 'openDataFolder'
]

export interface Bridge extends Api {
  on(event: ApiEvent, cb: (payload: unknown) => void): () => void
  pathForFile(file: File): string
}

export type { DeepPartial }
