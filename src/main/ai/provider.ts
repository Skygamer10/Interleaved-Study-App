// Provider adapters: Google AI (Gemini API: generateContent baseline and Interactions), Anthropic Claude
// (Messages API via the official SDK) and OpenAI (Responses API).
// Capabilities (system instruction, JSON mode, Gemini structured output, minimal thinking / low effort, Claude
// refusal fallback) are probed and remembered per model: on HTTP 400 the offending feature is dropped and the
// request retried without it.
import Anthropic from '@anthropic-ai/sdk'
import type { Endpoint, ModelCaps, Provider, WireApi } from '../../shared/types'
import { parseRetryAfter } from '../backoff'
import type { JsonSchema } from './schema'

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
  schema?: JsonSchema // Gemini structured output; the other providers ignore it
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
  return { model, api, system: null, json: null, thinkMinimal: null, fallback: null, schema: null }
}

/**
 * Caps as saved, made safe to use. Interactions caps saved while the old top-level response_mime_type was rejected
 * have json false and no schema field: JSON mode is probed once more (schema null marks that as done).
 */
export function normalizeCaps(c: ModelCaps): ModelCaps {
  const out = { ...c }
  if (out.api === 'interactions' && out.json === false && out.schema === undefined) { out.json = null; out.schema = null }
  return out
}

/** A 400 that is about the key, not a feature (Gemini answers a bad key with 400 "API key not valid"). */
export function isAuthError(e: HttpError): boolean {
  return e.status === 400 && /api[ _-]?key|authenticat|credential/i.test(e.body)
}

// think: minimal thinking (Gemini) / low effort (Claude, OpenAI). low: Gemini thinking level low, when minimal is
// rejected. room: Gemini thinking headroom (off when the model's output limit is too small for it).
interface Use { sys: boolean; json: boolean; think: boolean; low: boolean; fallback: boolean; schema: boolean; room: boolean }

// Reasoning models count thinking tokens toward the output cap, so leave room for them on top of the answer.
const THINK_HEADROOM_LOW = 4096
const THINK_HEADROOM_DEFAULT = 12000

const geminiLevel = (use: Use): 'minimal' | 'low' | null => (use.think ? 'minimal' : use.low ? 'low' : null)

// Gemini counts thinking toward maxOutputTokens too: minimal needs no room, low some, the model's default level more.
function geminiMaxOutput(o: CallOpts, use: Use): number {
  if (!use.room || use.think) return o.maxOutput
  return o.maxOutput + (use.low ? THINK_HEADROOM_LOW : THINK_HEADROOM_DEFAULT)
}

/** Gemini models without structured output (image, speech, live, embedding...). Gemma is undocumented: probed. */
export function geminiSupportsSchema(model: string): boolean {
  return !/(image|banana|tts|live|native-audio|embedding|transcribe|omni|lyria|veo)/i.test(model)
}

/**
 * generateContent JSON mode fields. Never sent together with `responseSchema`. To move to the newer field, return
 * `{ responseFormat: { text: { mimeType: 'APPLICATION_JSON', ...(schema ? { schema } : {}) } } }` instead.
 */
export function gcJsonConfig(schema?: JsonSchema): Record<string, unknown> {
  return { responseMimeType: 'application/json', ...(schema ? { responseJsonSchema: schema } : {}) }
}

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
class TooLarge extends Error {}

/** The body as text, refusing anything over MAX_RESPONSE_BYTES (by Content-Length up front, then while reading). */
async function readBody(res: Response, deadline: Promise<never>): Promise<string> {
  if (Number(res.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    void res.body?.cancel().catch(() => undefined)
    throw new TooLarge()
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new TooLarge()
      chunks.push(value)
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined)
    throw e
  }
  return Buffer.concat(chunks).toString('utf8')
}

const timedOut = (ms: number): NetworkError => new NetworkError(`Request timed out after ${Math.round(ms / 1000)}s`)

/** Rejects with a timeout once `signal` aborts. Raced with each await, so a request settles on time even if the
 * HTTP layer misses the abort (seen with fetch while a body stalls). */
