/**
 * Node workspace host (CODING-HARNESS-DESIGN §2.3 tools).
 *
 * The headless host for `read` / `write` / `edit` / `bash`: real filesystem
 * and command execution backed by node primitives, with path containment so
 * tools can never escape the workspace root.
 *
 * NOTICE:
 * Path containment here is defense-in-depth for tool authors and lost-model
 * edge cases. The real enforcement boundary belongs to the OS sandbox /
 * permission model at wiring time (WIRING-BACKLOG); this host must not be
 * assumed safe against a hostile program.
 */
import type { WorkspaceGrepMatch, WorkspaceGrepQuery, WorkspaceGrepResult } from './grep'
import type { CommandJobs } from './jobs'
import type { WorkspaceShell, WorkspaceShellKind } from './shell'

import process from 'node:process'

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { lineSignature } from '../hashline/signature'
import { contentHash, parseTextFile } from '../hashline/text'
import { truncateGrepContent } from './grep'
import { searchWorkspace } from './grep-search'
import { createCommandJobs } from './jobs'
import { probeWorkspaceShell } from './shell-probe'

export interface WorkspaceReadResult {
  content: string
  mtime?: string
}

/** One shallow entry returned by the workspace directory boundary. */
export interface WorkspaceDirectoryEntry {
  name: string
  kind: 'file' | 'dir'
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  /** Interpreter that ran the command; repeated to the model on every result. */
  shell: WorkspaceShellKind
}

export type WorkspaceWriteResult
  = | { status: 'written', baseHash: string }
    | { status: 'state_changed', currentHash: string | null }

export interface WorkspaceHost {
  /**
   * Interpreter this host runs commands through, resolved once at creation.
   * Callers declare it to the model instead of assuming a POSIX shell.
   */
  readonly shell: WorkspaceShell
  listDir: (path: string) => Promise<WorkspaceDirectoryEntry[]>
  readFile: (path: string) => Promise<WorkspaceReadResult>
  /**
   * Searches file contents and signs every returned line.
   *
   * Signatures use the whole-file line count, exactly like `read`, so a hit is
   * a usable `edit` anchor without reading the file again.
   */
  grep: (query: WorkspaceGrepQuery) => Promise<WorkspaceGrepResult>
  writeFile: (path: string, content: string) => Promise<void>
  writeFileIfUnchanged: (path: string, content: string, baseHash: string | null) => Promise<WorkspaceWriteResult>
  runCommand: (command: string, options?: { signal?: AbortSignal }) => Promise<CommandResult>
  /**
   * Background command jobs.
   *
   * A long-lived command (a server, a watch) never returns, so running it in
   * the foreground burns the whole turn on a timeout. Jobs hand back an id at
   * once and keep bounded output for later reads.
   */
  readonly jobs: CommandJobs
}

/** Resolves a tool-supplied path inside the workspace root or throws. */
export function resolveInsideWorkspace(root: string, path: string): string {
  const normalizedRoot = resolve(root)
  const normalized = isAbsolute(path) ? resolve(path) : resolve(normalizedRoot, path)
  const relativeToRoot = relative(normalizedRoot, normalized)
  if (relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === '..' || isAbsolute(relativeToRoot))
    throw new Error(`Path escapes workspace root: ${path}`)
  return normalized
}

export interface NodeWorkspaceHostOptions {
  /**
   * Overrides shell probing. The host resolves one shell at creation and keeps
   * it: probing per command would spawn `git --exec-path` on every call.
   */
  shell?: WorkspaceShell
  /**
   * Ripgrep executable for `grep`. `null` forces the Node walk, which is how
   * the degraded search path is exercised without removing the binary.
   */
  rgPath?: string | null
}

