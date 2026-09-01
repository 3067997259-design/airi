import { describe, expect, it } from 'vitest'

import { formatWorkspaceGrep, normalizeContextLines, normalizeMaxMatches, parseRipgrepEvent, truncateGrepContent } from './grep'

describe('parseRipgrepEvent', () => {
  it('reads a match line without its line ending', () => {
    const event = JSON.stringify({
      type: 'match',
      data: { path: { text: 'src/a.ts' }, lines: { text: 'const a = 1\n' }, line_number: 3 },
    })

    expect(parseRipgrepEvent(event)).toEqual({ path: 'src/a.ts', lineNumber: 3, text: 'const a = 1', matched: true })
  })

  it('marks context lines as unmatched', () => {
    const event = JSON.stringify({
      type: 'context',
      data: { path: { text: 'src/a.ts' }, lines: { text: 'before\n' }, line_number: 2 },
    })

    expect(parseRipgrepEvent(event)?.matched).toBe(false)
  })

  it('ignores events that carry no line', () => {
    expect(parseRipgrepEvent(JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } }))).toBeUndefined()
    expect(parseRipgrepEvent(JSON.stringify({ type: 'summary', data: {} }))).toBeUndefined()
    expect(parseRipgrepEvent('')).toBeUndefined()
    expect(parseRipgrepEvent('not json')).toBeUndefined()
  })

  it('normalizes the path ripgrep echoes from the search argument', () => {
    const event = JSON.stringify({
      type: 'match',
      data: { path: { text: './src/a.ts' }, lines: { text: 'hit\n' }, line_number: 1 },
    })

    expect(parseRipgrepEvent(event)?.path).toBe('src/a.ts')
  })

  it('ignores binary lines, which ripgrep reports as bytes', () => {
    const event = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.bin' }, lines: { bytes: 'AAEC' }, line_number: 1 },
    })

    expect(parseRipgrepEvent(event)).toBeUndefined()
  })
})

describe('search bounds', () => {
  it('clamps the context window', () => {
    expect(normalizeContextLines(undefined)).toBe(0)
    expect(normalizeContextLines(-4)).toBe(0)
    expect(normalizeContextLines(2.7)).toBe(2)
    expect(normalizeContextLines(99)).toBe(5)
  })

  it('clamps the match cap away from zero', () => {
    expect(normalizeMaxMatches(undefined)).toBe(50)
    expect(normalizeMaxMatches(0)).toBe(1)
    expect(normalizeMaxMatches(9_999)).toBe(500)
  })

  it('keeps the start of a long line so expectedPrefix still matches', () => {
    const long = `${'x'.repeat(210)}tail`
    const result = truncateGrepContent(long)

    expect(result.truncated).toBe(true)
    expect(result.content.startsWith('xxxx')).toBe(true)
    expect(result.content.endsWith('…')).toBe(true)
  })
})

describe('formatWorkspaceGrep', () => {
  const query = { pattern: 'createRuntime', glob: '*.ts' }

  it('groups rows under their file and marks context lines', () => {
    const text = formatWorkspaceGrep(query, {
      matches: [
        { path: 'src/a.ts', lineNumber: 2, signature: 'aa', content: 'before', truncated: false, matched: false },
        { path: 'src/a.ts', lineNumber: 3, signature: 'k3', content: 'createRuntime()', truncated: false, matched: true },
        { path: 'src/b.ts', lineNumber: 9, signature: 'zz', content: 'createRuntime()', truncated: false, matched: true },
      ],
      matchCount: 2,
      truncated: false,
    })

    expect(text).toContain('grep "createRuntime" · 2 matches in 2 files · glob *.ts')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('     3  k3  createRuntime()')
    // A context row is marked so the model does not treat it as a hit.
    expect(text).toContain('     2- aa  before')
  })

  it('asks for a narrower pattern when the cap was reached', () => {
    const text = formatWorkspaceGrep({ pattern: 'a' }, {
      matches: [{ path: 'a.ts', lineNumber: 1, signature: 'aa', content: 'a', truncated: false, matched: true }],
      matchCount: 1,
      truncated: true,
    })

    expect(text).toContain('Stopped at 1 matches')
  })

  it('states that a degraded search may be incomplete', () => {
    const text = formatWorkspaceGrep({ pattern: 'a' }, {
      matches: [],
      matchCount: 0,
      truncated: false,
      degradedReason: 'search binary unavailable',
    })

    expect(text).toContain('No match')
    expect(text).toContain('without ripgrep (search binary unavailable)')
  })

  it('names files whose matches could not be signed', () => {
    const text = formatWorkspaceGrep({ pattern: 'a' }, {
      matches: [],
      matchCount: 0,
      truncated: false,
      unreadablePaths: ['src/gone.ts'],
    })

    expect(text).toContain('Could not sign matches in: src/gone.ts')
  })
})
