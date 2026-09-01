/**
 * Node probing for the workspace shell (HARNESS-PLAN §3.5.3 C5).
 *
 * Kept apart from `shell.ts` so the selection policy and the descriptors stay
 * importable from browser bundles: only this module touches the filesystem and
 * spawns `git`. The probe runs once per workspace host; command execution must
 * never re-probe, because a per-command `git --exec-path` spawn would cost more
 * than most commands the model runs.
 */
import type { WorkspaceShell } from './shell'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

import { selectWorkspaceShell } from './shell'

export interface WorkspaceShellProbeOptions {
  /** Defaults to `process.platform`. */
  platform?: string
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Filesystem boundary; defaults to `existsSync`. */
  fileExists?: (path: string) => boolean
  /**
   * Resolves `git --exec-path`, or undefined when git is missing.
   * Injected so the probe stays testable without a git installation.
   */
  resolveGitExecPath?: () => string | undefined
}

/**
 * Bash locations inside a Git for Windows installation.
 *
 * `bin/bash.exe` is the wrapper the Git Bash shortcut runs; `usr/bin/bash.exe`
 * is the MSYS binary behind it. Both accept `-lc`.
 */
const GIT_BASH_RELATIVE_SEGMENTS: readonly (readonly string[])[] = Object.freeze([
  ['bin', 'bash.exe'],
  ['usr', 'bin', 'bash.exe'],
])

/**
 * How far to walk up from `git --exec-path` while looking for the install root.
 *
 * The exec path is normally `<root>/mingw64/libexec/git-core`, three levels
 * below the root; the extra levels absorb portable and scoop-style layouts.
 */
const MAX_GIT_ROOT_WALK_UP = 5

const WINDOWS_POWERSHELL_SEGMENTS: readonly string[] = Object.freeze(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'])

/** Reads `git --exec-path` with a bounded spawn, or undefined when git is absent. */
function readGitExecPath(): string | undefined {
  try {
    const output = execFileSync('git', ['--exec-path'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const execPath = output.trim()
    return execPath.length > 0 ? execPath : undefined
  }
  catch {
    // A missing git, a sandbox that denies spawning, or a slow disk all mean
    // the same thing here: this candidate source produced nothing.
    return undefined
  }
}

/** Candidate Git for Windows install roots derived from the environment. */
function gitInstallRootsFrom(env: Record<string, string | undefined>): string[] {
  const programRoots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined,
  ]
  return programRoots
    .filter((root): root is string => !!root && root.length > 0)
    .map(root => join(root, 'Git'))
}

/** Install roots implied by `git --exec-path`, nearest ancestor first. */
function gitRootsFromExecPath(execPath: string | undefined): string[] {
  if (!execPath)
    return []

  const roots: string[] = []
  let current = execPath
  for (let level = 0; level < MAX_GIT_ROOT_WALK_UP; level++) {
    const parent = dirname(current)
    if (parent === current)
      break
    roots.push(parent)
    current = parent
  }
  return roots
}

/** Executables named `name` found on PATH, in PATH order. */
function pathCandidates(env: Record<string, string | undefined>, name: string): string[] {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? ''
  return rawPath
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => join(entry, name))
}

/**
 * Resolves the interpreter for the current machine.
 *
 * Probe order on Windows: the Git installation that owns `git --exec-path`,
 * then the well-known program directories, then `bash.exe` on PATH, then
 * PowerShell. Every candidate must exist on disk before it is offered to
 * {@link selectWorkspaceShell}, so the returned shell is always spawnable.
 */
export function probeWorkspaceShell(options: WorkspaceShellProbeOptions = {}): WorkspaceShell {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const fileExists = options.fileExists ?? existsSync

  if (platform !== 'win32')
    return selectWorkspaceShell({ platform })

  const resolveGitExecPath = options.resolveGitExecPath ?? readGitExecPath
  const installRoots = [...gitRootsFromExecPath(resolveGitExecPath()), ...gitInstallRootsFrom(env)]
  const bashCandidates = [
    ...installRoots.flatMap(root => GIT_BASH_RELATIVE_SEGMENTS.map(segments => join(root, ...segments))),
    ...pathCandidates(env, 'bash.exe'),
  ]

  const systemRoot = env.SystemRoot ?? env.windir
  const powershellCandidates = [
    ...(systemRoot ? [join(systemRoot, ...WINDOWS_POWERSHELL_SEGMENTS)] : []),
    ...pathCandidates(env, 'pwsh.exe'),
    ...pathCandidates(env, 'powershell.exe'),
  ]

  const bashPaths = dedupe(bashCandidates).filter(candidate => fileExists(candidate))
  const powershellPath = dedupe(powershellCandidates).find(candidate => fileExists(candidate))

  return selectWorkspaceShell({
    platform,
    bashPaths,
    ...(powershellPath ? { powershellPath } : {}),
  })
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}
