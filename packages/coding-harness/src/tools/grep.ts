/**
 * Workspace search projection (HARNESS-PLAN §3.5.3 C1).
 *
 * Search is the first step of the grep -> read -> edit loop, and the loop only
 * closes if a hit can be edited without reading the whole file first. Every
 * matched line therefore carries the same content signature the `read`
 * projection would show, computed with the signature width of the whole file:
 * a hit here is a valid `edit` anchor.
 *
 * The pure parsing and rendering live apart from the process that produces
 * hits, so ripgrep's JSON shape and the model-facing text can be tested
 * without spawning anything.
 */
import { DEFAULT_MAX_LINE_CONTENT_LENGTH } from '../hashline/read'

/** Matched lines returned before the result is cut and the model asked to narrow. */
export const DEFAULT_GREP_MAX_MATCHES = 50

/** Upper bound for `contextLines`; more context turns search back into reading. */
export const MAX_GREP_CONTEXT_LINES = 5

export interface WorkspaceGrepQuery {
  /** Regular expression in ripgrep syntax. */
  pattern: string
  /** Directory or file to search, relative to the workspace root. */
  path?: string
  /** Glob filter applied to candidate paths, e.g. `*.ts`. */
  glob?: string
  /** @default 50 */
  maxMatches?: number
  /** Lines of context around each match, 0 to 5. @default 0 */
  contextLines?: number
}

/** One line produced by a search, already signed for `edit`. */
export interface WorkspaceGrepMatch {
  /** Workspace-relative path with forward slashes. */
  path: string
  /** One-based line number. */
  lineNumber: number
  /** Same signature the `read` projection shows for this line. */
  signature: string
  content: string
  truncated: boolean
  /** False for a context line shown around a match. */
  matched: boolean
}

export interface WorkspaceGrepResult {
  matches: WorkspaceGrepMatch[]
  /** Matched lines actually returned (context lines excluded). */
  matchCount: number
  /** Whether the search stopped at the cap and more matches exist. */
  truncated: boolean
  /**
   * Why the slower Node scan answered instead of ripgrep.
   *
   * A degraded search may miss matches that ripgrep would find, so it is
   * reported to the model rather than hidden: a silent downgrade makes it
   * conclude the code it was looking for does not exist (MODS.md M2).
   */
  degradedReason?: string
  /**
   * Files that matched but could not be re-read for signatures.
   *
   * Signing needs the whole file, so a file deleted or locked between the
   * search and the read produces hits that cannot anchor an `edit`. They are
   * named instead of dropped in silence.
   */
  unreadablePaths?: string[]
}

/** One line of ripgrep `--json` output that carries file text. */
export interface RipgrepHit {
  path: string
  lineNumber: number
  text: string
  matched: boolean
}

/**
 * Parses one ripgrep `--json` line into a hit.
 *
 * Returns undefined for the event types that carry no line (begin, end,
 * summary) and for binary or non-UTF-8 lines, which ripgrep reports as
 * `{ bytes }` instead of `{ text }`.
 *
 * @example
 * parseRipgrepEvent('{"type":"match","data":{"path":{"text":"a.ts"},"lines":{"text":"const a = 1\n"},"line_number":3}}')
 * // => { path: 'a.ts', lineNumber: 3, text: 'const a = 1', matched: true }
 */
export function parseRipgrepEvent(line: string): RipgrepHit | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0)
    return undefined

  let event: unknown
  try {
    event = JSON.parse(trimmed)
  }
  catch {
    return undefined
  }

  if (typeof event !== 'object' || event === null)
    return undefined

  const { type, data } = event as { type?: unknown, data?: unknown }
  if ((type !== 'match' && type !== 'context') || typeof data !== 'object' || data === null)
    return undefined

  const payload = data as { path?: { text?: unknown }, lines?: { text?: unknown }, line_number?: unknown }
  const path = payload.path?.text
  const text = payload.lines?.text
  const lineNumber = payload.line_number
  if (typeof path !== 'string' || typeof text !== 'string' || typeof lineNumber !== 'number')
    return undefined

  return {
    path: normalizeHitPath(path),
    lineNumber,
    text: text.replace(/\r?\n$/, ''),
    matched: type === 'match',
  }
}

