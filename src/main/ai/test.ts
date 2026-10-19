// "Test model": a tiny request that probes system instruction, JSON mode, minimal thinking (or low effort),
// for Gemini structured output and for Claude the server-side refusal fallback.
import type { Endpoint, ModelCaps, Provider, TestResult, WireApi } from '../../shared/types'
import { HttpError, defaultCaps, generate, geminiSupportsSchema, isAuthError } from './provider'
import { extractJson } from './json'
import type { JsonSchema } from './schema'

const THINK_LABEL: Record<Provider, string> = { gemini: 'Minimal thinking', anthropic: 'Low effort (output_config.effort)', openai: 'Low reasoning effort' }
const JSON_LABEL: Record<Provider, string> = { gemini: 'JSON mode (responseMimeType)', anthropic: 'JSON mode', openai: 'JSON mode (text.format json_object)' }
const TEST_SCHEMA: JsonSchema = { type: 'object', properties: { ok: { type: 'boolean' }, reply: { type: 'string' } }, required: ['ok', 'reply'] }

export async function testModel(cfg: { provider?: Provider; baseUrl: string; key: string; endpoint: Endpoint }, model: string): Promise<TestResult> {
  const provider = cfg.provider ?? 'gemini'
  const notes: string[] = []
  const t0 = Date.now()
  const opts = {
    model,
    system: 'You are a connectivity test. Reply with JSON only.',
    prompt: 'Return exactly {"ok":true,"reply":"ready"}',
    maxOutput: 256,
    json: true,
    thinkMinimal: true,
    schema: TEST_SCHEMA // Gemini only; the other providers ignore it
  }
  const fresh = (api?: WireApi): ModelCaps => ({ ...defaultCaps(model, provider), ...(api ? { api } : {}) })
  let caps = provider === 'gemini' ? fresh(cfg.endpoint === 'interactions' ? 'interactions' : 'generateContent') : fresh()
  const gcfg = { ...cfg, provider, timeoutMs: 90000 } // thinking models often take 20-40s even for a tiny reply
  let reply = ''
  try {
    const r = await generate({ ...gcfg, endpoint: provider === 'gemini' ? (caps.api as Endpoint) : cfg.endpoint }, opts, caps)
    caps = r.caps
    reply = r.result.text
  } catch (e) {
    const first = e instanceof Error ? e.message : String(e)
    const keyProblem = e instanceof HttpError && (e.status === 401 || e.status === 403 || isAuthError(e))
    // Failed runs report fresh caps: whatever the fallback dropped on the way was not a real finding.
    if (provider === 'gemini' && cfg.endpoint === 'auto' && /^gemini-3/i.test(model) && !keyProblem) {
      try {
        // A thinking level the model rejected is rejected on both APIs: carry it over instead of paying for the same 400.
        const learned = caps.thinkMinimal === false ? { thinkMinimal: false, thinkLevel: caps.thinkLevel ?? null } : {}
        caps = { ...fresh('interactions'), ...learned }
        const r = await generate({ ...gcfg, endpoint: 'interactions' }, opts, caps)
        caps = r.caps
        reply = r.result.text
        notes.push(`generateContent failed (${first}). The Interactions API worked, so it will be used for this model.`)
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2)
        const lastError = `generateContent: ${first} | Interactions: ${msg}`
        return { ok: false, model, api: 'both failed', latencyMs: Date.now() - t0, error: lastError, caps: { ...fresh('interactions'), lastError, testedAt: Date.now() }, notes }
      }
    } else {
      const start = provider === 'gemini' ? fresh(cfg.endpoint === 'interactions' ? 'interactions' : 'generateContent') : fresh()
      return { ok: false, model, api: start.api, latencyMs: Date.now() - t0, error: first, caps: { ...start, lastError: first, testedAt: Date.now() }, notes }
    }
  }
  // A schema dropped on the way (say a bare 400 that was really about minimal thinking) gets one more try with what
  // was learned; only then does a missing schema count as not accepted.
  if (provider === 'gemini' && caps.json && caps.schema == null && geminiSupportsSchema(model)) {
    try {
      const r = await generate({ ...gcfg, endpoint: caps.api as Endpoint }, opts, { ...caps })
      caps = r.caps
      reply = r.result.text
    } catch { /* keep the first answer */ }
  }
  caps.testedAt = Date.now()
  caps.lastError = null
  let parsedOk = false
  try { parsedOk = (extractJson(reply) as { ok?: boolean })?.ok === true } catch { parsedOk = false }
  notes.push(caps.system ? 'System instruction: supported.' : 'System instruction: not accepted; it is folded into the prompt instead.')
  if (provider === 'anthropic') notes.push('JSON: requested in the prompt (Claude has no schema-free JSON mode); replies are parsed robustly.')
  else {
    const jsonLabel = provider === 'gemini' && caps.api === 'interactions' ? 'JSON mode (response_format)' : JSON_LABEL[provider]
    notes.push(caps.json ? `${jsonLabel}: supported.` : `${jsonLabel}: not accepted; prompt-based JSON with robust parsing is used.`)
  }
  if (provider === 'gemini') {
    // The probe schema is tiny, so if it was still dropped the model does not take schemas at all.
    if (caps.schema !== true) caps.schema = false
    const label = `Structured output (${caps.api === 'interactions' ? 'response_format schema' : 'responseJsonSchema'})`
    const instead = `${caps.json ? 'JSON mode' : 'prompt-based JSON'} with robust parsing is used`
    notes.push(caps.schema ? `${label}: supported.` : geminiSupportsSchema(model) ? `${label}: not accepted; ${instead}.` : `Structured output: not used for this model type; ${instead}.`)
  }
  if (caps.thinkMinimal) notes.push(`${THINK_LABEL[provider]}: accepted (saves output tokens).`)
  else if (provider === 'gemini' && caps.thinkLevel === 'low') notes.push(`${THINK_LABEL[provider]}: not accepted; thinking level low is used instead.`)
  else notes.push(`${THINK_LABEL[provider]}: not accepted; requests are sent without it.`)
  if (provider === 'anthropic') {
    notes.push(caps.fallback ? 'Refusal fallback: on. If this model declines a request, Anthropic retries it on another Claude model.' : 'Refusal fallback: not available for this model.')
  }
  if (!parsedOk) notes.push('The reply was not the exact JSON asked for; parsing and one repair retry will handle this during organizing.')
  return { ok: true, model, api: caps.api, latencyMs: Date.now() - t0, reply: reply.slice(0, 300), caps, notes }
}
