/**
 * Signed read projection (CODING-HARNESS-DESIGN §2.4).
 *
 * The `read` tool shows every line together with its content signature and
 * line number; the model references signatures, never raw line text. Line
 * numbers are navigation aids, signatures are identities.
 */
import { lineSignature } from './signature'

export const DEFAULT_MAX_LINE_CONTENT_LENGTH = 200
export const DEFAULT_READ_LINE_LIMIT = 400

export interface SignedLine {
  lineNumber: number
  signature: string
  content: string
  truncated: boolean
}

export interface SignedFileProjectionOptions {
  /** Lines longer than this are truncated with an ellipsis; the leading chars stay intact for prefix confirmation. */
  maxLineContentLength?: number
  /** Zero-based first line index. @default 0 */
  offset?: number
  /** Maximum lines in this projection. @default 400 */
  limit?: number
}

/**
 * Builds the signed line list for a file. Truncation keeps the beginning of
 * the line, so `expectedPrefix` (drawn from the first 16-32 visible
 * characters) still matches after truncation.
 */
export function buildSignedFileProjection(
  lines: string[],
  options: SignedFileProjectionOptions = {},
): SignedLine[] {
  const maxLength = options.maxLineContentLength ?? DEFAULT_MAX_LINE_CONTENT_LENGTH
  const lineCount = lines.length
  const offset = Math.min(lineCount, Math.max(0, Math.floor(options.offset ?? 0)))
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_READ_LINE_LIMIT))

  return lines.slice(offset, offset + limit).map((content, index) => {
    const truncated = content.length > maxLength
    return {
      lineNumber: offset + index + 1,
      signature: lineSignature(content, { lineCount }),
      content: truncated ? `${content.slice(0, maxLength)}…` : content,
      truncated,
    }
  })
}

export interface FormatSignedFileProjectionInput {
  path: string
  lines: string[]
  /** Displayed as-is; the caller formats timestamps (e.g. ISO without seconds). */
  mtime?: string
  /** Whole-file hash required by the write tool. */
  baseHash?: string
  /** Detected file line ending. */
  lineEnding?: '\n' | '\r\n'
  /** Whether the input used more than one line-ending style. */
  mixedLineEndings?: boolean
}

/**
 * Renders the flat model-facing projection (§2.4 example shape): a header
 * line with path / line count / mtime, then one `lineNo  signature  content`
 * row per line.
 *
 * @example
 * formatSignedFileProjection({
 *   path: 'src/adapters/opencode.ts',
 *   lines: ['export async function run() {', '}'],
 *   mtime: '2026-08-28T10:12',
 * })
 * // => 'src/adapters/opencode.ts  (2 行 · mtime 2026-08-28T10:12)\n   1  m2  export async function run() {\n   2  xx  }'
 */
export function formatSignedFileProjection(input: FormatSignedFileProjectionInput, options: SignedFileProjectionOptions = {}): string {
  const lines = buildSignedFileProjection(input.lines, options)
  const first = lines[0]?.lineNumber ?? 0
  const last = lines.at(-1)?.lineNumber ?? 0
  const hasMore = last < input.lines.length
  const ending = input.lineEnding === '\r\n' ? 'CRLF' : input.lineEnding === '\n' ? 'LF' : undefined
  const header = [
    `${input.path}  (${input.lines.length} lines`,
    `showing ${first}-${last}`,
    `more ${hasMore ? 'yes' : 'no'}`,
    input.baseHash ? `baseHash ${input.baseHash}` : undefined,
    input.mtime ? `mtime ${input.mtime}` : undefined,
    ending ? `lineEnding ${ending}${input.mixedLineEndings ? ' (mixed input normalized on edit)' : ''}` : undefined,
  ].filter(Boolean).join(' · ') + ')'
  const rows = lines.map((line) => {
    const lineNumber = String(line.lineNumber).padStart(4)
    return `  ${lineNumber}  ${line.signature}  ${line.content}`
  })
  return [header, ...rows].join('\n')
}
