import { describe, expect, it } from 'vitest'
import { carryHistory, hasHistory, jaccard, matchTopics, shingles } from '../src/main/history'
import type { Topic } from '../src/shared/types'

const text = (seed: string, n = 60): string => Array.from({ length: n }, (_, i) => `${seed}${i % 13} term${i}`).join(' ')

describe('history matcher', () => {
  it('computes Jaccard on word shingles', () => {
    expect(jaccard(shingles('a b c d e'), shingles('a b c d e'))).toBe(1)
    expect(jaccard(shingles('a b c d e'), shingles('v w x y z'))).toBe(0)
  })
  it('matches by normalized name first', () => {
    const m = matchTopics([{ id: 'o1', name: 'Enzyme Kinetics!', text: 'x' }], [{ id: 'n1', name: 'enzyme kinetics', text: 'totally different' }])
    expect(m.get('n1')).toBe('o1')
  })
  it('matches renamed topics whose text overlaps >= 0.6 and leaves the rest fresh', () => {
    const base = text('alpha')
    const edited = base.replace('term59', 'changed') // tiny edit
    const olds = [{ id: 'o1', name: 'Old name', text: base }, { id: 'o2', name: 'Other', text: text('beta') }]
    const news = [{ id: 'n1', name: 'New better name', text: edited }, { id: 'n2', name: 'Brand new', text: text('gamma') }]
    const m = matchTopics(olds, news)
    expect(m.get('n1')).toBe('o1')
    expect(m.has('n2')).toBe(false)
  })
  it('does not match below the threshold and never reuses an old topic', () => {
    const a = text('alpha', 40)
    const half = a.split(' ').slice(0, 40).join(' ') + ' ' + text('zeta', 40)
    expect(matchTopics([{ id: 'o', name: 'x', text: a }], [{ id: 'n', name: 'y', text: half }]).size).toBe(0)
    const m = matchTopics([{ id: 'o', name: 'Same', text: 'q' }], [{ id: 'n1', name: 'Same', text: 'q' }, { id: 'n2', name: 'Same', text: 'q' }])
    expect(m.size).toBe(1)
  })
  it('carries scheduling fields, reviews, time, override and notes', () => {
    const from = { stab: 4, due: 5, last: 3, evid: 0.7, reviews: [{ at: 1, rating: 'okay', minutes: 30 }], spent: 30, override: 55, notes: 'mine' } as unknown as Topic
    const to = { id: 'n', name: 'New', reviews: [], spent: 0, notes: '' } as unknown as Topic
    const c = carryHistory(to, from)
    expect(c).toMatchObject({ id: 'n', name: 'New', stab: 4, due: 5, last: 3, evid: 0.7, spent: 30, override: 55, notes: 'mine' })
    expect(c.reviews).toHaveLength(1)
    expect(hasHistory(c)).toBe(true)
    expect(hasHistory(to)).toBe(false)
  })
})
