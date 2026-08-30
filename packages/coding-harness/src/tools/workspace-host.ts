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
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface WorkspaceReadResult {
  content: string
  mtime?: string
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface WorkspaceHost {
  readFile: (path: string) => Promise<WorkspaceReadResult>
  writeFile: (path: string, content: string) => Promise<void>
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

export function createNodeWorkspaceHost(root: string): WorkspaceHost {
  const canonicalRoot = realpathSync(root)

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
    runCommand(command) {
      // NOTICE:
      // `execFile` with the platform shell keeps metro-like quoting rules
      // consistent (Windows: cmd via shell:true) while still returning
      // stdout/stderr/exitCode. Command capabilities are gated upstream by
      // classifyBashCommand + the approval callback, never here.
      return new Promise<CommandResult>((resolveResult) => {
        execFile(
          command,
          { shell: true, cwd: canonicalRoot, windowsHide: true, timeout: 120_000 },
          (error, stdout, stderr) => {
            const exitCode = typeof error === 'object' && error !== null && 'code' in error
              ? Number(error.code ?? 1)
              : error
                ? 1
                : 0
            resolveResult({ stdout, stderr: String(stderr), exitCode: Number.isFinite(exitCode) ? exitCode : 1 })
          },
        )
      })
    },
  }
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
