import path from 'path'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, readDocument } from '../src/main/importer'
import { prepare } from '../src/main/preprocess'

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
