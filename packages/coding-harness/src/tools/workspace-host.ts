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
import type { WorkspaceShell, WorkspaceShellKind } from './shell'

import process from 'node:process'

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { contentHash } from '../hashline/text'
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
  writeFile: (path: string, content: string) => Promise<void>
  writeFileIfUnchanged: (path: string, content: string, baseHash: string | null) => Promise<WorkspaceWriteResult>
  runCommand: (command: string) => Promise<CommandResult>
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
}

export function createNodeWorkspaceHost(root: string, options: NodeWorkspaceHostOptions = {}): WorkspaceHost {
  const canonicalRoot = realpathSync(root)
  const shell = options.shell ?? probeWorkspaceShell()

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
    runCommand(command) {
      // The shell is spawned by path with its own command flag instead of
      // `shell: true`, which resolved ComSpec (cmd.exe) on Windows and broke
      // every POSIX command the model wrote. Capabilities stay gated upstream
      // by classifyBashCommand plus the approval callback, never here.
      return new Promise<CommandResult>((resolveResult) => {
        execFile(
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
            resolveResult({ stdout, stderr: String(stderr), exitCode: Number.isFinite(exitCode) ? exitCode : 1, shell: shell.kind })
          },
        )
      })
    },
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
