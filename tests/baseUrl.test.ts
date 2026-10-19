import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_URLS, baseUrlFor, baseUrlProblem, mergeSettings } from '../src/shared/defaults'

describe('base URL safety', () => {
  it('accepts https, local http and blank', () => {
    expect(baseUrlProblem('')).toBeNull()
    expect(baseUrlProblem('https://generativelanguage.googleapis.com')).toBeNull()
    expect(baseUrlProblem('https://proxy.example.com/v1')).toBeNull()
    expect(baseUrlProblem('http://127.0.0.1:8787')).toBeNull()
    expect(baseUrlProblem('http://localhost:8787')).toBeNull()
  })
  it('rejects addresses that could leak the key or hide the real host', () => {
    expect(baseUrlProblem('http://evil.example')).toMatch(/https/)
    expect(baseUrlProblem('https://generativelanguage.googleapis.com@evil.example')).toMatch(/user name/)
    expect(baseUrlProblem('https://x.example/?a=1')).toMatch(/query/)
    expect(baseUrlProblem('https://x.example/#f')).toMatch(/fragment/)
    expect(baseUrlProblem('file:///etc/passwd')).toMatch(/https/)
    expect(baseUrlProblem('not a url')).toMatch(/valid/)
  })
  it('falls back to the official endpoint for unsafe stored or restored values', () => {
    const s = mergeSettings({ ai: { baseUrls: { gemini: 'http://evil.example', openai: 'https://ok.example' } } })
    expect(s.ai.baseUrls.gemini).toBe(DEFAULT_BASE_URLS.gemini)
    expect(s.ai.baseUrls.openai).toBe('https://ok.example')
    expect(baseUrlFor({ ...s.ai, baseUrls: { ...s.ai.baseUrls, gemini: 'http://evil.example' } }, 'gemini')).toBe(DEFAULT_BASE_URLS.gemini)
  })
})
