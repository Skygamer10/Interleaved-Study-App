import { describe, expect, it } from 'vitest'
import { detectHeading, firstSentenceName, prepare } from '../src/main/preprocess'

// Lines crafted to make backtracking regexes slow must not stall the main process during import.
describe('preprocess stays fast on adversarial text', () => {
  const cases = {
    'page-number line padded with mixed whitespace': '1' + ' 　'.repeat(5000) + 'x',
    'heading full of hashes': '# a' + '#'.repeat(40000) + 'b',
    'many angle brackets': '<'.repeat(40000),
    'many parentheses': '('.repeat(40000) + 'a',
    'many square brackets': '['.repeat(40000) + 'a](b'
  }
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      const t0 = Date.now()
      prepare(`${text}\n\nSome real lesson text follows here.`)
      firstSentenceName(text)
      detectHeading(text)
      expect(Date.now() - t0).toBeLessThan(250)
    })
  }
  it('still strips page numbers and links', () => {
    expect(prepare('Intro text here for the lesson.\n\nPage 3 of 10\n\nMore [linked](http://x) text.').text).not.toMatch(/Page 3/)
    expect(firstSentenceName('Enzyme kinetics (Michaelis')).toBe('Enzyme kinetics (Michaelis')
  })
})
