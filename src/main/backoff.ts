// Exponential backoff with jitter, honoring Retry-After.
export const MAX_ATTEMPTS = 6

export function backoffMs(attempt: number, retryAfterMs: number | null = null, rand: () => number = Math.random): number {
  const base = Math.min(120000, 2000 * Math.pow(2, Math.max(0, attempt - 1)))
  const jittered = Math.round(base * (0.5 + 0.5 * rand()))
  return retryAfterMs && retryAfterMs > 0 ? Math.max(retryAfterMs, jittered) : jittered
}

/** Parse a Retry-After header (seconds or HTTP date) or a google.rpc.RetryInfo delay like "17s". */
export function parseRetryAfter(header: string | null | undefined, body?: string, now = Date.now()): number | null {
  if (header) {
    const n = Number(header)
    if (Number.isFinite(n)) return Math.max(0, n * 1000)
    const t = Date.parse(header)
    if (Number.isFinite(t)) return Math.max(0, t - now)
  }
  if (body) {
    const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
    if (m) return Math.round(Number(m[1]) * 1000)
  }
  return null
}
