/**
 * Line diff summary for write and edit results (HARNESS-PLAN §9.1).
 *
 * `wrote <path>` told the user nothing about what changed, and the fork has
 * deliberately kept the UI small, so the review surface lives in the tool
 * result itself: the model and the user read the same lines.
 *
 * The comparison is deliberately naive — a common prefix and suffix around one
 * changed middle. Real edits are contiguous, and a full LCS would spend time
 * and result space on a nicer rendering of the same fact.
 */

/** Changed lines shown before the summary stops listing them. */
export const DEFAULT_DIFF_LINE_LIMIT = 20

/** Characters kept per shown line. */
const MAX_DIFF_LINE_LENGTH = 160

export interface LineDiffSummary {
  added: number
  removed: number
  /** Model-facing rendering; empty when nothing changed. */
  text: string
}

export interface LineDiffOptions {
  /** @default 20 */
  lineLimit?: number
}

/**
 * Summarizes the change between two versions of a file.
 *
 * @example
 * summarizeLineDiff(['a', 'b'], ['a', 'c'])
 * // => { added: 1, removed: 1, text: '+1 -1\n-    2  b\n+    2  c' }
 */
export function summarizeLineDiff(before: readonly string[], after: readonly string[], options: LineDiffOptions = {}): LineDiffSummary {
  const lineLimit = Math.max(1, Math.floor(options.lineLimit ?? DEFAULT_DIFF_LINE_LIMIT))

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++

  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }

  const removedLines = before.slice(prefix, before.length - suffix)
  const addedLines = after.slice(prefix, after.length - suffix)
  if (removedLines.length === 0 && addedLines.length === 0)
    return { added: 0, removed: 0, text: '' }

  const rows: string[] = []
  let shown = 0
  for (const [index, line] of removedLines.entries()) {
    if (shown >= lineLimit)
      break
    rows.push(formatDiffRow('-', prefix + index + 1, line))
    shown++
  }
  for (const [index, line] of addedLines.entries()) {
    if (shown >= lineLimit)
      break
    rows.push(formatDiffRow('+', prefix + index + 1, line))
    shown++
  }

  const hidden = removedLines.length + addedLines.length - shown
  if (hidden > 0)
    rows.push(`… ${hidden} more changed line${hidden === 1 ? '' : 's'}`)

  return {
    added: addedLines.length,
    removed: removedLines.length,
    text: [`+${addedLines.length} -${removedLines.length}`, ...rows].join('\n'),
  }
}

function formatDiffRow(marker: '+' | '-', lineNumber: number, content: string): string {
  const trimmed = content.length > MAX_DIFF_LINE_LENGTH ? `${content.slice(0, MAX_DIFF_LINE_LENGTH)}…` : content
  return `${marker} ${String(lineNumber).padStart(4)}  ${trimmed}`
}
