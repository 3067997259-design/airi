import type { CodingHostDeps } from './policy'

import { describe, expect, it, vi } from 'vitest'

import { runBashCommand } from './policy'

function fakeHost(exitCode = 0, stdout = 'out', stderr = '') {
  return {
    runCommand: vi.fn(async () => ({ stdout, stderr, exitCode })),
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

  it('reports nonzero exits as error and bounds stdout/stderr', async () => {
    const deps = depsWith({ host: fakeHost(2, 'x'.repeat(9_000), 'y'.repeat(3_000)) })
    const result = await runBashCommand('ls', deps)
    expect(result.status).toBe('error')
    expect(result.exitCode).toBe(2)
    expect(result.stdout.length).toBeLessThanOrEqual(8_000)
    expect(result.stderr.length).toBeLessThanOrEqual(2_000)
  })
})
