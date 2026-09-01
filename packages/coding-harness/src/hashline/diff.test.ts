import { describe, expect, it } from 'vitest'

import { summarizeLineDiff } from './diff'

describe('summarizeLineDiff', () => {
  it('shows only the changed middle with real line numbers', () => {
    const before = ['a', 'b', 'c', 'd']
    const after = ['a', 'B', 'c', 'd']

    const summary = summarizeLineDiff(before, after)

    expect(summary).toMatchObject({ added: 1, removed: 1 })
    expect(summary.text).toContain('+1 -1')
    expect(summary.text).toContain('-    2  b')
    expect(summary.text).toContain('+    2  B')
    expect(summary.text).not.toContain('a')
  })

  it('reports an insertion without repeating the untouched lines', () => {
    const summary = summarizeLineDiff(['a', 'b'], ['a', 'new', 'b'])

    expect(summary).toMatchObject({ added: 1, removed: 0 })
    expect(summary.text).toContain('+    2  new')
  })

  it('says nothing when the content is identical', () => {
    expect(summarizeLineDiff(['a'], ['a'])).toEqual({ added: 0, removed: 0, text: '' })
  })

  it('bounds the listing so one write cannot flood the result', () => {
    const before = Array.from({ length: 200 }, (_, index) => `old-${index}`)
    const after = Array.from({ length: 200 }, (_, index) => `new-${index}`)

    const summary = summarizeLineDiff(before, after, { lineLimit: 5 })

    expect(summary.added).toBe(200)
    expect(summary.text.split('\n')).toHaveLength(7)
    expect(summary.text).toContain('395 more changed lines')
  })
})
