import type { Provider, Settings } from './types'

export interface ProviderInfo {
  id: Provider
  label: string
  keyName: string
  keyUrl: string
  keyPlaceholder: string
}

export const PROVIDERS: ProviderInfo[] = [
  { id: 'gemini', label: 'Google Gemini (free tier available)', keyName: 'Google AI Studio API key', keyUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…' },
  { id: 'anthropic', label: 'Anthropic Claude', keyName: 'Claude API key', keyUrl: 'https://platform.claude.com/settings/keys', keyPlaceholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI (ChatGPT)', keyName: 'OpenAI API key', keyUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-…' }
]

export const providerInfo = (p: Provider): ProviderInfo => PROVIDERS.find((x) => x.id === p) ?? PROVIDERS[0]

/** Preset model IDs per provider; the first one is the default when switching to that provider. */
export const MODEL_PRESETS: Record<Provider, string[]> = {
  gemini: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'],
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  openai: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna']
}

/** Rough request duration before any were measured; used only for time estimates. */
export const DEFAULT_REQUEST_MS = 8000

export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com'
}

export const SOUNDS = ['Glass', 'Ping', 'Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Hero', 'Morse', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink']

export const DEFAULT_SETTINGS: Settings = {
  ai: {
    provider: 'gemini',
    model: 'gemma-4-31b-it',
    lastModels: {},
    endpoint: 'auto',
    baseUrls: { ...DEFAULT_BASE_URLS },
    includeModelInCacheKey: false,
    windowTokens: 3500,
    maxOutputTokens: 1200,
    minimalThinking: true
  },
  study: { minutes: 30, useSuggested: false, pace: 120 },
  pomo: { work: 25, brk: 5, long: 15, cycles: 4, perTopic: 'one', n: 3, minutes: 40, autoStartNext: false },
  notify: { sound: 'Glass', bounce: true, badge: true },
  goal: { kind: 'minutes', value: 60, restDaysPerWeek: 1 },
  theme: 'system',
  tools: { markitdown: '' }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep-merge `patch` over `base`. Keys missing in patch keep base values, so new defaults survive old data. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : (patch as T))
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const b = (base as Record<string, unknown>)[k]
    out[k] = isObj(b) && isObj(v) ? deepMerge(b, v) : v
  }
  return out as T
}

export function mergeSettings(stored: unknown): Settings {
  const out = deepMerge(structuredClone(DEFAULT_SETTINGS), stored ?? {})
  // Settings from before multi-provider support had a single Gemini `baseUrl`.
  const legacy = out.ai as Settings['ai'] & { baseUrl?: unknown }
  if (typeof legacy.baseUrl === 'string') {
    const storedUrls = isObj(stored) && isObj(stored.ai) && isObj(stored.ai.baseUrls) ? stored.ai.baseUrls : {}
    if (!('gemini' in storedUrls) && legacy.baseUrl) out.ai.baseUrls.gemini = legacy.baseUrl
    delete legacy.baseUrl
  }
  // Client-side rate limits were removed: the provider's own limit now pauses the queue instead.
  for (const k of ['rpm', 'tpm', 'rpd', 'utilization', 'countInputOnly']) delete (out.ai as unknown as Record<string, unknown>)[k]
  return out
}

/** The base URL for a provider; a blank override falls back to the official endpoint. */
export function baseUrlFor(ai: Settings['ai'], p: Provider = ai.provider): string {
  return ai.baseUrls[p]?.trim() || DEFAULT_BASE_URLS[p]
}
