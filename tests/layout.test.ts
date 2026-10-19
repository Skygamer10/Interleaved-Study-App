import { describe, expect, it } from 'vitest'
import type { Course, Doc } from '../src/shared/types'
import { DEFAULT_PREFS, leaves, moveItem, moveSection, normalize, unfolder, type Item, type Layout } from '../src/renderer/src/layout'

const course = (id: string): Course => ({ id, name: id, color: 0, createdAt: 0 })
const doc = (id: string, courseId: string): Doc => ({
  id, courseId, title: id, fileName: '', path: '', ext: 'md', hash: '', words: 0, paraCount: 0, windows: 0, winsDone: 0,
  status: 'organized', createdAt: 0, updatedAt: 0
})
const base = (): Layout => ({ v: 1, sections: [], lessons: {}, colors: {}, prefs: DEFAULT_PREFS })
const lists = (l: Layout): Item[][] => l.sections.map((s) => s.items)
const roots = (l: Layout): Map<string, Item[]> => new Map(l.sections.map((s) => [s.id, s.items]))

describe('board layout', () => {
  it('puts every course and lesson somewhere and drops vanished ones', () => {
    const l = normalize(base(), [course('a'), course('b')], [doc('d1', 'a'), doc('d2', 'a')])
    expect(l.sections).toHaveLength(1)
    expect(leaves(l.sections[0].items)).toEqual(['a', 'b'])
    expect(leaves(l.lessons.a)).toEqual(['d1', 'd2'])

    l.sections[0].items.push({ kind: 'folder', id: 'f', name: 'F', color: null, items: [{ kind: 'course', id: 'gone' }] })
    l.colors.gone = 'h:25'
    const n = normalize(l, [course('a')], [doc('d2', 'a')])
    expect(leaves(n.sections[0].items)).toEqual(['a'])
    expect(n.sections[0].items[1]).toMatchObject({ kind: 'folder', items: [] })
    expect(leaves(n.lessons.a)).toEqual(['d2'])
    expect(n.colors).toEqual({})
  })

  it('moves courses into folders, between sections, and refuses cycles', () => {
    const l = normalize(base(), [course('a'), course('b'), course('c')], [])
    l.sections.push({ id: 's2', name: 'Two', color: null, items: [] })
    l.sections[0].items.unshift({ kind: 'folder', id: 'f', name: 'F', color: null, items: [] })

    expect(moveItem(lists(l), roots(l), 'b', 'f', 'inside')).toBe(true)
    expect(leaves(l.sections[0].items)).toEqual(['b', 'a', 'c'])
    expect(moveItem(lists(l), roots(l), 'c', 'a', 'before')).toBe(true)
    expect(leaves(l.sections[0].items)).toEqual(['b', 'c', 'a'])
    expect(moveItem(lists(l), roots(l), 'f', 's2', 'inside')).toBe(true)
    expect(leaves(l.sections[1].items)).toEqual(['b'])

    // A folder cannot go inside its own child
    ;(l.sections[1].items[0] as Extract<Item, { kind: 'folder' }>).items.push({ kind: 'folder', id: 'g', name: 'G', color: null, items: [] })
    expect(moveItem(lists(l), roots(l), 'f', 'g', 'inside')).toBe(false)
    expect(leaves(l.sections[1].items)).toEqual(['b'])
  })

  it('reorders sections and dissolves folders in place', () => {
    const l = base()
    l.sections = [{ id: 'x', name: 'X', color: null, items: [] }, { id: 'y', name: 'Y', color: null, items: [] }]
    moveSection(l, 'y', 'x', 'before')
    expect(l.sections.map((s) => s.id)).toEqual(['y', 'x'])

    const items: Item[] = [{ kind: 'lesson', id: '1' }, { kind: 'folder', id: 'f', name: 'F', color: null, items: [{ kind: 'lesson', id: '2' }, { kind: 'lesson', id: '3' }] }, { kind: 'lesson', id: '4' }]
    unfolder([items], 'f')
    expect(items.map((i) => i.id)).toEqual(['1', '2', '3', '4'])
  })
})