/**
 * Normalizes a hit path to a workspace-relative POSIX path.
 *
 * ripgrep echoes the search argument it was given, so a whole-workspace search
 * returns `./src/a.ts`; the fallback walk returns `src/a.ts`. Every other tool
 * in the loop takes the second form, so both paths are normalized here.
 *
 * @example
 * normalizeHitPath('./src/a.ts')
 * // => 'src/a.ts'
 */
export function normalizeHitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Clamps a caller-supplied context window into the supported range. */
export function normalizeContextLines(contextLines: number | undefined): number {
  if (contextLines == null || !Number.isFinite(contextLines))
    return 0
  return Math.min(MAX_GREP_CONTEXT_LINES, Math.max(0, Math.floor(contextLines)))
}

/** Clamps the match cap; a zero or negative cap would return an empty search. */
export function normalizeMaxMatches(maxMatches: number | undefined): number {
  if (maxMatches == null || !Number.isFinite(maxMatches))
    return DEFAULT_GREP_MAX_MATCHES
  return Math.min(500, Math.max(1, Math.floor(maxMatches)))
}

/** Truncates one line for display, keeping its start intact for expectedPrefix. */
export function truncateGrepContent(content: string, maxLength = DEFAULT_MAX_LINE_CONTENT_LENGTH): { content: string, truncated: boolean } {
  if (content.length <= maxLength)
    return { content, truncated: false }
  return { content: `${content.slice(0, maxLength)}…`, truncated: true }
}

/**
 * Renders the model-facing search result: a header, then per-file blocks whose
 * rows match the `read` projection layout, so a hit can be fed straight to
 * `edit` without a second look at the file.
 *
 * @example
 * formatWorkspaceGrep({ pattern: 'createRuntime' }, {
 *   matches: [{ path: 'src/a.ts', lineNumber: 3, signature: 'k3', content: 'createRuntime()', truncated: false, matched: true }],
 *   matchCount: 1,
 *   truncated: false,
 * })
 * // => 'grep "createRuntime" · 1 match in 1 file\nsrc/a.ts\n     3  k3  createRuntime()'
 */
export function formatWorkspaceGrep(query: WorkspaceGrepQuery, result: WorkspaceGrepResult): string {
  const files = [...new Set(result.matches.map(match => match.path))]
  const scope = [
    query.path ? `path ${query.path}` : undefined,
    query.glob ? `glob ${query.glob}` : undefined,
  ].filter(Boolean).join(' · ')

  const header = [
    `grep "${query.pattern}" · ${result.matchCount} ${result.matchCount === 1 ? 'match' : 'matches'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`,
    scope.length > 0 ? scope : undefined,
  ].filter(Boolean).join(' · ')

  if (result.matches.length === 0) {
    const empty = [header, 'No match. Widen the pattern, or check path and glob.']
    if (result.unreadablePaths?.length)
      empty.push(`Could not sign matches in: ${result.unreadablePaths.join(', ')}. Read those files directly.`)
    if (result.degradedReason)
      empty.push(degradedNotice(result.degradedReason))
    return empty.join('\n')
  }

  const rows: string[] = [header]
  let currentPath: string | undefined
  for (const match of result.matches) {
    if (match.path !== currentPath) {
      rows.push(match.path)
      currentPath = match.path
    }
    const lineNumber = String(match.lineNumber).padStart(6)
    const marker = match.matched ? ' ' : '-'
    rows.push(`${lineNumber}${marker} ${match.signature}  ${match.content}`)
  }

  if (result.truncated)
    rows.push(`Stopped at ${result.matchCount} matches. Narrow the pattern, or set path or glob.`)
  if (result.unreadablePaths?.length)
    rows.push(`Could not sign matches in: ${result.unreadablePaths.join(', ')}. Read those files directly.`)
  if (result.degradedReason)
    rows.push(degradedNotice(result.degradedReason))

  return rows.join('\n')
}

function degradedNotice(reason: string): string {
  return `Search ran without ripgrep (${reason}); it scans fewer files and may miss matches.`
}
