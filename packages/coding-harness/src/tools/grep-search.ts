/**
 * Workspace search execution (HARNESS-PLAN §3.5.3 C1).
 *
 * Two paths produce the same raw hits: the bundled ripgrep binary, and a Node
 * directory walk for machines where the binary is missing or cannot be
 * spawned. The binary is bundled instead of probed on PATH so behavior does
 * not change from one user machine to the next, and the fallback reports
 * itself: a silent downgrade would let the model conclude that code it cannot
 * find does not exist.
 *
 * This module owns process and filesystem work only. Signatures are added by
 * the workspace host, which already owns file reads.
 */
import type { RipgrepHit, WorkspaceGrepQuery } from './grep'

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

import { normalizeContextLines, normalizeMaxMatches, parseRipgrepEvent } from './grep'

/** Wall-clock bound for one search; a long search blocks the whole tool loop. */
const SEARCH_TIMEOUT_MS = 20_000

/** Largest file the fallback walk reads; ripgrep applies the same limit itself. */
const MAX_SCANNED_FILE_BYTES = 5_000_000

/**
 * Directories the fallback never enters.
 *
 * ripgrep reads .gitignore, so this list only has to cover the fallback. It is
 * the set that makes a repository scan finish in seconds instead of minutes.
 */
const FALLBACK_EXCLUDED_DIRECTORIES = Object.freeze(new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '.output',
  '.nuxt',
  '.next',
  'target',
]))

export interface WorkspaceSearchOptions {
  /** Absolute workspace root; all hit paths come back relative to it. */
  root: string
  query: WorkspaceGrepQuery
  /**
   * Ripgrep executable. `null` forces the fallback walk, which is how the
   * degraded path is tested without uninstalling the binary.
   */
  rgPath?: string | null
}

export interface WorkspaceSearchOutcome {
  hits: RipgrepHit[]
  truncated: boolean
  degradedReason?: string
}

/**
 * Resolves the bundled ripgrep binary.
 *
 * NOTICE:
 * Electron packages the app into app.asar, and a binary inside an archive
 * cannot be spawned. electron-builder unpacks it next to the archive, so the
 * path the package reports has to be redirected to app.asar.unpacked. The
 * archive path is what the package computes from its own module location, and
 * asarUnpack in electron-builder.config.ts is what puts the real file there.
 */
export async function resolveRipgrepPath(): Promise<string | undefined> {
  try {
    const module: unknown = await import('@vscode/ripgrep')
    const candidate = (module as { rgPath?: string }).rgPath
      ?? (module as { default?: { rgPath?: string } }).default?.rgPath
    if (typeof candidate !== 'string' || candidate.length === 0)
      return undefined

    const unpacked = candidate.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    if (unpacked !== candidate && existsSync(unpacked))
      return unpacked
    return existsSync(candidate) ? candidate : undefined
  }
  catch {
    return undefined
  }
}

/** Runs one search, preferring ripgrep and falling back to a Node walk. */
export async function searchWorkspace(options: WorkspaceSearchOptions): Promise<WorkspaceSearchOutcome> {
  const rgPath = options.rgPath === null ? undefined : options.rgPath ?? await resolveRipgrepPath()
  if (!rgPath) {
    const walked = await searchByWalking(options)
    return { ...walked, degradedReason: options.rgPath === null ? 'search binary disabled' : 'search binary unavailable' }
  }

  try {
    return await searchWithRipgrep(rgPath, options)
  }
  catch (error) {
    const walked = await searchByWalking(options)
    return { ...walked, degradedReason: errorMessageFrom(error) ?? 'search binary failed' }
  }
}

