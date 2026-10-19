import path from 'path'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, importPaths, readDocument } from '../src/main/importer'
import { prepare } from '../src/main/preprocess'
import type { Course, Doc } from '../src/shared/types'
import { setup, writeLesson } from './helpers'

const fx = (n: string): string => path.join(__dirname, 'fixtures', n)

describe('best-effort PDF and DOCX import', () => {
  it('extracts PDF text with a heading from the larger font', async () => {
    const r = await readDocument(fx('sample.pdf'))
    expect(r.note).toMatch(/best effort/)
    expect(r.text).toMatch(/^#+ Enzyme Kinetics/m)
    expect(prepare(r.text).paras.some((p) => p.heading?.text === 'Enzyme Kinetics')).toBe(true)
  })
  it('converts DOCX to Markdown with headings', async () => {
    const r = await readDocument(fx('sample.docx'))
    expect(r.text).toMatch(/^# Membrane Transport/m)
    expect(r.text).toMatch(/^## Pumps/m)
  })
  it('converts simple HTML to Markdown', () => {
    expect(htmlToMarkdown('<h2>A &amp; B</h2><p>Text <strong>bold</strong></p><ul><li>one</li></ul>')).toBe('## A & B\n\nText **bold**\n\n- one')
  })
})

describe('courses the student names', () => {
  it('creates an empty course and refuses a name that is already taken', () => {
    const env = setup()
    const c = env.repo.createCourse('  Organic Chemistry ')
    expect(c.name).toBe('Organic Chemistry')
    expect(env.store.byParent<Doc>('docs', c.id)).toHaveLength(0)
    expect(() => env.repo.createCourse('organic chemistry')).toThrow(/already a course/)
    expect(() => env.repo.createCourse('   ')).toThrow(/name/)
  })
  it('imports files and folders into the chosen course instead of naming one after them', async () => {
    const env = setup()
    const c = env.repo.createCourse('Cell Biology')
    const a = writeLesson(env.dir, 'CHM110 stuff', 'CHM110 - Lesson 1.md', 3)
    writeLesson(env.dir, 'Transcriptions', 'Week 2.md', 4)
    const res = await importPaths(env.repo, [a, path.join(env.dir, 'Transcriptions')], false, c.id)
    expect(res.added).toBe(2)
    expect(env.store.all<Course>('courses').map((x) => x.name)).toEqual(['Cell Biology'])
    expect(res.docIds.map((id) => env.store.get<Doc>('docs', id)?.courseId)).toEqual([c.id, c.id])
  })
  it('rejects a course that no longer exists', async () => {
    const env = setup()
    await expect(importPaths(env.repo, [writeLesson(env.dir)], false, 'gone')).rejects.toThrow(/no longer exists/)
  })
})