function deadlineFor(signal: AbortSignal, ms: number): Promise<never> {
  const p = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(timedOut(ms)), { once: true }))
  p.catch(() => undefined)
  return p
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController()
  // The timer runs until the body is read, so a server that stalls mid-body still times out.
  const deadline = deadlineFor(ctl.signal, timeoutMs)
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res: Response
  let text = ''
  try {
    try {
      res = await Promise.race([fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'error' // a base URL host cannot bounce the key header to another host
      }), deadline])
    } catch (e) {
      throw ctl.signal.aborted ? timedOut(timeoutMs) : new NetworkError(`Network error: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      text = await readBody(res, deadline)
    } catch (e) {
      if (e instanceof TooLarge) throw new Error(`The response was larger than ${MAX_RESPONSE_BYTES / 1048576} MB, so it was not read.`)
      if (ctl.signal.aborted) throw timedOut(timeoutMs)
      if (res.ok) throw new NetworkError(`Network error: ${e instanceof Error ? e.message : String(e)}`)
      // An error status whose body could not be read still reports its status.
    }
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new HttpError(res.status, text, parseRetryAfter(res.headers.get('retry-after'), text))
  try { return JSON.parse(text) } catch { throw new HttpError(502, `Non-JSON response: ${text.slice(0, 200)}`, null) }
}

const trimBase = (u: string): string => u.replace(/\/$/, '')

async function callGenerateContent(cfg: ProviderCfg, o: CallOpts, use: Use): Promise<CallResult> {
  const prompt = use.sys ? o.prompt : `${o.system}\n\n${o.prompt}`
  const generationConfig: Record<string, unknown> = { maxOutputTokens: geminiMaxOutput(o, use) }
  if (use.json) Object.assign(generationConfig, gcJsonConfig(use.schema ? o.schema : undefined))
  const level = geminiLevel(use)
  if (level) generationConfig.thinkingConfig = { thinkingLevel: level }
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
  const generation_config: Record<string, unknown> = { max_output_tokens: geminiMaxOutput(o, use) }
  const level = geminiLevel(use)
  if (level) generation_config.thinking_level = level
  const body: Record<string, unknown> = { model: o.model, input: use.sys ? o.prompt : `${o.system}\n\n${o.prompt}`, generation_config }
  if (use.sys) body.system_instruction = o.system
  // The 2026-05-20 revision removed the top-level response_mime_type; JSON mode and the schema live here.
  if (use.json) body.response_format = { type: 'text', mime_type: 'application/json', ...(use.schema && o.schema ? { schema: o.schema } : {}) }
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
  const timeoutMs = cfg.timeoutMs ?? 90000
  const client = new Anthropic({ apiKey: cfg.key, baseURL: trimBase(cfg.baseUrl), maxRetries: 0, timeout: timeoutMs, fetchOptions: { redirect: 'error' } })
  // The SDK's timeout stops at the response headers; this one also covers reading the body.
  const ctl = new AbortController()
  const deadline = deadlineFor(ctl.signal, timeoutMs)
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let msg: Anthropic.Beta.BetaMessage
  try {
    msg = await Promise.race([client.beta.messages.create({
      model: o.model,
      max_tokens: o.maxOutput + (use.think ? THINK_HEADROOM_LOW : THINK_HEADROOM_DEFAULT),
      ...(use.sys ? { system: o.system } : {}),
      messages: [{ role: 'user', content: use.sys ? o.prompt : `${o.system}\n\n${o.prompt}` }],
      ...(use.think ? { output_config: { effort: 'low' as const } } : {}),
      ...(use.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
    }, { signal: ctl.signal }), deadline])
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionTimeoutError || ctl.signal.aborted) throw timedOut(timeoutMs)
    if (e instanceof Anthropic.APIConnectionError) throw new NetworkError(`Network error: ${e.message}`)
    if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
      const body = e.error ? JSON.stringify(e.error) : e.message
      throw new HttpError(e.status, body, parseRetryAfter(e.headers?.get('retry-after') ?? null, body))
    }
    throw e
  } finally {
    clearTimeout(timer)
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

const THINK_NAMES = ['thinking', 'thinking_level', 'thinkinglevel', 'effort', 'reasoning']
const OUTPUT_NAMES = ['max_output_tokens', 'maxoutputtokens', 'output token']
const SCHEMA_FIELDS = ['responsejsonschema', '_responsejsonschema', 'response_json_schema', 'response_format', 'responseformat']

/** The unknown field a 400 names, as [name, path]: 'Unknown name "anyOf" at 'response_format.schema'' → ['anyof', 'response_format.schema']. */
export function unknownField(msg: string): [string, string] | null {
  const m = msg.toLowerCase().match(/unknown (?:name|field)[^\w$]+([\w.$]+)[^\w$']*(?:at '([^']*)')?/)
  if (!m) return null
  const parts = m[1].split('.')
  const name = parts.pop() ?? ''
  return [name, [m[2] ?? '', ...parts].filter(Boolean).join('.')]
}

/**
 * Send one request with capability fallback. Mutates and returns `caps` with what was learned.
 * HTTP 400 → drop the refusal fallback, then the Gemini schema, then the Gemini thinking headroom, then minimal
 * thinking/low effort (Gemini tries thinking level low next), then JSON mode, then the system instruction
 * (whichever the error names first). A 400 about the API key drops nothing.
 */
export async function generate(cfg: ProviderCfg, o: CallOpts, caps: ModelCaps): Promise<{ result: CallResult; caps: ModelCaps; changed: boolean }> {
  const api = chooseApi(cfg, caps)
  // Claude has no schema-free JSON mode; the prompts ask for JSON and replies are parsed robustly.
  const jsonMode = cfg.provider !== 'anthropic'
  const gemini = cfg.provider === 'gemini'
  const json = jsonMode && o.json && caps.json !== false
  const think = o.thinkMinimal && caps.thinkMinimal !== false
  const use: Use = {
    sys: caps.system !== false,
    json,
    think,
    low: gemini && o.thinkMinimal && !think && caps.thinkLevel !== 'none',
    fallback: cfg.provider === 'anthropic' && claudeSupportsFallback(o.model) && caps.fallback !== false,
    // Structured output rides on JSON mode, so it is never sent without it.
    schema: json && gemini && !!o.schema && caps.schema !== false && geminiSupportsSchema(o.model),
    room: gemini && caps.room !== false
  }
  let changed = false
  // At most one retry per optional feature: fallback, schema, headroom, minimal, low, JSON mode, system instruction.
  for (let i = 0; i < 8; i++) {
    try {
      const result = await CALLS[api](cfg, o, use)
      if (use.sys && caps.system !== true) { caps.system = true; changed = true }
      if (use.json && caps.json !== true) { caps.json = true; changed = true }
      if (!jsonMode && caps.json !== false) { caps.json = false; changed = true }
      if (use.think && caps.thinkMinimal !== true) { caps.thinkMinimal = true; changed = true }
      const level = gemini ? geminiLevel(use) : null
      if (level && caps.thinkLevel !== level) { caps.thinkLevel = level; changed = true }
      if (use.fallback && caps.fallback !== true) { caps.fallback = true; changed = true }
      if (use.schema && (caps.schema !== true || caps.schemaFails)) { caps.schema = true; caps.schemaFails = 0; changed = true }
      return { result, caps, changed }
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400 || isAuthError(e)) throw e
      // Google's unknown-field errors start "Invalid JSON payload received", which says nothing about JSON mode.
      const msg = e.body.toLowerCase().replace(/invalid json payload/g, '')
      const names = (k: string[]): boolean => k.some((x) => msg.includes(x))
      if (use.fallback && names(['fallback'])) {
        use.fallback = false; caps.fallback = false; changed = true; continue
      }
      // Schema problems first, so they never cost thinking, JSON mode or the system instruction.
      if (use.schema) {
        const unknown = unknownField(msg)
        // The model has no structured output: remember it.
        if (names(['json mode is not enabled'])) {
          use.schema = false; use.json = false; caps.schema = false; caps.json = false; changed = true; continue
        }
        if ((unknown && (SCHEMA_FIELDS.includes(unknown[0]) || (unknown[0] === 'schema' && /(^|\.)response_format$|^$/.test(unknown[1])))) ||
          (names(['schema', 'response_format', 'responseformat', 'structured output']) && names(['not supported', 'unsupported', 'not enabled', 'not available']) && names(['model']))) {
          use.schema = false; caps.schema = false; changed = true; continue
        }
        // An unknown keyword inside the schema is that schema's problem: this request goes without it.
        if (unknown && /schema|response_format/.test(unknown[1])) { use.schema = false; continue }
        // Too complex, or a bare INVALID_ARGUMENT: this request goes without it. A success with a schema resets the
        // count, so one schema that is too complex does not turn schemas off at its first failure.
        if (names(['schema', 'response_format', 'too many states', 'constraint', 'nesting', '$ref']) || (!unknown && !names([...THINK_NAMES, ...OUTPUT_NAMES, 'mime', 'json', 'system', 'instructions']))) {
          use.schema = false
          caps.schemaFails = (caps.schemaFails ?? 0) + 1
          if (caps.schemaFails >= 2) caps.schema = false
          changed = true
          continue
        }
      }
      // Output limit: the thinking headroom is dropped for this model if it was the cause; nothing else is.
      if (names(OUTPUT_NAMES)) {
        if (geminiMaxOutput(o, use) > o.maxOutput) { use.room = false; caps.room = false; changed = true; continue }
        throw e
      }
      if ((use.think || use.low) && (names(THINK_NAMES) || !names(['mime', 'json', 'response_format', 'system', 'instructions']))) {
        if (use.think) { use.think = false; caps.thinkMinimal = false; use.low = gemini && caps.thinkLevel !== 'none' } else { use.low = false; caps.thinkLevel = 'none' }
        changed = true; continue
      }
      if (use.json && (names(['mime', 'json', 'response_mime_type', 'responsemimetype', 'json_object', 'response_format']) || !names(['system', 'instructions']))) {
        use.json = false; use.schema = false; caps.json = false; changed = true; continue
      }
      if (use.sys) { use.sys = false; caps.system = false; changed = true; continue }
      throw e
    }
  }
  throw new Error('Request kept failing with HTTP 400 after dropping optional features')
}
