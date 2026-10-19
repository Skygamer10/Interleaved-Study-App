// Shared types between main, preload and renderer. No runtime imports here.
import type { PushUnit } from './util'

export type Rating = 'lost' | 'shaky' | 'okay' | 'solid'

export interface Review {
  at: number
  rating: Rating // combined category (self + quiz)
  self?: Rating | null // self rating, null when rating was skipped
  minutes: number
  quiz?: number | null // 0..1
  note?: string
}

export interface Sched {
  stab?: number | null // days
  due?: number | null // ms timestamp
  last?: number | null
  evid?: number | null // 0..1
  reviews: Review[]
  spent: number // minutes
  override?: number | null // 0..100
  solidMark?: boolean
}

export interface Course {
  id: string
  name: string
  color: number // index into course palette (0..7)
  createdAt: number
}

export type DocStatus = 'awaiting' | 'queued' | 'organized' | 'needs' | 'error'

export interface Doc {
  id: string
  courseId: string
  title: string
  titleLocked?: boolean
  fileName: string
  path: string
  ext: string
  hash: string
  words: number
  paraCount: number
  windows: number
  winsDone: number
  status: DocStatus
  error?: string | null
  importNote?: string | null
  createdAt: number
  updatedAt: number
}

export interface Topic extends Sched {
  id: string
  docId: string
  courseId: string
  unit: string
  name: string
  ord: number
  start?: number | null // paragraph ids (inclusive) within the doc
  end?: number | null
  words: number
  minutes: number // suggested study minutes
  summary: string
  terms: string[]
  prereqs: string[]
  difficulty?: number | null
  provisional: boolean
  manual?: boolean
  notes: string
  createdAt: number
}

export interface Para {
  id: number // 1-based
  text: string
  words: number
  heading?: { level: number; text: string } | null
}

export interface Deadline {
  id: string
  title: string
  date: string // YYYY-MM-DD
  courseId?: string | null
  docId?: string | null
  topicIds?: string[]
  notes?: string
  key: string // de-duplication key
  createdAt: number
}

export interface DayGoal {
  kind: 'minutes' | 'topics'
  value: number
}

export interface Daily {
  id: string // YYYY-MM-DD local
  minutes: number
  topics: number
  goal?: DayGoal | null
}

export interface Snapshot {
  id: string // YYYY-MM-DD
  avg: number
  solid: number
  progress: number
  review: number
  fresh: number
  total: number
}

export type JobKind = 'organize' | 'dedupe' | 'enrich' | 'quiz' | 'grade' | 'deadlines'
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Job {
  id: string
  kind: JobKind
  docId?: string | null
  topicId?: string | null
  payload: Record<string, unknown>
  status: JobStatus
  attempts: number
  nextAt: number
  error?: string | null
  estTokens: number
  priority: number
  createdAt: number
  label: string
}

export interface QuizQuestion {
  type: 'mc' | 'short'
  q: string
  options?: string[]
  answer: number | string
  why?: string
}

export interface Quiz {
  id: string // topic id
  textHash: string
  questions: QuizQuestion[]
  createdAt: number
}

export interface Grade {
  correct: boolean
  feedback: string
}

export type Endpoint = 'auto' | 'generateContent' | 'interactions'

export type Provider = 'gemini' | 'anthropic' | 'openai'

/** Wire API a model is called through: two for Gemini, one each for Claude and OpenAI. */
export type WireApi = 'generateContent' | 'interactions' | 'messages' | 'responses'

export interface Settings {
  ai: {
    provider: Provider
    model: string
    lastModels: Partial<Record<Provider, string>> // last model used per provider, restored when switching back
    endpoint: Endpoint // Gemini only
    baseUrls: Record<Provider, string>
    includeModelInCacheKey: boolean
    windowTokens: number
    maxOutputTokens: number
    minimalThinking: boolean
  }
  study: { minutes: number; useSuggested: boolean; pace: number }
  pomo: {
    work: number
    brk: number
    long: number
    cycles: number
    perTopic: 'one' | 'n' | 'minutes'
    n: number
    minutes: number
    autoStartNext: boolean
  }
  notify: { sound: string; bounce: boolean; badge: boolean }
  goal: { kind: 'minutes' | 'topics'; value: number; restDaysPerWeek: number }
  theme: 'system' | 'light' | 'dark'
  tools: { markitdown: string } // markitdown command or path; blank = find it automatically
}

export interface ModelCaps {
  model: string
  api: WireApi
  system: boolean | null
  json: boolean | null
  thinkMinimal: boolean | null // Gemini minimal thinking, Claude low effort, OpenAI low reasoning effort
  fallback?: boolean | null // Claude server-side refusal fallback
  testedAt?: number
  lastError?: string | null
}

