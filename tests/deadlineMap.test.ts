import { describe, expect, it } from 'vitest'
import { deadlineKey, excelSerialToIso, guessMapping, mapRows, parseDate } from '../src/shared/deadlineMap'

describe('date parsing', () => {
  it('reads ISO, Excel serials, Date objects and month names', () => {
    expect(parseDate('2026-03-14', 'auto').date).toBe('2026-03-14')
    expect(excelSerialToIso(46095)).toBe('2026-03-14')
    expect(parseDate(46095, 'auto').date).toBe('2026-03-14')
    expect(parseDate(new Date(2026, 2, 14), 'auto').date).toBe('2026-03-14')
    expect(parseDate('14 March 2026', 'auto').date).toBe('2026-03-14')
    expect(parseDate('Mar 14, 2026', 'auto').date).toBe('2026-03-14')
    expect(parseDate('Sept 3 2026', 'auto').date).toBe('2026-09-03')
  })
  it('handles day/month order by setting and detection', () => {
    expect(parseDate('14/03/2026', 'auto').date).toBe('2026-03-14')
    expect(parseDate('03/14/2026', 'auto').date).toBe('2026-03-14')
    const amb = parseDate('03/04/2026', 'auto')
    expect(amb.date).toBe('2026-04-03')
    expect(amb.warning).toBeTruthy()
    expect(parseDate('03/04/2026', 'MDY').date).toBe('2026-03-04')
    expect(parseDate('31/02/2026', 'DMY').date).toBeNull()
    expect(parseDate('soon', 'auto').date).toBeNull()
  })
})

describe('column mapping', () => {
  const rows = [
    ['Course', 'Assessment', 'Due date', 'Comments'],
    ['Biology', 'Midterm', '2026-11-02', 'Chapters 1-4'],
    ['Biology', 'Midterm', '2026-11-02', 'dup'],
    ['Chemistry', '', '2026-11-05', ''],
    ['Chemistry', 'Lab report', 'whenever', ''],
    ['Physics', 'Final', 46100, ''],
    [null, null, null, null]
  ]
  it('guesses columns from the header', () => {
    expect(guessMapping(rows[0])).toEqual({ title: 1, date: 2, course: 0, notes: 3, headerRow: true, dateFormat: 'auto' })
  })
  it('maps, validates rows and skips duplicates and existing keys', () => {
    const map = guessMapping(rows[0])
    const r = mapRows(rows, map)
    expect(r.valid.map((v) => v.title)).toEqual(['Midterm', 'Final'])
    expect(r.valid[0]).toMatchObject({ row: 2, date: '2026-11-02', course: 'Biology', notes: 'Chapters 1-4' })
    expect(r.duplicates).toBe(1)
    expect(r.errors).toEqual([{ row: 4, error: 'Missing title' }, { row: 5, error: 'Unreadable date "whenever"' }])
    const again = mapRows(rows, map, new Set([deadlineKey('Midterm', '2026-11-02', 'Biology')]))
    expect(again.valid.map((v) => v.title)).toEqual(['Final'])
  })
})
