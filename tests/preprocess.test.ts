import { describe, expect, it } from 'vitest'
import { buildWindows, detectHeading, firstSentenceName, normalizeText, prepare, provisionalTopics, stripJunk, toParas } from '../src/main/preprocess'
import { isGenericName, suggestedMinutes } from '../src/shared/util'

const lorem = (n: number, seed = 'cell'): string => Array.from({ length: n }, (_, i) => `${seed}${i % 7} word${i}`).join(' ') + '.'

describe('normalize and junk stripping', () => {
  it('normalizes line endings, hyphenation and spaces', () => {
    expect(normalizeText('Enzy-\nmes  are\r\nproteins here')).toBe('Enzymes are\nproteins here')
  })
  it('removes page numbers, rules and repeated running headers', () => {
    const text = ['Biology 101 Course Notes', 'Real content one.', '', 'Page 2 of 30', '', 'Biology 101 Course Notes', 'Real content two.', '', '---', '', 'Biology 101 Course Notes', 'Real content three.', '', '17'].join('\n')
    const out = stripJunk(text)
    expect(out).not.toMatch(/Page 2/)
    expect(out).not.toMatch(/Biology 101/)
    expect(out).not.toMatch(/^17$/m)
    expect(out).not.toMatch(/---/)
    expect(out).toMatch(/Real content three/)
  })
})

describe('headings and paragraphs', () => {
  it('detects markdown, numbered, caps and bold headings', () => {
    expect(detectHeading('## Enzyme kinetics')).toEqual({ level: 2, text: 'Enzyme kinetics' })
    expect(detectHeading('2.1 Michaelis Menten Model')?.level).toBe(3)
    expect(detectHeading('CELL MEMBRANES')?.level).toBe(2)
    expect(detectHeading('**Key Ideas**')?.text).toBe('Key Ideas')
    expect(detectHeading('This is a normal sentence that ends with a period.')).toBeNull()
  })
  it('numbers paragraphs and splits a heading glued to its body', () => {
    const p = toParas('# Title\nFirst body line.\n\nSecond paragraph here.')
    expect(p.map((x) => x.id)).toEqual([1, 2, 3])
    expect(p[0].heading?.text).toBe('Title')
    expect(p[1].text).toBe('First body line.')
  })
  it('splits very long paragraphs at sentence boundaries', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about membranes and transport.`).join(' ')
    const p = toParas(long)
    expect(p.length).toBeGreaterThan(1)
    expect(p.every((x) => x.words <= 350)).toBe(true)
  })
})

describe('window builder', () => {
  it('builds windows near the target size at paragraph boundaries and covers everything', () => {
    const md = Array.from({ length: 40 }, (_, i) => `${i % 8 === 0 ? `## Section heading ${i}\n\n` : ''}${lorem(120, 'p' + i)}`).join('\n\n')
    const { paras } = prepare(md)
    const wins = buildWindows(paras, 1500)
    expect(wins.length).toBeGreaterThan(2)
    expect(wins[0].from).toBe(1)
    expect(wins[wins.length - 1].to).toBe(paras[paras.length - 1].id)
    for (let i = 1; i < wins.length; i++) expect(wins[i].from).toBe(wins[i - 1].to + 1)
    for (const w of wins.slice(0, -1)) expect(w.tokens).toBeLessThanOrEqual(1500 + 400)
  })
  it('folds a tiny trailing window into the previous one', () => {
    const md = [lorem(900), lorem(900), 'Tiny end.'].join('\n\n')
    const wins = buildWindows(prepare(md).paras, 1600)
    expect(wins[wins.length - 1].tokens).toBeGreaterThan(400)
  })
})

describe('provisional topics never use Part N', () => {
  it('uses headings when present', () => {
    const md = `# Enzymes\n\n## Kinetics basics\n\n${lorem(200)}\n\n## Inhibition types\n\n${lorem(200)}`
    const prep = prepare(md)
    const names = provisionalTopics(prep.paras, 'Lesson 3').map((t) => t.name)
    expect(names).toContain('Kinetics basics')
    expect(names).toContain('Inhibition types')
  })
  it('uses first sentences for flat text with no headings', () => {
    const md = Array.from({ length: 12 }, (_, i) => `The ${['mitochondria', 'ribosome', 'nucleus'][i % 3]} performs important cellular work number ${i}. ${lorem(150)}`).join('\n\n')
    const topics = provisionalTopics(prepare(md).paras, 'Cells')
    expect(topics.length).toBeGreaterThan(1)
    for (const t of topics) {
      expect(isGenericName(t.name)).toBe(false)
      expect(t.name).not.toMatch(/^(part|section|chunk)\s*\d+/i)
    }
  })
  it('replaces generic headings like "Section 2" with real names', () => {
    const md = `## Section 2\n\nOsmosis moves water across membranes by diffusion. ${lorem(120)}`
    const t = provisionalTopics(prepare(md).paras, 'Lesson')
    expect(t[0].name).toMatch(/^Osmosis moves water/)
  })
  it('names from the first meaningful sentence, about six words', () => {
    expect(firstSentenceName('In this section, glycolysis converts glucose into pyruvate in the cytosol.')).toBe('Glycolysis converts glucose into pyruvate')
  })
  it('generic name detector', () => {
    for (const n of ['Part 1', 'part 12', 'Section 3', 'Chunk 7', 'Segment 2', '4', 'Part IV']) expect(isGenericName(n)).toBe(true)
    expect(isGenericName('Part of the cell cycle')).toBe(false)
  })
})

describe('suggested minutes', () => {
  it('uses ~120 wpm, rounds to 5 and clamps 10..60, then adjusts by difficulty', () => {
    expect(suggestedMinutes(100)).toBe(10)
    expect(suggestedMinutes(3000)).toBe(25)
    expect(suggestedMinutes(20000)).toBe(60)
    expect(suggestedMinutes(3000, 5)).toBe(35) // 25 * 1.3 = 32.5 -> 35
    expect(suggestedMinutes(6000, 1)).toBe(45) // 50 * 0.9 = 45
  })
})
