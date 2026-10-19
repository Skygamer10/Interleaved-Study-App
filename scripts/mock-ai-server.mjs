// Mock AI API for tests and manual trials without spending tokens. One server answers all three providers:
// Gemini (generateContent and Interactions), Anthropic (/v1/messages) and OpenAI (/v1/responses).
// Supports scripted failures (429 with Retry-After, 5xx, invalid JSON, 400 for JSON mode, thinking/effort or
// Claude's refusal fallback), and a default "smart" answer for organize/quiz/grade prompts.
//
// Standalone: `npm run mock-ai`. Tests start it on a random port and point settings.ai.baseUrl at it.
import http from 'node:http'
import { pathToFileURL } from 'node:url'

function organizeAnswer(prompt) {
  const range = prompt.match(/Paragraphs p(\d+)-p(\d+):/)
  if (!range) return null
  const from = Number(range[1]), to = Number(range[2])
  const topics = []
  for (let s = from; s <= to; s += 3) {
    const e = Math.min(to, s + 2)
    const m = prompt.match(new RegExp(`\\[p${s}\\] (.*)`))
    const words = (m ? m[1] : 'material').replace(/[#*]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
    topics.push({ start: s, end: e, name: `Concept of ${words}`, unit: 'Mock unit', summary: `Covers paragraphs ${s} to ${e}.`, difficulty: 3, terms: ['alpha', 'beta'], prereqs: [], continues: false })
  }
  const out = { topics }
  if (/propose "title"/.test(prompt)) out.title = 'Mock lesson title'
  return JSON.stringify(out)
}

// Deadlines: every table row with an ISO date becomes a deadline (title = first cell, course = third cell).
function deadlinesAnswer(prompt) {
  const deadlines = []
  for (const line of prompt.split('\n')) {
    if (!line.startsWith('|') || /^\|(\s*-{3,}\s*\|)+$/.test(line)) continue
    const cells = line.slice(1, -1).split(' | ').map((c) => c.trim())
    const date = cells.map((c) => c.match(/\d{4}-\d{2}-\d{2}/)?.[0]).find(Boolean)
    if (date) deadlines.push({ title: cells[0], date, course: cells[2] && cells[2] !== 'NaN' ? cells[2] : null, notes: cells[3] && cells[3] !== 'NaN' ? cells[3] : null })
  }
  return JSON.stringify({ deadlines })
}

function defaultAnswer(system, prompt) {
  if (/extract deadlines/i.test(system)) return deadlinesAnswer(prompt)
  if (/organize study material/i.test(system + prompt)) return organizeAnswer(prompt) ?? '{"topics":[]}'
  if (/quiz/i.test(system)) {
    return JSON.stringify({ questions: [
      { type: 'mc', q: 'Which is right?', options: ['A', 'B', 'C', 'D'], answer: 1, why: 'Because B.' },
      { type: 'mc', q: 'Pick one', options: ['W', 'X', 'Y', 'Z'], answer: 0 },
      { type: 'mc', q: 'Third?', options: ['1', '2', '3', '4'], answer: 2 },
      { type: 'short', q: 'Explain briefly.', answer: 'A short key.' },
      { type: 'short', q: 'Name it.', answer: 'The name.' }
    ] })
  }
  if (/grade short answers/i.test(system)) {
    const n = (prompt.match(/^Item \d+/gm) || []).length
    return JSON.stringify(Array.from({ length: n }, () => ({ correct: true, feedback: 'Matches the key.' })))
  }
  if (/adjacent study topics/i.test(system)) return '[]'
  if (/describe one study topic/i.test(system)) return JSON.stringify({ name: 'Mock enriched', summary: 'A summary.', difficulty: 2, terms: ['t1'], prereqs: [] })
  return '{"ok":true,"reply":"ready"}'
}

export function startMockServer(opts = {}) {
  const state = {
    script: [], // items: { status, retryAfter, body } or { text }
    requests: [],
    rejectJsonMode: !!opts.rejectJsonMode,
    rejectThinking: !!opts.rejectThinking,
    rejectGenerateContent: !!opts.rejectGenerateContent,
    rejectFallbacks: !!opts.rejectFallbacks
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { /* ignore */ }
      const urlPath = req.url.split('?')[0]
      const interactions = urlPath.endsWith('/v1beta/interactions')
      const gc = /\/v1beta\/models\/[^/]+:generateContent$/.test(urlPath)
      const messages = urlPath.endsWith('/v1/messages')
      const responses = urlPath.endsWith('/v1/responses')
      const key = req.headers['x-goog-api-key'] || req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || undefined
      let system = '', prompt = ''
      if (gc) {
        system = body.systemInstruction?.parts?.map((p) => p.text).join('') ?? ''
        prompt = body.contents?.[0]?.parts?.map((p) => p.text).join('') ?? ''
      } else if (interactions) {
        system = body.system_instruction ?? ''
        prompt = body.input ?? ''
      } else if (messages) {
        system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((b) => b.text).join('')
        const c = body.messages?.[0]?.content
        prompt = typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join('')
      } else if (responses) {
        system = body.instructions ?? ''
        prompt = typeof body.input === 'string' ? body.input : ''
      }
      state.requests.push({ url: req.url, body, key })
      const send = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
      }
      if (!gc && !interactions && !messages && !responses) return send(404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } })
      if (!key) return send(403, { error: { code: 403, message: 'Missing API key', status: 'PERMISSION_DENIED' } })
      const bad = (message) => send(400, messages ? { type: 'error', error: { type: 'invalid_request_error', message } } : { error: { message, type: 'invalid_request_error', code: null } })
      if (messages && state.rejectFallbacks && body.fallbacks) return bad('fallbacks: this parameter is not supported for this model')
      if (messages && state.rejectThinking && body.output_config?.effort) return bad('output_config.effort: effort is not supported on this model')
      if (responses && state.rejectThinking && body.reasoning) return bad("Unsupported parameter: 'reasoning.effort' is not supported with this model.")
      if (responses && state.rejectJsonMode && body.text?.format?.type === 'json_object') return bad("'text.format' of type 'json_object' is not supported with this model.")
      if (gc && state.rejectGenerateContent) return send(400, { error: { code: 400, message: 'Use the Interactions API for this model', status: 'INVALID_ARGUMENT' } })
      if (gc && state.rejectThinking && body.generationConfig?.thinkingConfig) {
        return send(400, { error: { code: 400, message: 'thinking_level is not supported for this model', status: 'INVALID_ARGUMENT' } })
      }
      if (gc && state.rejectJsonMode && body.generationConfig?.responseMimeType) {
        return send(400, { error: { code: 400, message: 'response_mime_type application/json is not supported', status: 'INVALID_ARGUMENT' } })
      }
      const step = state.script.shift()
      if (step && step.status) {
        const headers = step.retryAfter !== undefined ? { 'Retry-After': String(step.retryAfter) } : {}
        return send(step.status, step.body ?? { error: { code: step.status, message: 'Scripted failure', status: 'RESOURCE_EXHAUSTED' } }, headers)
      }
      const text = step && step.text !== undefined ? step.text : defaultAnswer(system, prompt)
      const inTok = Math.ceil((system.length + prompt.length) / 4)
      const outTok = Math.ceil(text.length / 4)
      if (messages) {
        return send(200, { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: inTok, output_tokens: outTok } })
      }
      if (responses) {
        return send(200, { id: 'resp_mock', object: 'response', status: 'completed', model: body.model, incomplete_details: null, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok } })
      }
      if (interactions) {
        return send(200, { id: 'int-1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { total_input_tokens: inTok, total_output_tokens: outTok, total_thought_tokens: 0 } })
      }
      return send(200, {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok, totalTokenCount: inTok + outTok }
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startMockServer({ port: Number(process.env.PORT) || 8787 }).then((s) => {
    console.log(`Mock AI API (Gemini, Claude and OpenAI routes) listening on ${s.url}`)
  })
}
