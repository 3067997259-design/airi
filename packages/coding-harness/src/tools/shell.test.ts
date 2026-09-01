import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { POSIX_SHELL, selectWorkspaceShell } from './shell'
import { probeWorkspaceShell } from './shell-probe'

const GIT_ROOT = join('C:', 'Program Files', 'Git')
const GIT_EXEC_PATH = join(GIT_ROOT, 'mingw64', 'libexec', 'git-core')
const GIT_BIN_BASH = join(GIT_ROOT, 'bin', 'bash.exe')
const SYSTEM_POWERSHELL = join('C:', 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function existsOnly(...paths: string[]): (path: string) => boolean {
  const known = new Set(paths)
  return path => known.has(path)
}

describe('selectWorkspaceShell', () => {
  it('keeps POSIX platforms on the shell they already used', () => {
    expect(selectWorkspaceShell({ platform: 'linux' })).toEqual(POSIX_SHELL)
    expect(selectWorkspaceShell({ platform: 'darwin' })).toEqual(POSIX_SHELL)
  })

  it('prefers the first existing bash on Windows', () => {
    const shell = selectWorkspaceShell({
      platform: 'win32',
      bashPaths: [GIT_BIN_BASH, join('D:', 'other', 'bash.exe')],
      powershellPath: SYSTEM_POWERSHELL,
    })

    expect(shell.kind).toBe('git-bash')
    expect(shell.executable).toBe(GIT_BIN_BASH)
    expect(shell.commandArgs).toEqual(['-lc'])
    // A login shell without CHERE_INVOKING would run the command in $HOME.
    expect(shell.env).toEqual({ CHERE_INVOKING: '1' })
  })

  it('falls back to PowerShell when Windows has no bash', () => {
    const shell = selectWorkspaceShell({ platform: 'win32', powershellPath: SYSTEM_POWERSHELL })

    expect(shell.kind).toBe('powershell')
    expect(shell.syntax).toBe('powershell')
    expect(shell.executable).toBe(SYSTEM_POWERSHELL)
    expect(shell.commandArgs).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
  })

  it('still names an executable when no PowerShell was located', () => {
    expect(selectWorkspaceShell({ platform: 'win32' }).executable).toBe('powershell.exe')
  })
})

describe('probeWorkspaceShell', () => {
  it('derives the Git installation from git --exec-path', () => {
    const shell = probeWorkspaceShell({
      platform: 'win32',
      env: {},
      resolveGitExecPath: () => GIT_EXEC_PATH,
      fileExists: existsOnly(GIT_BIN_BASH),
    })

    expect(shell.kind).toBe('git-bash')
    expect(shell.executable).toBe(GIT_BIN_BASH)
  })

  it('finds Git for Windows through the program directories without git on PATH', () => {
    const shell = probeWorkspaceShell({
      platform: 'win32',
      env: { ProgramFiles: join('C:', 'Program Files') },
      resolveGitExecPath: () => undefined,
      fileExists: existsOnly(join(GIT_ROOT, 'usr', 'bin', 'bash.exe')),
    })

    expect(shell.executable).toBe(join(GIT_ROOT, 'usr', 'bin', 'bash.exe'))
  })

  it('accepts a bash found on PATH', () => {
    const portableBash = join('D:', 'tools', 'bash.exe')
    const shell = probeWorkspaceShell({
      platform: 'win32',
      env: { PATH: join('D:', 'tools') },
      resolveGitExecPath: () => undefined,
      fileExists: existsOnly(portableBash),
    })

    expect(shell.executable).toBe(portableBash)
  })

  it('falls back to the located PowerShell on a machine without Git', () => {
    const shell = probeWorkspaceShell({
      platform: 'win32',
      env: { SystemRoot: join('C:', 'Windows') },
      resolveGitExecPath: () => undefined,
      fileExists: existsOnly(SYSTEM_POWERSHELL),
    })

    expect(shell.kind).toBe('powershell')
    expect(shell.executable).toBe(SYSTEM_POWERSHELL)
  })

  it('never probes the filesystem on POSIX platforms', () => {
    let probed = 0
    const shell = probeWorkspaceShell({
      platform: 'linux',
      env: {},
      fileExists: () => {
        probed++
        return true
      },
    })

    expect(shell).toEqual(POSIX_SHELL)
    expect(probed).toBe(0)
  })
})
