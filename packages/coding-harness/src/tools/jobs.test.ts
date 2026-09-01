import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createNodeWorkspaceHost } from './workspace-host'

const FIXTURE_ROOT = join(fileURLToPath(new URL('../../', import.meta.url)), '.tmp-jobs')

let rootDir: string

beforeAll(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  rootDir = await mkdtemp(join(FIXTURE_ROOT, 'workspace-'))
})

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true })
})

/** Polls a job until it stops, so a slow machine does not decide the result. */
async function waitForExit(read: () => { status: string } | undefined, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = read()
    if (snapshot && snapshot.status !== 'running')
      return snapshot
    await delay(50)
  }
  throw new Error('The job did not stop within the timeout.')
}

describe('background command jobs', () => {
  it('returns a job id at once and keeps the output for later reads', async () => {
    // ROOT CAUSE:
    //
    // Every command ran in the foreground with a 120s timeout, so starting a
    // server spent the whole turn waiting and then reported a timeout
    // (HARNESS-PLAN §0.2 R5). A job returns immediately instead.
    const host = createNodeWorkspaceHost(rootDir)
    const started = host.jobs.start('node -e "console.log(\'job-output-marker\')"')

    expect(started.status).toBe('running')
    expect(started.jobId).toMatch(/^job-/)

    const finished = await waitForExit(() => host.jobs.read(started.jobId))
    expect(finished.status).toBe('exited')
    expect(host.jobs.read(started.jobId)?.output).toContain('job-output-marker')
    expect(host.jobs.read(started.jobId)?.exitCode).toBe(0)
  })

  it('stops a command that would never exit on its own', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    const started = host.jobs.start('node -e "setInterval(() => {}, 1000)"')

    expect(host.jobs.read(started.jobId)?.status).toBe('running')
    expect(host.jobs.kill(started.jobId)).toBe('killed')

    const stopped = await waitForExit(() => host.jobs.read(started.jobId))
    expect(stopped.status).toBe('killed')
    expect(host.jobs.kill(started.jobId)).toBe('already-finished')
    expect(host.jobs.kill('job-does-not-exist')).toBe('unknown')
  })

  it('bounds the buffer and reports that older output was dropped', async () => {
    const host = createNodeWorkspaceHost(rootDir, { rgPath: null })
    const jobs = host.jobs
    const started = jobs.start('node -e "for (let i = 0; i < 4000; i++) console.log(\'line-\' + i)"')

    await waitForExit(() => jobs.read(started.jobId))

    const snapshot = jobs.read(started.jobId)
    expect(snapshot?.truncated).toBe(true)
    expect(snapshot?.output.length).toBeLessThanOrEqual(20_000)
    // A tail read is also marked truncated, so a partial view never looks whole.
    expect(jobs.read(started.jobId, { tail: 100 })?.output.length).toBe(100)
    expect(jobs.read(started.jobId, { tail: 100 })?.truncated).toBe(true)
  })

  it('reports nothing for an unknown job', () => {
    const host = createNodeWorkspaceHost(rootDir)
    expect(host.jobs.read('job-missing')).toBeUndefined()
  })
})
