// JSON-file store: used when better-sqlite3 cannot load. Everything in memory, written atomically (debounced).
import fs from 'fs'
import path from 'path'
import { BackupData, COLLS, Coll, Store, ftsTokens, parentOf } from './types'

interface Data {
  colls: Record<string, Record<string, unknown>>
  texts: Record<string, string>
  kv: Record<string, unknown>
  fts: Record<string, string>
}

export class JsonStore implements Store {
  readonly kind = 'json' as const
  private d: Data
  private timer: NodeJS.Timeout | null = null
  private depth = 0
  private dirty = false

  constructor(private file: string, private delayMs = 400) {
    this.d = { colls: {}, texts: {}, kv: {}, fts: {} }
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Data>
        this.d = { colls: raw.colls || {}, texts: raw.texts || {}, kv: raw.kv || {}, fts: raw.fts || {} }
      } catch (e) {
        const bad = `${file}.corrupt-${Date.now()}`
        fs.copyFileSync(file, bad)
      }
    }
    for (const c of COLLS) this.d.colls[c] ||= {}
  }

  private save(): void {
    this.dirty = true
    if (this.depth > 0) return
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.d))
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }

  close(): void { this.flush() }

  get<T>(c: Coll, id: string): T | undefined {
    const v = this.d.colls[c][id]
    return v === undefined ? undefined : (structuredClone(v) as T)
  }
  all<T>(c: Coll): T[] { return Object.values(this.d.colls[c]).map((v) => structuredClone(v) as T) }
  byParent<T>(c: Coll, parent: string): T[] {
    return Object.values(this.d.colls[c]).filter((o) => parentOf(c, o as Record<string, unknown>) === parent).map((v) => structuredClone(v) as T)
  }
  put<T extends { id: string }>(c: Coll, obj: T): void { this.d.colls[c][obj.id] = structuredClone(obj); this.save() }
  del(c: Coll, id: string): void { delete this.d.colls[c][id]; this.save() }
  getText(id: string): string | undefined { return this.d.texts[id] }
  putText(id: string, text: string): void { this.d.texts[id] = text; this.save() }
  delText(id: string): void { delete this.d.texts[id]; this.save() }
  kvGet<T>(k: string): T | undefined { const v = this.d.kv[k]; return v === undefined ? undefined : (structuredClone(v) as T) }
  kvSet(k: string, v: unknown): void { if (v === undefined) delete this.d.kv[k]; else this.d.kv[k] = structuredClone(v); this.save() }
  index(id: string, name: string, body: string): void { this.d.fts[id] = `${name}\n${body}`.toLowerCase(); this.save() }
  unindex(id: string): void { delete this.d.fts[id]; this.save() }
  search(q: string, limit = 500): string[] {
    const toks = ftsTokens(q)
    if (!toks.length) return []
    const out: string[] = []
    for (const [id, body] of Object.entries(this.d.fts)) {
      if (toks.every((t) => body.includes(t))) out.push(id)
      if (out.length >= limit) break
    }
    return out
  }
  tx<T>(fn: () => T): T {
    this.depth++
    try { return fn() } finally {
      this.depth--
      if (this.depth === 0 && this.dirty) { this.dirty = false; this.save() }
    }
  }
  dump(): BackupData {
    const colls: Partial<Record<Coll, unknown[]>> = {}
    for (const c of COLLS) colls[c] = Object.values(this.d.colls[c])
    return structuredClone({ app: 'interleaved-study', version: 1, exportedAt: Date.now(), colls, texts: this.d.texts, kv: this.d.kv })
  }
  restore(b: BackupData): void {
    const d: Data = { colls: {}, texts: { ...b.texts }, kv: { ...b.kv }, fts: {} }
    for (const c of COLLS) {
      d.colls[c] = {}
      for (const o of (b.colls[c] || []) as { id: string }[]) d.colls[c][o.id] = o
    }
    this.d = d
    this.save()
  }
}
