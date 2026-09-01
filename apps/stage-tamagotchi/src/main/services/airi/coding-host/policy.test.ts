import type { CodingHostDeps } from './policy'

import { describe, expect, it, vi } from 'vitest'

import { runBashCommand } from './policy'

function fakeJobs() {
  return {
    start: vi.fn((command: string) => ({
      jobId: 'job-1',
      command,
      status: 'running' as const,
      output: '',
      truncated: false,
      startedAt: 0,
    })),
    read: vi.fn(() => undefined),
    kill: vi.fn(() => 'unknown' as const),
    list: vi.fn(() => []),
    disposeAll: vi.fn(),
  }
}

function fakeHost(exitCode = 0, stdout = 'out', stderr = '') {
  return {
    runCommand: vi.fn(async () => ({ stdout, stderr, exitCode, shell: 'git-bash' as const })),
    jobs: fakeJobs(),
  }
}

function depsWith(overrides: Partial<CodingHostDeps> = {}): CodingHostDeps {
  return {
    host: fakeHost(),
    approve: vi.fn(async () => true),
    mediumApprovalRequired: false,
    ...overrides,
  }
}

describe('coding host bash policy', () => {
  it('executes read-only commands without approval', async () => {
    const deps = depsWith()
    const result = await runBashCommand('git status', deps)
    expect(deps.approve).not.toHaveBeenCalled()
    expect(result.status).toBe('ok')
    expect(result.tier).toBe('read-only')
    // Command results name their interpreter so a failure can be traced to the
    // shell that produced it (HARNESS-PLAN §3.5.3 C5).
    expect(result.shell).toBe('git-bash')
    expect(deps.host.runCommand).toHaveBeenCalledWith('git status')
  })

  it('asks approval for high-tier commands and executes only when granted', async () => {
    const deps = depsWith({ approve: vi.fn(async (tier) => {
      expect(tier).toBe('high')
      return true
    }) })
    const result = await runBashCommand('git push origin main', deps)
    expect(result.status).toBe('ok')
    expect(result.tier).toBe('high')
  })

  it('returns a correlated denied result when approval is refused', async () => {
    const deps = depsWith({ approve: vi.fn(async () => false) })
    const result = await runBashCommand('rm -rf dist', deps)
    expect(result).toMatchObject({
      tier: 'high',
      status: 'denied',
      reason: 'approval_required',
    })
    expect(deps.host.runCommand).not.toHaveBeenCalled()
  })

  it('upgrades medium-tier to approval-required only when configured', async () => {
    const strict = depsWith({ mediumApprovalRequired: true, approve: vi.fn(async () => false) })
    const denied = await runBashCommand('npm install', strict)
    expect(denied.status).toBe('denied')

    const lax = depsWith({ approve: vi.fn(async () => true) })
    const executed = await runBashCommand('npm install', lax)
    expect(executed.status).toBe('ok')
    expect(lax.approve).not.toHaveBeenCalled()
  })

  it('starts a background job only after the approval gate allows it', async () => {
    const denied = depsWith({ runInBackground: true, approve: vi.fn(async () => false) })
    const rejected = await runBashCommand('rm -rf dist', denied)

    expect(rejected.status).toBe('denied')
    expect(denied.host.jobs.start).not.toHaveBeenCalled()

    const allowed = depsWith({ runInBackground: true })
    const started = await runBashCommand('pnpm dev', allowed)

    expect(started).toMatchObject({ status: 'started', jobId: 'job-1' })
    expect(allowed.host.jobs.start).toHaveBeenCalledWith('pnpm dev')
    // A background start must not also run the command in the foreground.
    expect(allowed.host.runCommand).not.toHaveBeenCalled()
  })

  it('reports nonzero exits as error and bounds stdout/stderr', async () => {
    const deps = depsWith({ host: fakeHost(2, 'x'.repeat(9_000), 'y'.repeat(3_000)) })
    const result = await runBashCommand('ls', deps)
    expect(result.status).toBe('error')
    expect(result.exitCode).toBe(2)
    expect(result.stdout.length).toBeLessThanOrEqual(8_000)
    expect(result.stderr.length).toBeLessThanOrEqual(2_000)
  })
})