async function searchWithRipgrep(rgPath: string, options: WorkspaceSearchOptions): Promise<WorkspaceSearchOutcome> {
  const { query } = options
  const contextLines = normalizeContextLines(query.contextLines)
  const maxMatches = normalizeMaxMatches(query.maxMatches)
  const args = [
    '--json',
    '--color',
    'never',
    // Windows output would otherwise carry backslashes, which no other tool
    // in the loop accepts as a path.
    '--path-separator',
    '/',
    '--max-filesize',
    String(MAX_SCANNED_FILE_BYTES),
    ...(contextLines > 0 ? ['--context', String(contextLines)] : []),
    ...(query.glob ? ['--glob', query.glob] : []),
    '-e',
    query.pattern,
    '--',
    query.path && query.path.length > 0 ? query.path : '.',
  ]

  return await new Promise<WorkspaceSearchOutcome>((resolveOutcome, rejectOutcome) => {
    const child = spawn(rgPath, args, { cwd: options.root, windowsHide: true })
    const hits: RipgrepHit[] = []
    let matchCount = 0
    let truncated = false
    let pending = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      // A search that outruns the budget still returns what it found; the
      // truncation notice tells the model to narrow the pattern.
      truncated = true
      child.kill()
    }, SEARCH_TIMEOUT_MS)

    const finish = (outcome: WorkspaceSearchOutcome): void => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      resolveOutcome(outcome)
    }

    const consumeLine = (line: string): void => {
      const hit = parseRipgrepEvent(line)
      if (!hit)
        return
      if (hit.matched) {
        if (matchCount >= maxMatches) {
          truncated = true
          child.kill()
          return
        }
        matchCount++
      }
      hits.push(hit)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines)
        consumeLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        rejectOutcome(error)
      }
    })
    child.on('close', (code) => {
      if (pending.length > 0)
        consumeLine(pending)
      // ripgrep exits 1 when nothing matched and 2 on a real error. A killed
      // process (cap reached, timeout) reports a null code.
      if (code === 2 && hits.length === 0 && !settled) {
        settled = true
        clearTimeout(timer)
        rejectOutcome(new Error(stderr.trim().split('\n')[0] || 'search failed'))
        return
      }
      finish({ hits, truncated })
    })
  })
}

/**
 * Scans the workspace with Node when ripgrep is unavailable.
 *
 * It reads far fewer files than ripgrep (see the exclusion list) and uses
 * JavaScript regular expression syntax, so a pattern that relies on Rust
 * regex features can behave differently. Callers report this path as degraded.
 */
async function searchByWalking(options: WorkspaceSearchOptions): Promise<WorkspaceSearchOutcome> {
  const { query } = options
  const contextLines = normalizeContextLines(query.contextLines)
  const maxMatches = normalizeMaxMatches(query.maxMatches)
  const root = resolve(options.root)
  const searchRoot = query.path && query.path.length > 0 ? resolve(root, query.path) : root
  const globMatcher = query.glob ? globToRegExp(query.glob) : undefined

  let pattern: RegExp
  try {
    pattern = new RegExp(query.pattern)
  }
  catch (error) {
    throw new TypeError(`Invalid search pattern: ${errorMessageFrom(error) ?? 'unparsable'}`)
  }

  const hits: RipgrepHit[] = []
  let matchCount = 0
  let truncated = false

  const scanFile = async (absolutePath: string): Promise<void> => {
    const relativePath = toPosixPath(relative(root, absolutePath))
    if (globMatcher && !globMatcher.test(relativePath))
      return

    const stats = await stat(absolutePath)
    if (!stats.isFile() || stats.size > MAX_SCANNED_FILE_BYTES)
      return

    const content = await readFile(absolutePath, 'utf8')
    if (content.includes('\u0000'))
      return

    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      if (!pattern.test(lines[index]))
        continue
      if (matchCount >= maxMatches) {
        truncated = true
        return
      }
      matchCount++
      const from = Math.max(0, index - contextLines)
      const to = Math.min(lines.length - 1, index + contextLines)
      for (let cursor = from; cursor <= to; cursor++) {
        hits.push({
          path: relativePath,
          lineNumber: cursor + 1,
          text: lines[cursor],
          matched: cursor === index,
        })
      }
    }
  }

  const walk = async (directory: string): Promise<void> => {
    if (truncated)
      return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (truncated)
        return
      if (entry.isDirectory()) {
        if (FALLBACK_EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.'))
          continue
        await walk(join(directory, entry.name))
        continue
      }
      if (entry.isFile())
        await scanFile(join(directory, entry.name))
    }
  }

  const searchStats = await stat(searchRoot)
  if (searchStats.isFile())
    await scanFile(searchRoot)
  else
    await walk(searchRoot)

  return { hits, truncated }
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

/**
 * Translates a shell-style glob into a path matcher.
 *
 * Only the forms the tool documents are supported: `**` crosses directories,
 * `*` and `?` stay inside one segment. A bare pattern such as `*.ts` matches
 * at any depth, which is what callers of a search tool expect.
 */
function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/') ? glob : `**/${glob}`
  let source = ''
  for (let index = 0; index < anchored.length; index++) {
    const char = anchored[index]
    if (char === '*') {
      if (anchored[index + 1] === '*') {
        index++
        if (anchored[index + 1] === '/')
          index++
        source += '(?:.*/)?'
        continue
      }
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}
