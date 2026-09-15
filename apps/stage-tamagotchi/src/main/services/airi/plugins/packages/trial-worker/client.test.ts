import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computePackageDigest, digestFromFileDigests } from '../descriptor'
import { PackageTrialWorkerClient, PackageTrialWorkerError } from './client'

async function writeFixture(root: string): Promise<void> {
  await mkdir(join(root, 'skills', 'demo-skill'), { recursive: true })
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, 'extension.airi.json'), JSON.stringify({ apiVersion: 'v1', id: 'demo-pack', kind: 'manifest.extension.airi.moeru.ai', permissions: {}, entrypoints: {} }))
  await writeFile(join(root, 'airi-package.json'), JSON.stringify({
    packageVersion: 1,
    id: 'demo-pack',
    version: '1.0.0',
    tools: [{
      name: 'demo_tool',
      description: 'Demo.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      skill: { toolId: 'demo-skill', contentHash: 'abc123' },
    }],
  }))
  await writeFile(join(root, 'skills', 'demo-skill', 'source.mjs'), 'export function run() { return 1 }\n')
  await writeFile(join(root, 'assets', 'panel.html'), '<html></html>')
  await writeFile(join(root, 'data', 'state.json'), '{"private":true}')
  await writeFile(join(root, 'airi-package.lock.json'), '{"derived":true}')
}

describe('packageTrialWorkerClient', () => {
  let workDir: string
  let packageDir: string
  let client: PackageTrialWorkerClient

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'airi-trial-worker-'))
    packageDir = join(workDir, 'demo-pack')
    await writeFixture(packageDir)
    client = new PackageTrialWorkerClient({ trialTimeoutMs: 10_000, stopGraceMs: 200 })
  })

  afterEach(async () => {
    await client.dispose()
    await rm(workDir, { recursive: true, force: true })
  })

  it('observes exactly the covered files the in-process digest uses (equivalence)', async () => {
    const observation = await client.run({ directory: packageDir })
    const inProcess = await computePackageDigest(packageDir)

    // Same covered set, same hashes, same digest: the worker copy of the rules
    // cannot drift from the main implementation silently.
    expect(observation.files).toEqual(inProcess.files)
    expect(digestFromFileDigests(observation.files)).toBe(inProcess.digest)
    expect(observation.files.map(file => file.path)).not.toContain('data/state.json')
    expect(observation.files.map(file => file.path)).not.toContain('airi-package.lock.json')

    expect(observation.manifestJson).toMatchObject({ id: 'demo-pack' })
    expect(observation.descriptorJson).toMatchObject({ version: '1.0.0' })
    expect(observation.skillSources).toEqual([{ toolId: 'demo-skill', source: 'export function run() { return 1 }\n' }])
  })

  it('contains a forced crash and keeps serving later trials', async () => {
    await expect(client.run({ directory: packageDir, debug: 'crash' }))
      .rejects
      .toMatchObject({ name: 'PackageTrialWorkerError', reason: 'crash' })

    const observation = await client.run({ directory: packageDir })
    expect(observation.descriptorJson).toMatchObject({ id: 'demo-pack' })
  })

  it('kills a hanging trial at the timeout and keeps serving later trials', async () => {
    const startedAt = Date.now()
    const failure = await client.run({ directory: packageDir, debug: 'hang', timeoutMs: 300 }).catch(error => error)
    expect(failure).toBeInstanceOf(PackageTrialWorkerError)
    expect((failure as PackageTrialWorkerError).reason).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(3_000)

    const observation = await client.run({ directory: packageDir })
    expect(observation.files.length).toBeGreaterThan(0)
  })

  it('reports unreadable package content as a worker error', async () => {
    await rm(join(packageDir, 'airi-package.json'))
    await expect(client.run({ directory: packageDir }))
      .rejects
      .toMatchObject({ name: 'PackageTrialWorkerError', reason: 'worker-error' })
  })

  it('cancels a hanging trial within the grace window (ep-2b)', async () => {
    const running = client.run({ directory: packageDir, debug: 'hang', timeoutMs: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 200))

    const startedAt = Date.now()
    expect(await client.dispose()).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await expect(running).rejects.toMatchObject({ name: 'PackageTrialWorkerError', reason: 'cancelled' })
    expect(await client.dispose()).toBe(false)
  })
})
