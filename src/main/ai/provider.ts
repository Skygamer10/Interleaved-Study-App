// Provider adapters: Google AI (Gemini API: generateContent baseline and Interactions), Anthropic Claude
// (Messages API via the official SDK) and OpenAI (Responses API).
// Capabilities (system instruction, JSON mode, minimal thinking / low effort, Claude refusal fallback) are
// probed and remembered per model: on HTTP 400 the offending feature is dropped and the request retried without it.
import Anthropic from '@anthropic-ai/sdk'
import type { Endpoint, ModelCaps, Provider, WireApi } from '../../shared/types'
import { parseRetryAfter } from '../backoff'

export class HttpError extends Error {
  constructor(public status: number, public body: string, public retryAfterMs: number | null) {
    super(`HTTP ${status}: ${summarizeBody(body)}`)
  }
}
export class NetworkError extends Error {}
export class BlockedError extends Error {}

function summarizeBody(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string; type?: string } }
    const kind = j.error?.status ?? j.error?.type
    if (j.error?.message) return `${kind ? kind + ': ' : ''}${j.error.message}`.slice(0, 400)
  } catch { /* not json */ }
  return body.slice(0, 400)
}

export interface CallOpts {
  model: string
  system: string
  prompt: string
  maxOutput: number
  json: boolean
  thinkMinimal: boolean
}

export interface CallResult {
  text: string
  inputTokens: number | null
  outputTokens: number | null
  finish: string | null
  api: WireApi
}

export interface ProviderCfg {
  provider: Provider
  baseUrl: string
  key: string
  endpoint: Endpoint
  timeoutMs?: number
}

export function defaultCaps(model: string, provider: Provider = 'gemini'): ModelCaps {
  const api: WireApi = provider === 'anthropic' ? 'messages' : provider === 'openai' ? 'responses' : 'generateContent'
  return { model, api, system: null, json: null, thinkMinimal: null, fallback: null }
}

interface Use { sys: boolean; json: boolean; think: boolean; fallback: boolean }

