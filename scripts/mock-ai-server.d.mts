export interface MockStep { status?: number; retryAfter?: number; body?: unknown; text?: string; redirect?: string; stall?: boolean; bytes?: number; chunked?: boolean }
export interface MockState {
  script: MockStep[]
  requests: { url: string; body: Record<string, any>; key?: string }[]
  rejectJsonMode: boolean
  rejectThinking: boolean
  rejectGenerateContent: boolean
  rejectFallbacks: boolean
  rejectSchema: 'nojson' | 'unknown' | 'keyword' | 'unsupported' | 'complex' | 'bare' | null
  rejectMinimal: boolean | 'bare'
  maxOutputLimit: number | null
}
export function startMockServer(opts?: { port?: number; rejectJsonMode?: boolean; rejectThinking?: boolean; rejectGenerateContent?: boolean; rejectFallbacks?: boolean; rejectSchema?: MockState['rejectSchema']; rejectMinimal?: MockState['rejectMinimal']; maxOutputLimit?: number | null }): Promise<{ url: string; state: MockState; close: () => Promise<void> }>
/** The mock's default answer for a prompt (shaped like that prompt's Gemini response schema). */
export function defaultAnswer(system: string, prompt: string): string
