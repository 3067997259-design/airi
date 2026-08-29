import { describe, expect, it } from 'vitest'

import { buildSignedFileProjection, formatSignedFileProjection } from './read'

const FIXTURE = [
  'export async function run(rawArgs: string[]): Promise<void> {',
  '  const flags = parseArgs(rawArgs)',
  '  if (flags.help) return printHelp()',
  '}',
]

describe('hashline read projection', () => {
  it('signs every line with a 1-based line number', () => {
    const projection = buildSignedFileProjection(FIXTURE)
    expect(projection).toHaveLength(4)
    expect(projection[0]).toMatchObject({ lineNumber: 1 })
    expect(projection[3]).toMatchObject({ lineNumber: 4 })
    for (const line of projection)
      expect(line.signature).toMatch(/^[2-7a-z]+$/)
  })

  it('truncates long lines but keeps the leading chars intact', () => {
    const long = `const ${'x'.repeat(300)} = 1`
    const projection = buildSignedFileProjection([long], { maxLineContentLength: 40 })
    expect(projection[0]?.content.length).toBe(41)
    expect(projection[0]?.content.endsWith('…')).toBe(true)
    expect(projection[0]?.content.startsWith(long.slice(0, 40))).toBe(true)
    expect(projection[0]?.truncated).toBe(true)
  })

  it('signs as one file unit so width follows the full line count', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`)
    const projection = buildSignedFileProjection(lines)
    expect(projection[0]?.signature).toHaveLength(3)
  })

  it('formats the flat model-facing projection', () => {
    const text = formatSignedFileProjection({
      path: 'src/adapters/opencode.ts',
      lines: FIXTURE,
      mtime: '2026-08-28T10:12',
    })
    const rows = text.split('\n')
    expect(rows[0]).toBe('src/adapters/opencode.ts  (4 行 · mtime 2026-08-28T10:12)')
    expect(rows[1]).toMatch(/^ {5}1 {2}.. {2}export async function run/)
    expect(rows[4]).toMatch(/^ {5}4 {2}.. {2}\}/)
    // No wrapper-tag markup anywhere (issue #1539 constraint: flat bullets
    // only — model-visible projections must not echo XML-ish structures).
    expect(text).not.toMatch(/<\/[a-z]+>/)
    expect(text).not.toMatch(/^\s*<[a-z]+>/m)
  })
})
