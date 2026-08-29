/**
 * Hashline edit application (CODING-HARNESS-DESIGN §2.4).
 *
 * All decisions are mechanical — none rely on model discipline:
 *
 * 1. No line matches the signature          → `state_changed`, with current
 *    candidate signatures so the model re-reads instead of guessing.
 * 2. Signature matches but the expected
 *    content prefix does not                → `prefix_mismatch` — the signed
 *    line still exists but its content no longer starts as the model saw.
 * 3. More than one line matches             → `ambiguous`; never pick one
 *    silently, an auto-pick hides ambiguity from the model.
 * 4. Exactly one match and prefix is fine   → apply, whole-line replace.
 */
import { lineSignature } from './signature'

export const MIN_EXPECTED_PREFIX_LENGTH = 1

export type HashlineEditResult
  = | { status: 'applied', lineNumber: number, signature: string }
    | { status: 'state_changed', candidates: { lineNumber: number, signature: string }[] }
    | { status: 'ambiguous', lineNumbers: number[] }
    | { status: 'prefix_mismatch', lineNumber: number, currentSignature: string }

export interface HashlineEditParams {
  lines: string[]
  signature: string
  /** Leading characters of the line the model saw (16-32 in practice). */
  expectedPrefix: string
  newLineContent: string
}

export interface HashlineEditOutcome {
  result: HashlineEditResult
  /** The original array identity is preserved unless the edit applied. */
  lines: string[]
}

/**
 * Applies one signed line edit. On success the returned `lines` is a new
 * array with only the target line replaced; on any rejection the input
 * array is returned untouched.
 */
export function applyHashlineEdit(params: HashlineEditParams): HashlineEditOutcome {
  if (params.expectedPrefix.length < MIN_EXPECTED_PREFIX_LENGTH)
    throw new Error('hashline: expectedPrefix is required (minimum one character)')

  const lineCount = params.lines.length
  const matches: { lineNumber: number, signature: string, content: string }[] = []

  for (let i = 0; i < lineCount; i++) {
    const content = params.lines[i]!
    if (lineSignature(content, { lineCount }) === params.signature)
      matches.push({ lineNumber: i + 1, signature: params.signature, content })
  }

  if (matches.length === 0) {
    return {
      result: {
        status: 'state_changed',
        candidates: params.lines.map((content, index) => ({
          lineNumber: index + 1,
          signature: lineSignature(content, { lineCount }),
        })),
      },
      lines: params.lines,
    }
  }

  if (matches.length > 1) {
    return {
      result: { status: 'ambiguous', lineNumbers: matches.map(match => match.lineNumber) },
      lines: params.lines,
    }
  }

  const match = matches[0]!
  if (!match.content.startsWith(params.expectedPrefix)) {
    return {
      result: {
        status: 'prefix_mismatch',
        lineNumber: match.lineNumber,
        currentSignature: match.signature,
      },
      lines: params.lines,
    }
  }

  const next = [...params.lines]
  next[match.lineNumber - 1] = params.newLineContent
  return {
    result: { status: 'applied', lineNumber: match.lineNumber, signature: match.signature },
    lines: next,
  }
}
