export interface MockStep { status?: number; retryAfter?: number; body?: unknown; text?: string }
export interface MockState {
  script: MockStep[]
  requests: { url: string; body: Record<string, any>; key?: string }[]
  rejectJsonMode: boolean
  rejectThinking: boolean
  rejectGenerateContent: boolean
  rejectFallbacks: boolean
}
export function startMockServer(opts?: { port?: number; rejectJsonMode?: boolean; rejectThinking?: boolean; rejectGenerateContent?: boolean; rejectFallbacks?: boolean }): Promise<{ url: string; state: MockState; close: () => Promise<void> }>
