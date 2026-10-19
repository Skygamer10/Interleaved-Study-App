// SQLite store (better-sqlite3, WAL, FTS5). Each collection is a table (id, parent, data JSON);
// raw text lives in its own table so list queries never load it.
import type DatabaseCtor from 'better-sqlite3'
import { BackupData, COLLS, Coll, Store, ftsTokens, parentOf } from './types'

type DB = DatabaseCtor.Database
type Stmt = DatabaseCtor.Statement

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const
  private db: DB
  private st: Record<string, Stmt> = {}

  constructor(Database: typeof DatabaseCtor, file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = OFF')
    for (const c of COLLS) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${c} (id TEXT PRIMARY KEY, parent TEXT, data TEXT NOT NULL)`)
      this.db.exec(`CREATE INDEX IF NOT EXISTS ${c}_parent ON ${c}(parent)`)
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS texts (id TEXT PRIMARY KEY, text TEXT NOT NULL)')
    this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(id UNINDEXED, name, body, tokenize = 'porter unicode61')")
  }

  private s(sql: string): Stmt {
    return (this.st[sql] ||= this.db.prepare(sql))
  }

  get<T>(c: Coll, id: string): T | undefined {
    const r = this.s(`SELECT data FROM ${c} WHERE id = ?`).get(id) as { data: string } | undefined
    return r ? (JSON.parse(r.data) as T) : undefined
  }
  all<T>(c: Coll): T[] {
    return (this.s(`SELECT data FROM ${c}`).all() as { data: string }[]).map((r) => JSON.parse(r.data) as T)
  }
  byParent<T>(c: Coll, parent: string): T[] {
    return (this.s(`SELECT data FROM ${c} WHERE parent = ?`).all(parent) as { data: string }[]).map((r) => JSON.parse(r.data) as T)
  }
  put<T extends { id: string }>(c: Coll, obj: T): void {
    this.s(`INSERT INTO ${c} (id, parent, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, data = excluded.data`)
      .run(obj.id, parentOf(c, obj as unknown as Record<string, unknown>), JSON.stringify(obj))
  }
  del(c: Coll, id: string): void { this.s(`DELETE FROM ${c} WHERE id = ?`).run(id) }
  getText(id: string): string | undefined {
    const r = this.s('SELECT text FROM texts WHERE id = ?').get(id) as { text: string } | undefined
    return r?.text
  }
  putText(id: string, text: string): void {
    this.s('INSERT INTO texts (id, text) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text').run(id, text)
  }
  delText(id: string): void { this.s('DELETE FROM texts WHERE id = ?').run(id) }
  kvGet<T>(k: string): T | undefined {
    const r = this.s('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined
    return r ? (JSON.parse(r.v) as T) : undefined
  }
  kvSet(k: string, v: unknown): void {
    if (v === undefined) { this.s('DELETE FROM kv WHERE k = ?').run(k); return }
    this.s('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v))
  }
  index(id: string, name: string, body: string): void {
    this.s('DELETE FROM fts WHERE id = ?').run(id)
    this.s('INSERT INTO fts (id, name, body) VALUES (?, ?, ?)').run(id, name, body)
  }
  unindex(id: string): void { this.s('DELETE FROM fts WHERE id = ?').run(id) }
  search(q: string, limit = 500): string[] {
    const toks = ftsTokens(q)
    if (!toks.length) return []
    const match = toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')
    try {
      return (this.s('SELECT id FROM fts WHERE fts MATCH ? ORDER BY rank LIMIT ?').all(match, limit) as { id: string }[]).map((r) => r.id)
    } catch {
      return []
    }
  }
  tx<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn()
    return this.db.transaction(fn)()
  }
  dump(): BackupData {
    const colls: Partial<Record<Coll, unknown[]>> = {}
    for (const c of COLLS) colls[c] = this.all(c)
    const texts: Record<string, string> = {}
    for (const r of this.s('SELECT id, text FROM texts').all() as { id: string; text: string }[]) texts[r.id] = r.text
    const kv: Record<string, unknown> = {}
    for (const r of this.s('SELECT k, v FROM kv').all() as { k: string; v: string }[]) kv[r.k] = JSON.parse(r.v)
    return { app: 'interleaved-study', version: 1, exportedAt: Date.now(), colls, texts, kv }
  }
  restore(b: BackupData): void {
    this.tx(() => {
      for (const c of COLLS) {
        this.db.exec(`DELETE FROM ${c}`)
        for (const o of (b.colls[c] || []) as { id: string }[]) this.put(c, o)
      }
      this.db.exec('DELETE FROM texts; DELETE FROM kv; DELETE FROM fts;')
      for (const [id, t] of Object.entries(b.texts || {})) this.putText(id, t)
      for (const [k, v] of Object.entries(b.kv || {})) this.kvSet(k, v)
    })
  }
  flush(): void { this.db.pragma('wal_checkpoint(PASSIVE)') }
  close(): void { this.db.close() }
}
