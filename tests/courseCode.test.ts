import { describe, expect, it } from 'vitest'
import { courseCode } from '../src/shared/util'

describe('courseCode', () => {
  it('reads a course code at the start of a file name', () => {
    expect(courseCode('CHM110 - Oct 9 - Equilibrium.md')).toBe('CHM110')
    expect(courseCode('bio 201_notes.txt')).toBe('BIO201')
    expect(courseCode('MAT135H5-lecture 3.pdf')).toBe('MAT135H5')
    expect(courseCode('CHM110F week 2.md')).toBe('CHM110F')
  })
  it('ignores dates, weeks and plain titles', () => {
    expect(courseCode('Oct 2026 review.md')).toBeNull()
    expect(courseCode('Week 101 notes.md')).toBeNull()
    expect(courseCode('Chemical Equilibrium.md')).toBeNull()
    expect(courseCode('Lecture 5.md')).toBeNull()
  })
})
