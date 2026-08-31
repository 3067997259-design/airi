import { fnv1a32 } from './signature'

export type TextLineEnding = '\n' | '\r\n'

/** Parsed text with the facts needed for safe read/edit/write round trips. */
export interface TextFileSnapshot {
  lines: string[]
  lineEnding: TextLineEnding
  mixedLineEndings: boolean
  baseHash: string
}

/**
 * Returns the short whole-file hash used by guarded writes.
 *
 * @example
 * contentHash('hello\n')
 * // => an eight-character hexadecimal hash
 */
export function contentHash(content: string): string {
  return fnv1a32(content).toString(16).padStart(8, '0')
}

/**
 * Parses file content without putting carriage returns into line signatures.
 * The first line ending selects the output style for mixed files.
 *
 * @example
 * parseTextFile('a\r\nb\r\n').lineEnding
 * // => '\r\n'
 */
export function parseTextFile(content: string): TextFileSnapshot {
  const endings = content.match(/\r\n|\n/g) ?? []
  const lineEnding: TextLineEnding = endings[0] === '\r\n' ? '\r\n' : '\n'
  return {
    lines: content.split(/\r?\n/),
    lineEnding,
    mixedLineEndings: endings.some(ending => ending !== lineEnding),
    baseHash: contentHash(content),
  }
}

/** Joins parsed lines with the selected file line ending. */
export function joinTextFile(lines: readonly string[], lineEnding: TextLineEnding): string {
  return lines.join(lineEnding)
}
