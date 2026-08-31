/**
 * Hashline range editing (CODING-HARNESS-DESIGN §2.4).
 *
 * Every boundary is resolved mechanically from content signatures. A missing,
 * ambiguous, or prefix-mismatched boundary leaves the input unchanged.
 */
import { lineSignature } from './signature'

export const MIN_EXPECTED_PREFIX_LENGTH = 1

type HashlineBoundary = 'start' | 'end' | 'after'

export type HashlineEditResult
  = | { status: 'applied', lineNumber: number, endLineNumber?: number, signature: string, insertedLineCount?: number }
    | { status: 'state_changed', boundary?: HashlineBoundary, candidates: { lineNumber: number, signature: string }[] }
    | { status: 'ambiguous', boundary?: HashlineBoundary, lineNumbers: number[] }
    | { status: 'prefix_mismatch', boundary?: HashlineBoundary, lineNumber: number, currentSignature: string }

export interface HashlineEditParams {
  lines: string[]
  startSignature: string
  endSignature?: string
  /** Leading characters of the start line the model saw. */
  expectedPrefix: string
  /** Replacement content. Multiple lines replace the range; an empty string deletes it. */
  newContent: string
}

export interface HashlineInsertAfterParams {
  lines: string[]
  afterSignature: string
  /** Leading characters of the anchor line the model saw. */
  expectedPrefix: string
  /** One or more lines inserted after the anchor. */
  newContent: string
}

export interface HashlineEditOutcome {
  result: HashlineEditResult
  /** The original array identity is preserved unless the edit applied. */
  lines: string[]
}

interface SignatureMatch {
  content: string
  lineNumber: number
  signature: string
}

function candidatesFor(lines: readonly string[]): { lineNumber: number, signature: string }[] {
  const lineCount = lines.length
  return lines.map((content, index) => ({
    lineNumber: index + 1,
    signature: lineSignature(content, { lineCount }),
  }))
}

function locateBoundary(lines: readonly string[], signature: string, boundary?: HashlineBoundary): SignatureMatch | HashlineEditResult {
  const lineCount = lines.length
  const matches: SignatureMatch[] = []
  for (let index = 0; index < lineCount; index++) {
    const content = lines[index]!
    if (lineSignature(content, { lineCount }) === signature)
      matches.push({ content, lineNumber: index + 1, signature })
  }

  if (matches.length === 0) {
    return {
      status: 'state_changed',
      ...(boundary ? { boundary } : {}),
      candidates: candidatesFor(lines),
    }
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      ...(boundary ? { boundary } : {}),
      lineNumbers: matches.map(match => match.lineNumber),
    }
  }
  return matches[0]!
}

function isEditResult(value: SignatureMatch | HashlineEditResult): value is HashlineEditResult {
  return 'status' in value
}

function validatePrefix(match: SignatureMatch, expectedPrefix: string, boundary?: HashlineBoundary): HashlineEditResult | undefined {
  if (match.content.startsWith(expectedPrefix))
    return undefined
  return {
    status: 'prefix_mismatch',
    ...(boundary ? { boundary } : {}),
    lineNumber: match.lineNumber,
    currentSignature: match.signature,
  }
}

function replacementLines(content: string): string[] {
  return content === '' ? [] : content.split(/\r?\n/)
}

/** Applies a signed single-line or closed-range replacement. */
export function applyHashlineEdit(params: HashlineEditParams): HashlineEditOutcome {
  if (params.expectedPrefix.length < MIN_EXPECTED_PREFIX_LENGTH)
    throw new Error('hashline: expectedPrefix is required (minimum one character)')

  const start = locateBoundary(params.lines, params.startSignature)
  if (isEditResult(start))
    return { result: start, lines: params.lines }

  const prefixFailure = validatePrefix(start, params.expectedPrefix)
  if (prefixFailure)
    return { result: prefixFailure, lines: params.lines }

  let end = start
  if (params.endSignature !== undefined && params.endSignature !== params.startSignature) {
    const locatedEnd = locateBoundary(params.lines, params.endSignature, 'end')
    if (isEditResult(locatedEnd))
      return { result: locatedEnd, lines: params.lines }
    end = locatedEnd
  }

  if (end.lineNumber < start.lineNumber)
    throw new Error('hashline: endSignature must resolve at or after startSignature')

  const replacement = replacementLines(params.newContent)
  const next = [...params.lines]
  next.splice(start.lineNumber - 1, end.lineNumber - start.lineNumber + 1, ...replacement)
  return {
    result: {
      status: 'applied',
      lineNumber: start.lineNumber,
      ...(end.lineNumber !== start.lineNumber ? { endLineNumber: end.lineNumber } : {}),
      signature: start.signature,
    },
    lines: next,
  }
}

/** Inserts one or more lines after a signed anchor without replacing it. */
export function applyHashlineInsertAfter(params: HashlineInsertAfterParams): HashlineEditOutcome {
  if (params.expectedPrefix.length < MIN_EXPECTED_PREFIX_LENGTH)
    throw new Error('hashline: expectedPrefix is required (minimum one character)')
  if (params.newContent.length === 0)
    throw new Error('hashline: newContent is required for insertAfter')

  const anchor = locateBoundary(params.lines, params.afterSignature, 'after')
  if (isEditResult(anchor))
    return { result: anchor, lines: params.lines }
  const prefixFailure = validatePrefix(anchor, params.expectedPrefix, 'after')
  if (prefixFailure)
    return { result: prefixFailure, lines: params.lines }

  const inserted = replacementLines(params.newContent)
  const next = [...params.lines]
  next.splice(anchor.lineNumber, 0, ...inserted)
  return {
    result: {
      status: 'applied',
      lineNumber: anchor.lineNumber + 1,
      signature: anchor.signature,
      insertedLineCount: inserted.length,
    },
    lines: next,
  }
}
