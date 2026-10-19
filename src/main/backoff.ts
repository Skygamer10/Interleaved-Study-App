// Exponential backoff with jitter, honoring Retry-After.
export const MAX_ATTEMPTS = 6
/** Longest server-requested wait honored (setTimeout misfires above 2^31-1 ms); longer ones pause the queue instead. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000
/** Longest wait reported to the person: a daily free-tier quota can ask for most of a day (e.g. "retry in 8h23m"). */
export const MAX_RESET_HINT_MS = 48 * 60 * 60 * 1000

export function backoffMs(attempt: number, retryAfterMs: number | null = null, rand: () => number = Math.random): number {
  const base = Math.min(120000, 2000 * Math.pow(2, Math.max(0, attempt - 1)))
  const jittered = Math.round(base * (0.5 + 0.5 * rand()))
  return retryAfterMs && retryAfterMs > 0 ? Math.max(Math.min(retryAfterMs, MAX_RETRY_AFTER_MS), jittered) : jittered
}

/**
 * Parse a Retry-After header (seconds or HTTP date), a google.rpc.RetryInfo delay like "17s", or Google's
 * "Please retry in 8h23m14.1s", capped at MAX_RESET_HINT_MS. Sleeps and backoff cap it again at MAX_RETRY_AFTER_MS.
 */
export function parseRetryAfter(header: string | null | undefined, body?: string, now = Date.now()): number | null {
  const cap = (ms: number): number => Math.min(MAX_RESET_HINT_MS, Math.max(0, ms))
  if (header) {
    const n = Number(header)
    if (Number.isFinite(n)) return cap(n * 1000)
    const t = Date.parse(header)
    if (Number.isFinite(t)) return cap(t - now)
  }
  if (body) {
    const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
    if (m) return cap(Math.round(Number(m[1]) * 1000))
    const t = body.match(/retry in (?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6}(?:\.\d{1,12})?)s)?/i)
    if (t && (t[1] || t[2] || t[3])) return cap(Math.round(((Number(t[1] ?? 0) * 60 + Number(t[2] ?? 0)) * 60 + Number(t[3] ?? 0)) * 1000))
  }
  return null
}
