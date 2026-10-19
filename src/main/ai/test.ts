// "Test model": a tiny request that probes system instruction, JSON mode, minimal thinking (or low effort)
// and, for Claude, the server-side refusal fallback.
import type { Endpoint, ModelCaps, Provider, TestResult, WireApi } from '../../shared/types'
import { defaultCaps, generate } from './provider'
import { extractJson } from './json'

const THINK_LABEL: Record<Provider, string> = { gemini: 'Minimal thinking', anthropic: 'Low effort (output_config.effort)', openai: 'Low reasoning effort' }
const JSON_LABEL: Record<Provider, string> = { gemini: 'JSON mode (responseMimeType)', anthropic: 'JSON mode', openai: 'JSON mode (text.format json_object)' }

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
    thinkMinimal: true
  }
  const fresh = (api?: WireApi): ModelCaps => ({ ...defaultCaps(model, provider), ...(api ? { api } : {}) })
  let caps = provider === 'gemini' ? fresh(cfg.endpoint === 'interactions' ? 'interactions' : 'generateContent') : fresh()
  const gcfg = { ...cfg, provider, timeoutMs: 45000 }
  let reply = ''
  try {
    const r = await generate({ ...gcfg, endpoint: provider === 'gemini' ? (caps.api as Endpoint) : cfg.endpoint }, opts, caps)
    caps = r.caps
    reply = r.result.text
  } catch (e) {
    const first = e instanceof Error ? e.message : String(e)
    if (provider === 'gemini' && cfg.endpoint === 'auto' && /^gemini-3/i.test(model)) {
      try {
        caps = fresh('interactions')
        const r = await generate({ ...gcfg, endpoint: 'interactions' }, opts, caps)
        caps = r.caps
        reply = r.result.text
        notes.push(`generateContent failed (${first}). The Interactions API worked, so it will be used for this model.`)
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : String(e2)
        caps.lastError = `generateContent: ${first} | Interactions: ${msg}`
        return { ok: false, model, api: 'both failed', latencyMs: Date.now() - t0, error: caps.lastError, caps: { ...caps, testedAt: Date.now() }, notes }
      }
    } else {
      caps.lastError = first
      return { ok: false, model, api: caps.api, latencyMs: Date.now() - t0, error: first, caps: { ...caps, testedAt: Date.now() }, notes }
    }
  }
  caps.testedAt = Date.now()
  caps.lastError = null
  let parsedOk = false
  try { parsedOk = (extractJson(reply) as { ok?: boolean })?.ok === true } catch { parsedOk = false }
  notes.push(caps.system ? 'System instruction: supported.' : 'System instruction: not accepted; it is folded into the prompt instead.')
  if (provider === 'anthropic') notes.push('JSON: requested in the prompt (Claude has no schema-free JSON mode); replies are parsed robustly.')
  else notes.push(caps.json ? `${JSON_LABEL[provider]}: supported.` : `${JSON_LABEL[provider]}: not accepted; prompt-based JSON with robust parsing is used.`)
  notes.push(caps.thinkMinimal ? `${THINK_LABEL[provider]}: accepted (saves output tokens).` : `${THINK_LABEL[provider]}: not accepted; requests are sent without it.`)
  if (provider === 'anthropic') {
    notes.push(caps.fallback ? 'Refusal fallback: on. If this model declines a request, Anthropic retries it on another Claude model.' : 'Refusal fallback: not available for this model.')
  }
  if (!parsedOk) notes.push('The reply was not the exact JSON asked for; parsing and one repair retry will handle this during organizing.')
  return { ok: true, model, api: caps.api, latencyMs: Date.now() - t0, reply: reply.slice(0, 300), caps, notes }
}
