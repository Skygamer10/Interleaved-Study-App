import { describe, expect, it } from 'vitest'
import { HttpError, isAuthError, unknownField } from '../src/main/ai/provider'
import { parseRetryAfter } from '../src/main/backoff'

// Error bodies captured from the real Gemini API on 2026-10-19, so the string matching is checked against
// Google's actual wording rather than only the mock's.
describe('real Gemini error wording', () => {
  it('reads the unknown-field name and path', () => {
    const msg = `Invalid JSON payload received. Unknown name "responseJsonSchemaX" at 'generation_config': Cannot find field.`
    expect(unknownField(msg.toLowerCase().replace(/invalid json payload/g, ''))).toEqual(['responsejsonschemax', 'generation_config'])
  })
  it('treats a bad key as an auth error', () => {
    const body = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } })
    expect(isAuthError(new HttpError(400, body, null))).toBe(true)
  })
  it('does not mistake a thinking-level 400 for an auth error', () => {
    const body = JSON.stringify({ error: { code: 400, message: 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.', status: 'INVALID_ARGUMENT' } })
    expect(isAuthError(new HttpError(400, body, null))).toBe(false)
  })
  it('reads the wait from a daily free-tier 429', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash\nPlease retry in 8h23m14.115529309s.', status: 'RESOURCE_EXHAUSTED' } })
    expect(parseRetryAfter(null, body)).toBe(Math.round((8 * 3600 + 23 * 60 + 14.115529309) * 1000))
  })
})
