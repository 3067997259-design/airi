import { describe, expect, it } from 'vitest'

import { joinTextFile, parseTextFile } from './text'

describe('text file snapshot', () => {
  it('keeps CRLF when one line changes', () => {
    const snapshot = parseTextFile('const a = 1\r\nconst b = 2\r\n')
    const next = [...snapshot.lines]
    next[0] = 'const a = 42'

    expect(snapshot.lineEnding).toBe('\r\n')
    expect(joinTextFile(next, snapshot.lineEnding)).toBe('const a = 42\r\nconst b = 2\r\n')
  })

  it('detects mixed line endings and normalizes with the first file ending', () => {
    const snapshot = parseTextFile('a\r\nb\nc\r\n')

    expect(snapshot.mixedLineEndings).toBe(true)
    expect(snapshot.lineEnding).toBe('\r\n')
    expect(joinTextFile(snapshot.lines, snapshot.lineEnding)).toBe('a\r\nb\r\nc\r\n')
  })
})
