import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import { startMockServer } from '../scripts/mock-ai-server.mjs'
import { Queue } from '../src/main/queue'
import { makeHandlers } from '../src/main/jobs'
import { chunkMarkdown, mergeExtracted, sheetsToMarkdown, validateDeadlines } from '../src/main/deadlines'
import { findMarkitdown, markitdownConvert } from '../src/main/markitdown'
import type { ExtractedDeadline } from '../src/shared/types'
import { setup, tmpDir } from './helpers'

type Mock = Awaited<ReturnType<typeof startMockServer>>
let mock: Mock
beforeAll(async () => { mock = await startMockServer() })
afterAll(async () => { await mock.close() })

const SAMPLE = [
  '## Fall',
  '| Assignment | Due | Course | Notes |',
  '| --- | --- | --- | --- |',
  '| Essay 1 | 2026-11-03 00:00:00 | History | 2000 words |',
  '| Midterm | Nov 12 | Biology | NaN |',
  '| Lab report | 2026-11-20 | Biology | Lab 4 |',
  '',
  '## Schedule',
  '| Week | What |',
  '| --- | --- |',
  '| 1 | Read ch 1 |'
].join('\n')

describe('spreadsheet Markdown', () => {
  it('chunks by rows and repeats the sheet heading and table header in every chunk', () => {
    const chunks = chunkMarkdown(SAMPLE, 2)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].split('\n').slice(0, 3)).toEqual(['## Fall', '| Assignment | Due | Course | Notes |', '| --- | --- | --- | --- |'])
    expect(chunks[1]).toContain('| Assignment | Due | Course | Notes |')
    expect(chunks[1]).toContain('Lab report')
    expect(chunks[2].startsWith('## Schedule\n| Week | What |')).toBe(true)
    expect(chunkMarkdown(SAMPLE)).toHaveLength(2)
  })

  it('builds the same layout without markitdown, escaping pipes and skipping empty sheets', () => {
    const md = sheetsToMarkdown([
      { name: 'Fall', rows: [['Title', 'Due'], ['Lab | 4', '2026-11-20'], [null, null]] },
      { name: 'Empty', rows: [[null]] }
    ])
    expect(md).toBe('## Fall\n| Title | Due |\n| --- | --- |\n| Lab \\| 4 | 2026-11-20 |\n')
  })
})

describe('validating the AI answer', () => {
  it('keeps real dates, drops the rest and cleans placeholder notes', () => {
    const r = validateDeadlines({ deadlines: [
      { title: 'Essay 1', date: '2026-11-03', course: 'History', notes: 'NaN' },
      { title: 'Bad day', date: '2026-02-30' },
      { title: '', date: '2026-12-01' },
      { title: 'No date' }
    ] })
    expect(r.items).toEqual([{ title: 'Essay 1', date: '2026-11-03', courseName: 'History', notes: '' }])
    expect(r.dropped).toBe(3)
    expect(() => validateDeadlines({ nope: 1 })).toThrow()
  })

  it('merges chunks, removing repeats and sorting by date', () => {
    const a: ExtractedDeadline = { title: 'Final', date: '2026-12-10', courseName: 'Bio', notes: '' }
    const b: ExtractedDeadline = { title: 'Quiz', date: '2026-11-01', courseName: null, notes: '' }
    const r = mergeExtracted([{ items: [a, b], dropped: 1 }, { items: [{ ...a, title: 'final' }], dropped: 0 }])
    expect(r.items.map((x) => x.title)).toEqual(['Quiz', 'Final'])
    expect(r.dropped).toBe(1)
  })
})

describe('deadlines job', () => {
  it('sends every chunk to the AI with today and the known courses, and returns the merged list', async () => {
    mock.state.requests = []
    const env = setup()
    env.settings.ai.baseUrls = { gemini: mock.url, anthropic: mock.url, openai: mock.url }
    const q = new Queue({ store: env.store, settings: () => env.settings, getKey: () => 'k', handlers: makeHandlers(env.repo), random: () => 0 })
    const job = env.repo.createJob({ kind: 'deadlines', docId: null, topicId: null, label: 'Find deadlines', payload: { chunks: chunkMarkdown(SAMPLE, 2), today: '2026-10-18', courses: ['Biology'] }, estTokens: 500 })
    const res = (await q.enqueue(job, true)) as { items: ExtractedDeadline[]; dropped: number }
    expect(res.items).toEqual([
      { title: 'Essay 1', date: '2026-11-03', courseName: 'History', notes: '2000 words' },
      { title: 'Lab report', date: '2026-11-20', courseName: 'Biology', notes: 'Lab 4' }
    ])
    expect(mock.state.requests).toHaveLength(3)
    const prompt = mock.state.requests[0].body.contents[0].parts[0].text as string
    expect(prompt).toContain('Today is 2026-10-18.')
    expect(prompt).toContain('Known courses: Biology')
    expect(prompt).toContain('part 1 of 3')
  })
})

// Runs when markitdown is available: MARKITDOWN_PATH, the copy `npm run build` installs, or a global install.
const md = await findMarkitdown(process.env.MARKITDOWN_PATH ?? '', [path.resolve(__dirname, '..', 'vendor', 'markitdown')])
describe.skipIf(!md)('markitdown', () => {
  it('converts an .xlsx file to Markdown tables that the chunker understands', async () => {
    const file = path.join(tmpDir(), 'deadlines.xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Assignment', 'Due', 'Course'], ['Essay 1', '2026-11-03', 'History']]), 'Fall')
    XLSX.writeFile(wb, file)
    const out = await markitdownConvert(md!, file)
    expect(out).toContain('## Fall')
    expect(out).toMatch(/\| Essay 1 \| 2026-11-03 \| History \|/)
    expect(chunkMarkdown(out)[0].split('\n')[0]).toBe('## Fall')
    fs.rmSync(path.dirname(file), { recursive: true })
  })
})
