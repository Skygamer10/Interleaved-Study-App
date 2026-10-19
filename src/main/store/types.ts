// Thin storage interface. SQLite (preferred) and JSON (fallback) implement it identically.
export const COLLS = ['courses', 'docs', 'topics', 'jobs', 'deadlines', 'daily', 'snapshots', 'quizzes', 'cache', 'wins'] as const
export type Coll = (typeof COLLS)[number]

/** Which field acts as the indexed parent id for each collection. */
export const PARENT: Partial<Record<Coll, string>> = { topics: 'docId', docs: 'courseId', jobs: 'docId', wins: 'docId' }

export interface BackupData {
  app: 'interleaved-study'
  version: 1
  exportedAt: number
  colls: Partial<Record<Coll, unknown[]>>
  texts: Record<string, string>
  kv: Record<string, unknown>
}

export interface Store {
  readonly kind: 'sqlite' | 'json'
  get<T>(c: Coll, id: string): T | undefined
  all<T>(c: Coll): T[]
  byParent<T>(c: Coll, parent: string): T[]
  put<T extends { id: string }>(c: Coll, obj: T): void
  del(c: Coll, id: string): void
  getText(id: string): string | undefined
  putText(id: string, text: string): void
  delText(id: string): void
  kvGet<T>(k: string): T | undefined
  kvSet(k: string, v: unknown): void
  index(id: string, name: string, body: string): void
  unindex(id: string): void
  search(q: string, limit?: number): string[]
  tx<T>(fn: () => T): T
  dump(): BackupData
  restore(d: BackupData): void
  flush(): void
  close(): void
}

export function parentOf(c: Coll, obj: Record<string, unknown>): string | null {
  const f = PARENT[c]
  if (!f) return null
  const v = obj[f]
  return typeof v === 'string' ? v : null
}

export function ftsTokens(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12)
}