export function createNodeWorkspaceHost(root: string, options: NodeWorkspaceHostOptions = {}): WorkspaceHost {
  const canonicalRoot = realpathSync(root)
  const shell = options.shell ?? probeWorkspaceShell()
  const jobs = createCommandJobs({ shell, cwd: canonicalRoot })

  const ensureExistingInside = async (path: string): Promise<string> => {
    const lexicalPath = resolveInsideWorkspace(canonicalRoot, path)
    return resolveInsideWorkspace(canonicalRoot, await realpath(lexicalPath))
  }

  const ensureWritableInside = async (path: string): Promise<string> => {
    const lexicalPath = resolveInsideWorkspace(canonicalRoot, path)
    try {
      return resolveInsideWorkspace(canonicalRoot, await realpath(lexicalPath))
    }
    catch (error) {
      if (!isNodeErrorWithCode(error, 'ENOENT'))
        throw error

      const canonicalParent = await realpath(dirname(lexicalPath))
      return resolveInsideWorkspace(canonicalRoot, resolve(canonicalParent, basename(lexicalPath)))
    }
  }

  return {
    shell,
    jobs,
    async listDir(path) {
      const resolved = await ensureExistingInside(path)
      const entries = await readdir(resolved, { withFileTypes: true })
      const classified = await Promise.all(entries.map(async (entry): Promise<WorkspaceDirectoryEntry> => {
        // Resolve every child before classification. A directory symlink that
        // leaves the workspace must fail the same containment check as read.
        const canonicalEntry = resolveInsideWorkspace(canonicalRoot, await realpath(resolve(resolved, entry.name)))
        const stats = await stat(canonicalEntry)
        return {
          name: entry.name,
          kind: stats.isDirectory() ? 'dir' : 'file',
        }
      }))
      return classified.sort((left, right) => left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === 'dir' ? -1 : 1)
    },
    async readFile(path) {
      const resolved = await ensureExistingInside(path)
      const [content, stats] = await Promise.all([
        readFile(resolved, 'utf8'),
        stat(resolved),
      ])
      return {
        content,
        ...(stats.mtime ? { mtime: stats.mtime.toISOString() } : {}),
      }
    },
    async grep(query) {
      // Containment belongs here, not in the search process: both search paths
      // receive a scope already proven to sit inside the workspace, so neither
      // a relative escape nor an absolute path can widen the search.
      const scope = query.path && query.path.length > 0
        ? relative(canonicalRoot, resolveInsideWorkspace(canonicalRoot, query.path)) || '.'
        : '.'
      const outcome = await searchWorkspace({
        root: canonicalRoot,
        query: { ...query, path: scope },
        ...(options.rgPath === undefined ? {} : { rgPath: options.rgPath }),
      })

      // Signing needs the file line count, so each matched file is read once
      // and reused for every hit inside it.
      const lineCounts = new Map<string, number>()
      const unreadablePaths = new Set<string>()
      const matches: WorkspaceGrepMatch[] = []

      for (const hit of outcome.hits) {
        if (unreadablePaths.has(hit.path))
          continue

        let lineCount = lineCounts.get(hit.path)
        if (lineCount === undefined) {
          try {
            const resolved = await ensureExistingInside(hit.path)
            lineCount = parseTextFile(await readFile(resolved, 'utf8')).lines.length
            lineCounts.set(hit.path, lineCount)
          }
          catch {
            unreadablePaths.add(hit.path)
            continue
          }
        }

        const { content, truncated } = truncateGrepContent(hit.text)
        matches.push({
          path: hit.path,
          lineNumber: hit.lineNumber,
          signature: lineSignature(hit.text, { lineCount }),
          content,
          truncated,
          matched: hit.matched,
        })
      }

      return {
        matches,
        matchCount: matches.filter(match => match.matched).length,
        truncated: outcome.truncated,
        ...(outcome.degradedReason ? { degradedReason: outcome.degradedReason } : {}),
        ...(unreadablePaths.size > 0 ? { unreadablePaths: [...unreadablePaths] } : {}),
      }
    },
    async writeFile(path, content) {
      // Create the parent chain first: the realpath canonicalization below
      // cannot resolve paths whose intermediate directories do not exist yet
      // (e.g. skills/<id>/source.mjs on first submission).
      const lexicalPath = resolveInsideWorkspace(canonicalRoot, path)
      await mkdir(dirname(lexicalPath), { recursive: true })
      const resolved = await ensureWritableInside(path)
      await writeFileAsync(resolved, content, 'utf8')
    },
    async writeFileIfUnchanged(path, content, baseHash) {
      const lexicalPath = resolveInsideWorkspace(canonicalRoot, path)
      let currentHash: string | null = null
      try {
        const resolved = await ensureExistingInside(path)
        currentHash = contentHash(await readFile(resolved, 'utf8'))
      }
      catch (error) {
        if (!isNodeErrorWithCode(error, 'ENOENT'))
          throw error
      }

      if (currentHash !== baseHash)
        return { status: 'state_changed', currentHash }

      await mkdir(dirname(lexicalPath), { recursive: true })
      const resolved = await ensureWritableInside(path)
      await writeFileAsync(resolved, content, 'utf8')
      return { status: 'written', baseHash: contentHash(content) }
    },
    runCommand(command, options = {}) {
      // The shell is spawned by path with its own command flag instead of
      // `shell: true`, which resolved ComSpec (cmd.exe) on Windows and broke
      // every POSIX command the model wrote. Capabilities stay gated upstream
      // by classifyBashCommand plus the approval callback, never here.
      return new Promise<CommandResult>((resolveResult) => {
        if (options.signal?.aborted) {
          resolveResult({ stdout: '', stderr: 'Command cancelled before it started.', exitCode: 1, shell: shell.kind })
          return
        }

        const child = execFile(
          shell.executable,
          [...shell.commandArgs, command],
          {
            cwd: canonicalRoot,
            windowsHide: true,
            timeout: 120_000,
            ...(shell.env ? { env: { ...process.env, ...shell.env } } : {}),
          },
          (error, stdout, stderr) => {
            const exitCode = typeof error === 'object' && error !== null && 'code' in error
              ? Number(error.code ?? 1)
              : error
                ? 1
                : 0
            cleanup()
            resolveResult({ stdout, stderr: String(stderr), exitCode: Number.isFinite(exitCode) ? exitCode : 1, shell: shell.kind })
          },
        )

        // A revoked registration kills the process instead of waiting for a
        // long command to finish on its own.
        const onAbort = () => child.kill('SIGKILL')
        function cleanup() {
          options.signal?.removeEventListener('abort', onAbort)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