export interface TestResult {
  ok: boolean
  model: string
  api: string
  latencyMs: number
  reply?: string
  error?: string
  caps: ModelCaps
  notes: string[]
}

export type Pool =
  | { kind: 'topic'; ids: string[] }
  | { kind: 'unit'; docId: string; unit: string }
  | { kind: 'lesson'; docId: string }
  | { kind: 'course'; courseIds: string[] }
  | { kind: 'global' }
  | { kind: 'sandbox'; ids: string[] }

export interface Suggestion {
  topicId: string
  name: string
  score: number
  reason: string
}

export type BlockState = 'rated' | 'skipped' | 'current'

export interface RibbonBlock {
  topicId: string
  name: string
  courseId: string
  state: BlockState
  rating?: Rating | null
  minutes: number
}

export type Phase = 'work' | 'break' | 'rate' | 'next' | 'done'

export interface SessionState {
  active: boolean
  id: string
  mode: 'timed' | 'pomodoro'
  pool: Pool
  poolLabel: string
  sandbox: boolean
  phase: Phase
  breakKind: 'short' | 'long' | null
  topicId: string | null
  topicName: string
  courseId: string | null
  endAt: number
  pausedAt: number | null
  durationMs: number
  workMs: number // accumulated work time for the current topic
  blockIndex: number
  blocksForTopic: number
  blockPlan: number[] // minutes per work block for the current topic
  cycles: number
  blocks: RibbonBlock[]
  proposal: Suggestion | null
  passed?: string[] // suggestions skipped since the last topic started
  lastTopicId: string | null
  lastDocId: string | null
  lastWasReview: boolean
  sandboxReviews: PendingReview[]
  message?: string | null
}

export interface PendingReview {
  topicId: string
  rating: Rating | null
  quiz?: number | null
  minutes: number
  note?: string
  at: number
}

export interface Estimate {
  docs: number
  requests: number
  cached: number
  tokens: number
  minutes: number
}

export interface QueueStatus {
  userPaused: boolean
  pausedUntil: number | null
  pauseReason: string | null
  running: string | null
  queued: number
  failed: { id: string; label: string; error: string; docId?: string | null }[]
  docsTotal: number
  docsDone: number
  chunksTotal: number
  chunksDone: number
  etaSec: number
  rateLimit: RateLimitInfo | null // set when the provider's rate limit paused everything
  noKey: boolean
}

export interface RateLimitInfo {
  at: number
  resetAt: number | null // when the provider said to try again (Retry-After), if it said
  message: string // the provider's own error text
  provider: Provider
  model: string
}

export interface ImportChange {
  path: string
  docId: string
  title: string
  withHistory: number
}

export interface ImportResult {
  added: number
  unchanged: number
  replaced: number
  needsConfirm: ImportChange[]
  errors: { path: string; error: string }[]
  notes: string[]
  docIds: string[]
}

export interface DataSnapshot {
  courses: Course[]
  docs: Doc[]
  topics: Topic[]
  deadlines: Deadline[]
  daily: Daily[]
  snapshots: Snapshot[]
}

export interface Caps {
  platform: string
  storeKind: 'sqlite' | 'json'
  storeError: string | null
  safeStorage: boolean
  notifications: boolean
  tray: boolean
  dock: boolean
  dataPath: string
  markitdown: string | null // the markitdown command that was found, or null
}

export interface Bootstrap {
  settings: Settings
  hasKey: boolean // for the active provider
  keys: Record<Provider, boolean>
  caps: Caps
  modelCaps: Record<string, ModelCaps>
}

export type OverrideAction =
  | { kind: 'due'; at: number }
  | { kind: 'dueNow' }
  | { kind: 'push'; amount: number; unit: PushUnit }
  | { kind: 'solid' }
  | { kind: 'reset' }
  | { kind: 'score'; value: number }
  | { kind: 'clearScore' }

export interface SheetData {
  path: string
  sheets: { name: string; rows: unknown[][] }[]
}

/** A deadline the AI found in a spreadsheet, before the person confirms the import. */
export interface ExtractedDeadline {
  title: string
  date: string // YYYY-MM-DD
  courseName: string | null
  notes: string
}

export interface DeadlineExtract {
  path: string
  converter: 'markitdown' | 'builtin'
  converterNote: string | null // why the built-in converter was used instead of markitdown
  items: ExtractedDeadline[]
  dropped: number // entries the AI returned without a usable title or date
  chunks: number
}

export interface DeadlineInput {
  title: string
  date: string
  courseId?: string | null
  docId?: string | null
  topicIds?: string[]
  notes?: string
  courseName?: string | null
}