// Reasoning models count thinking tokens toward the output cap, so leave room for them on top of the answer.
const THINK_HEADROOM_LOW = 4096
const THINK_HEADROOM_DEFAULT = 12000

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal
    })
  } catch (e) {
    throw new NetworkError(ctl.signal.aborted ? `Request timed out after ${Math.round(timeoutMs / 1000)}s` : `Network error: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new HttpError(res.status, text, parseRetryAfter(res.headers.get('retry-after'), text))
  try { return JSON.parse(text) } catch { throw new HttpError(502, `Non-JSON response: ${text.slice(0, 200)}`, null) }
}

const trimBase = (u: string): string => u.replace(/\/$/, '')

async function callGenerateContent(cfg: ProviderCfg, o: CallOpts, use: Use): Promise<CallResult> {
  const prompt = use.sys ? o.prompt : `${o.system}\n\n${o.prompt}`
  const generationConfig: Record<string, unknown> = { maxOutputTokens: o.maxOutput }
  if (use.json) generationConfig.responseMimeType = 'application/json'
  if (use.think) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' }
  const body: Record<string, unknown> = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }
  if (use.sys) body.systemInstruction = { parts: [{ text: o.system }] }
  const url = `${trimBase(cfg.baseUrl)}/v1beta/models/${encodeURIComponent(o.model)}:generateContent`
  const j = (await post(url, { 'x-goog-api-key': cfg.key }, body, cfg.timeoutMs ?? 90000)) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
    promptFeedback?: { blockReason?: string }
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  }
  const cand = j.candidates?.[0]
  if (!cand) throw new BlockedError(`No answer from the model${j.promptFeedback?.blockReason ? ` (blocked: ${j.promptFeedback.blockReason})` : ''}`)
  const text = (cand.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('')
  const u = j.usageMetadata
  return {
    text,
    inputTokens: u?.promptTokenCount ?? null,
    outputTokens: u ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : null,
    finish: cand.finishReason ?? null,
    api: 'generateContent'
  }
}

interface InteractionResp {
  outputs?: { type?: string; text?: string }[]
  steps?: { type?: string; content?: { type?: string; text?: string }[] }[]
  output_text?: string
  usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number }
  status?: string
}

export function interactionText(j: InteractionResp): string {
  if (typeof j.output_text === 'string') return j.output_text
  if (Array.isArray(j.steps)) {
    return j.steps.filter((s) => s.type === 'model_output').flatMap((s) => s.content || []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('')
  }
  if (Array.isArray(j.outputs)) return j.outputs.filter((x) => (x.type ?? 'text') === 'text' && x.text).map((x) => x.text).join('')
  return ''
}

async function callInteractions(cfg: ProviderCfg, o: CallOpts, use: Use): Promise<CallResult> {
  const generation_config: Record<string, unknown> = { max_output_tokens: o.maxOutput }
  if (use.think) generation_config.thinking_level = 'minimal'
  const body: Record<string, unknown> = { model: o.model, input: use.sys ? o.prompt : `${o.system}\n\n${o.prompt}`, generation_config }
  if (use.sys) body.system_instruction = o.system
  if (use.json) body.response_mime_type = 'application/json'
  const url = `${trimBase(cfg.baseUrl)}/v1beta/interactions`
  const j = (await post(url, { 'x-goog-api-key': cfg.key, 'Api-Revision': '2026-05-20' }, body, cfg.timeoutMs ?? 90000)) as InteractionResp
  const text = interactionText(j)
  if (!text) throw new BlockedError(`Empty answer from the Interactions API${j.status ? ` (status ${j.status})` : ''}`)
  return {
    text,
    inputTokens: j.usage?.total_input_tokens ?? null,
    outputTokens: j.usage ? (j.usage.total_output_tokens ?? 0) + (j.usage.total_thought_tokens ?? 0) : null,
    finish: j.status ?? null,
    api: 'interactions'
  }
}

/** Claude models that accept the server-side refusal fallback (`fallbacks: "default"`). */
export function claudeSupportsFallback(model: string): boolean {
  return /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(model)
}

/** Anthropic Messages API through the official SDK. The queue owns retries, so the SDK's own are off. */
async function callMessages(cfg: ProviderCfg, o: CallOpts, use: Use): Promise<CallResult> {
  const client = new Anthropic({ apiKey: cfg.key, baseURL: trimBase(cfg.baseUrl), maxRetries: 0, timeout: cfg.timeoutMs ?? 90000 })
  let msg: Anthropic.Beta.BetaMessage
  try {
    msg = await client.beta.messages.create({
      model: o.model,
      max_tokens: o.maxOutput + (use.think ? THINK_HEADROOM_LOW : THINK_HEADROOM_DEFAULT),
      ...(use.sys ? { system: o.system } : {}),
      messages: [{ role: 'user', content: use.sys ? o.prompt : `${o.system}\n\n${o.prompt}` }],
      ...(use.think ? { output_config: { effort: 'low' as const } } : {}),
      ...(use.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
    })
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new NetworkError(`Request timed out after ${Math.round((cfg.timeoutMs ?? 90000) / 1000)}s`)
    if (e instanceof Anthropic.APIConnectionError) throw new NetworkError(`Network error: ${e.message}`)
    if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
      const body = e.error ? JSON.stringify(e.error) : e.message
      throw new HttpError(e.status, body, parseRetryAfter(e.headers?.get('retry-after') ?? null, body))
    }
    throw e
  }
  if (msg.stop_reason === 'refusal') {
    const cat = msg.stop_details?.category
    throw new BlockedError(`Claude declined this request${cat ? ` (${cat})` : ''}`)
  }
  // With a fallback, text before the last fallback block came from a model that then declined.
  const lastSwitch = msg.content.map((b) => b.type as string).lastIndexOf('fallback')
  const text = msg.content.slice(lastSwitch + 1).map((b) => (b.type === 'text' ? b.text : '')).join('')
  if (!text) throw new BlockedError(`Empty answer from Claude${msg.stop_reason ? ` (stop reason ${msg.stop_reason})` : ''}`)
  return {
    text,
    inputTokens: msg.usage.input_tokens ?? null,
    outputTokens: msg.usage.output_tokens ?? null,
    finish: msg.stop_reason ?? null,
    api: 'messages'
  }
}

interface OpenAIResp {
  status?: string
  incomplete_details?: { reason?: string } | null
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** OpenAI Responses API. Nothing is stored on OpenAI's side (`store: false`). */
async function callResponses(cfg: ProviderCfg, o: CallOpts, use: Use): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: o.model,
    input: use.sys ? o.prompt : `${o.system}\n\n${o.prompt}`,
    max_output_tokens: o.maxOutput + (use.think ? THINK_HEADROOM_LOW : THINK_HEADROOM_DEFAULT),
    store: false
  }
  if (use.sys) body.instructions = o.system
  if (use.json) body.text = { format: { type: 'json_object' } }
  if (use.think) body.reasoning = { effort: 'low' }
  const url = `${trimBase(cfg.baseUrl)}/v1/responses`
  const j = (await post(url, { Authorization: `Bearer ${cfg.key}` }, body, cfg.timeoutMs ?? 90000)) as OpenAIResp
  const parts = (j.output || []).filter((x) => x.type === 'message').flatMap((x) => x.content || [])
  const refusal = parts.find((c) => c.type === 'refusal')
  if (refusal) throw new BlockedError(`The model declined this request${refusal.refusal ? `: ${refusal.refusal.slice(0, 200)}` : ''}`)
  const text = parts.filter((c) => c.type === 'output_text' && typeof c.text === 'string').map((c) => c.text).join('')
  const reason = j.incomplete_details?.reason
  if (!text) throw new BlockedError(`Empty answer from OpenAI${reason ? ` (incomplete: ${reason})` : j.status ? ` (status ${j.status})` : ''}`)
  return {
    text,
    inputTokens: j.usage?.input_tokens ?? null,
    outputTokens: j.usage?.output_tokens ?? null,
    finish: reason ?? j.status ?? null,
    api: 'responses'
  }
}

export function chooseApi(cfg: Pick<ProviderCfg, 'provider' | 'endpoint'>, caps: ModelCaps): WireApi {
  if (cfg.provider === 'anthropic') return 'messages'
  if (cfg.provider === 'openai') return 'responses'
  if (cfg.endpoint === 'generateContent' || cfg.endpoint === 'interactions') return cfg.endpoint
  return caps.api === 'interactions' ? 'interactions' : 'generateContent'
}

const CALLS: Record<WireApi, (cfg: ProviderCfg, o: CallOpts, use: Use) => Promise<CallResult>> = {
  generateContent: callGenerateContent,
  interactions: callInteractions,
  messages: callMessages,
  responses: callResponses
}

/**
 * Send one request with capability fallback. Mutates and returns `caps` with what was learned.
 * HTTP 400 → drop the refusal fallback, then thinking/effort, then JSON mode, then the system instruction
 * (whichever the error names first).
 */
export async function generate(cfg: ProviderCfg, o: CallOpts, caps: ModelCaps): Promise<{ result: CallResult; caps: ModelCaps; changed: boolean }> {
  const api = chooseApi(cfg, caps)
  // Claude has no schema-free JSON mode; the prompts ask for JSON and replies are parsed robustly.
  const jsonMode = cfg.provider !== 'anthropic'
  const use: Use = {
    sys: caps.system !== false,
    json: jsonMode && o.json && caps.json !== false,
    think: o.thinkMinimal && caps.thinkMinimal !== false,
    fallback: cfg.provider === 'anthropic' && claudeSupportsFallback(o.model) && caps.fallback !== false
  }
  let changed = false
  for (let i = 0; i < 5; i++) {
    try {
      const result = await CALLS[api](cfg, o, use)
      if (use.sys && caps.system !== true) { caps.system = true; changed = true }
      if (use.json && caps.json !== true) { caps.json = true; changed = true }
      if (!jsonMode && caps.json !== false) { caps.json = false; changed = true }
      if (use.think && caps.thinkMinimal !== true) { caps.thinkMinimal = true; changed = true }
      if (use.fallback && caps.fallback !== true) { caps.fallback = true; changed = true }
      return { result, caps, changed }
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400) throw e
      const msg = e.body.toLowerCase()
      const names = (k: string[]): boolean => k.some((x) => msg.includes(x))
      if (use.fallback && names(['fallback'])) {
        use.fallback = false; caps.fallback = false; changed = true; continue
      }
      if (use.think && (names(['thinking', 'thinking_level', 'thinkinglevel', 'effort', 'reasoning']) || !names(['mime', 'json', 'system', 'instructions']))) {
        use.think = false; caps.thinkMinimal = false; changed = true; continue
      }
      if (use.json && (names(['mime', 'json', 'response_mime_type', 'responsemimetype', 'json_object']) || !names(['system', 'instructions']))) {
        use.json = false; caps.json = false; changed = true; continue
      }
      if (use.sys) { use.sys = false; caps.system = false; changed = true; continue }
      throw e
    }
  }
  throw new Error('Request kept failing with HTTP 400 after dropping optional features')
}
