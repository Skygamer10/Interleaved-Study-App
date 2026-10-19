import type { Bridge } from '../../shared/api'

declare global {
  interface Window { api: Bridge }
}

export const api: Bridge = window.api

/** Clean Electron's "Error invoking remote method" prefix so messages read plainly. */
export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
