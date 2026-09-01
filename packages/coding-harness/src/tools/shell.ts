/**
 * Workspace shell selection (HARNESS-PLAN §3.5.3 C5).
 *
 * `bash` is the model-facing name of the command tool, not a promise about the
 * interpreter. The host previously ran `execFile(command, { shell: true })`,
 * which resolves ComSpec on Windows, so every POSIX-shaped command the model
 * wrote (`grep -rn`, `ls`, `cat`) failed with "not recognized as an internal
 * or external command" and nothing in the tool surface explained why.
 *
 * The preference order is a security decision, not a convenience one. The
 * static risk table in `classifyBashCommand` reads POSIX command shapes, so a
 * POSIX shell keeps the whole table effective. PowerShell needs a parallel
 * cmdlet and alias table, and one missing entry silently downgrades a
 * destructive command to the read-only tier, so it is the fallback for
 * machines without Git for Windows.
 *
 * The selected shell is a model-visible fact: `bashDescriptionFor` states it in
 * the tool description and every command result repeats its kind, because a
 * model that cannot tell which syntax it speaks retries the same failing line.
 */

/** Interpreter that runs `bash` tool commands. */
export type WorkspaceShellKind = 'git-bash' | 'powershell' | 'posix-sh'

/** Command syntax family the model must write for one shell kind. */
export type WorkspaceShellSyntax = 'posix' | 'powershell'

/**
 * One resolved command interpreter.
 *
 * The host spawns `executable` directly with `commandArgs` plus the command
 * string. It never nests another shell, so quoting rules stay the ones of the
 * shell named here.
 */
export interface WorkspaceShell {
  kind: WorkspaceShellKind
  syntax: WorkspaceShellSyntax
  /** Short name shown to the user and to the model, such as "Git Bash". */
  label: string
  /** Executable path, or a bare name resolved through PATH as a last resort. */
  executable: string
  /** Arguments placed before the command string. */
  commandArgs: readonly string[]
  /**
   * Environment entries merged into the child process.
   *
   * Git Bash needs `CHERE_INVOKING=1`: its login profile moves the working
   * directory to `$HOME` when that variable is absent, which would run every
   * workspace command in the wrong directory while still reporting success.
   */
  env?: Readonly<Record<string, string>>
}

/** Filesystem facts a selection decision needs, already gathered. */
export interface WorkspaceShellProbe {
  /** `process.platform` of the machine that runs the commands. */
  platform: string
  /** Existing bash executables, most preferred first. */
  bashPaths?: readonly string[]
  /** Existing PowerShell executable, when the probe found one. */
  powershellPath?: string
}

/**
 * The interpreter POSIX platforms already used through `shell: true`.
 *
 * `-c` keeps the previous behavior exactly: no profile is read, so a command
 * behaves the same before and after shells became explicit.
 */
export const POSIX_SHELL: WorkspaceShell = Object.freeze({
  kind: 'posix-sh',
  syntax: 'posix',
  label: 'POSIX sh',
  executable: '/bin/sh',
  commandArgs: Object.freeze(['-c']),
})

/** Executable used when Windows has neither Git Bash nor a located PowerShell. */
export const WINDOWS_POWERSHELL_FALLBACK = 'powershell.exe'

/**
 * Builds the Git Bash descriptor for one bash executable.
 *
 * `-l` is required, not stylistic: a non-login Git Bash inherits the Windows
 * PATH, which holds `Git\cmd` but not `Git\usr\bin`, so `grep`, `ls` and the
 * rest of the POSIX tools would be missing from the shell the model was just
 * told it is using.
 */
export function gitBashShell(executable: string): WorkspaceShell {
  return {
    kind: 'git-bash',
    syntax: 'posix',
    label: 'Git Bash',
    executable,
    commandArgs: ['-lc'],
    env: { CHERE_INVOKING: '1' },
  }
}

/** Builds the PowerShell descriptor for one PowerShell executable. */
export function powershellShell(executable: string): WorkspaceShell {
  return {
    kind: 'powershell',
    syntax: 'powershell',
    label: 'Windows PowerShell',
    executable,
    commandArgs: ['-NoProfile', '-NonInteractive', '-Command'],
  }
}

/** Picks the interpreter for one machine from already-gathered probe facts. */
export function selectWorkspaceShell(probe: WorkspaceShellProbe): WorkspaceShell {
  if (probe.platform !== 'win32')
    return POSIX_SHELL

  const bashPath = probe.bashPaths?.find(candidate => candidate.length > 0)
  if (bashPath)
    return gitBashShell(bashPath)

  return powershellShell(probe.powershellPath ?? WINDOWS_POWERSHELL_FALLBACK)
}
