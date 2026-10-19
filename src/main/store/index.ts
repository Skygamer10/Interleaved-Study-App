import path from 'path'
import { JsonStore } from './json'
import { SqliteStore } from './sqlite'
import type { Store } from './types'

export interface Opened { store: Store; error: string | null }

/** Open SQLite; if the native module cannot load, fall back to the JSON store and report why. */
export async function openStore(dir: string): Promise<Opened> {
  try {
    const mod = await import('better-sqlite3')
    const Database = (mod as unknown as { default: typeof import('better-sqlite3') }).default ?? (mod as unknown as typeof import('better-sqlite3'))
    const store = new SqliteStore(Database, path.join(dir, 'study.sqlite'))
    return { store, error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { store: new JsonStore(path.join(dir, 'study-store.json')), error: `SQLite unavailable, using JSON store: ${msg}` }
  }
}

export type { Store }
