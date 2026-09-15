import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'

import { contentHashOf } from '@proj-airi/skill-forge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PackageDigestMismatchError, PackageEntrypointForbiddenError } from './descriptor'
import {
  PackageDependencyMismatchError,
  PackageNotApprovedError,
  PackageRollbackUnavailableError,
  PackagesFileInvalidError,
  PackageStore,
} from './store'
import { PackageTrialWorkerError } from './trial-worker/client'

interface FixtureOptions {
  id?: string
  version?: string
  toolId?: string
  source?: string
  entrypoint?: string
  data?: string
}

async function createFixture(root: string, options: FixtureOptions = {}) {
  const id = options.id ?? 'demo-pack'
  const version = options.version ?? '1.0.0'
  const toolId = options.toolId ?? 'demo-skill'
  const source = options.source ?? 'export function run() { return 1 }\n'
  const contentHash = contentHashOf(source)

  await mkdir(join(root, 'skills', toolId), { recursive: true })
  await writeFile(join(root, 'skills', toolId, 'source.mjs'), source)
  await writeFile(join(root, 'extension.airi.json'), JSON.stringify({
    apiVersion: 'v1',
    id,
    kind: 'manifest.extension.airi.moeru.ai',
    permissions: {},
    entrypoints: options.entrypoint ? { electron: options.entrypoint } : {},
  }))
  await writeFile(join(root, 'airi-package.json'), JSON.stringify({
    packageVersion: 1,
    id,
    version,
    tools: [{
      name: 'demo_tool',
      description: 'Demo tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      skill: { toolId, contentHash },
    }],
    dependencies: { skills: [{ toolId, contentHash }] },
  }))
  if (options.data !== undefined) {
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(join(root, 'data', 'state.json'), options.data)
  }
  return { id, version, toolId, source, contentHash }
}

async function zipDirectory(root: string, target: string): Promise<void> {
  const zip = new JSZip()
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(root, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(relativePath)
        continue
      }
      zip.file(relativePath, await readFile(join(root, relativePath)))
    }
  }
  await walk('')
  await writeFile(target, await zip.generateAsync({ type: 'uint8array' }))
}

describe('ep-2a package store lifecycle', () => {
  let workDir: string
  let extensionsDir: string
  let store: PackageStore
  let fixtureSeq = 0

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'airi-package-store-'))
    extensionsDir = join(workDir, 'extensions')
    store = new PackageStore({ extensionsDir, now: () => 1_700_000_000_000 })
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  async function fixture(options: FixtureOptions = {}) {
    const directory = join(workDir, `fixture-${++fixtureSeq}`)
    const meta = await createFixture(directory, options)
    return { directory, ...meta }
  }

  async function imported(options: FixtureOptions = {}) {
    const created = await fixture(options)
    await store.importFromDirectory({ sourceDir: created.directory })
    return created
  }

  function expected(created: { toolId: string, contentHash: string }) {
    return [{ toolId: created.toolId, contentHash: created.contentHash }]
  }

  it('runs trial, approve, and activate and reports the active version', async () => {
    const created = await imported()
    const trial = await store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    expect(trial.skillChecks).toEqual([{ toolId: created.toolId, contentHash: created.contentHash, reason: 'ok' }])

    const lock = JSON.parse(await readFile(join(extensionsDir, 'packages', '.staging', created.id, created.version, 'airi-package.lock.json'), 'utf8'))
    expect(lock.digest).toBe(trial.digest)
    expect(lock.algorithm).toBe('sha256-of-sorted-file-digests-v1')

    const approval = await store.approve({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    expect(approval.digest).toBe(trial.digest)
    expect(approval.approvedBy).toBe('user')

    const activation = await store.activate({ packageId: created.id, version: created.version })
    expect(activation).toMatchObject({ version: created.version, digest: trial.digest, enabled: true })

    const listed = await store.list()
    expect(listed).toEqual([{
      packageId: created.id,
      versions: [{
        version: created.version,
        digest: trial.digest,
        staged: false,
        installed: true,
        approved: true,
        active: true,
        enabled: true,
      }],
    }])
  })

  it('rejects manifests with runtime entrypoints at trial', async () => {
    const created = await imported({ entrypoint: './main.mjs' })
    await expect(store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) }))
      .rejects
      .toBeInstanceOf(PackageEntrypointForbiddenError)
  })

  it('rejects a skill whose bytes no longer match the reviewed binding', async () => {
    const created = await imported()
    await writeFile(join(extensionsDir, 'packages', '.staging', created.id, created.version, 'skills', created.toolId, 'source.mjs'), 'export function run() { return 2 }\n')
    const failure = await store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) }).catch(error => error)
    expect(failure).toBeInstanceOf(PackageDependencyMismatchError)
    expect((failure as PackageDependencyMismatchError).reason).toBe('hash_mismatch')
  })

  it('rejects a skill hash that no reviewed skill currently lists', async () => {
    const created = await imported()
    const failure = await store.trial({
      packageId: created.id,
      version: created.version,
      expectedSkills: [{ toolId: created.toolId, contentHash: 'f'.repeat(64) }],
    }).catch(error => error)
    expect(failure).toBeInstanceOf(PackageDependencyMismatchError)
    expect((failure as PackageDependencyMismatchError).reason).toBe('review_hash_mismatch')
  })

  it('keeps the working version when approved bytes were replaced', async () => {
    const v1 = await imported()
    await store.trial({ packageId: v1.id, version: v1.version, expectedSkills: expected(v1) })
    await store.approve({ packageId: v1.id, version: v1.version, expectedSkills: expected(v1) })
    await store.activate({ packageId: v1.id, version: v1.version })

    const v2 = await imported({ version: '1.1.0', toolId: 'demo-skill-v2' })
    await store.trial({ packageId: v2.id, version: v2.version, expectedSkills: expected(v2) })
    await store.approve({ packageId: v2.id, version: v2.version, expectedSkills: expected(v2) })
    await writeFile(join(extensionsDir, 'packages', '.staging', v2.id, v2.version, 'skills', v2.toolId, 'source.mjs'), 'export function run() { return 3 }\n')

    await expect(store.activate({ packageId: v2.id, version: v2.version })).rejects.toBeInstanceOf(PackageDigestMismatchError)
    const [entry] = await store.list()
    expect(entry?.versions.find(status => status.version === '1.0.0')?.enabled).toBe(true)
    expect(entry?.versions.find(status => status.version === '1.1.0')?.active).toBe(false)
  })

  it('switches to a newer approved version and rolls back without overlap', async () => {
    const v1 = await imported()
    await store.trial({ packageId: v1.id, version: v1.version, expectedSkills: expected(v1) })
    await store.approve({ packageId: v1.id, version: v1.version, expectedSkills: expected(v1) })
    await store.activate({ packageId: v1.id, version: v1.version })

    const v2 = await imported({ version: '1.1.0', toolId: 'demo-skill-v2' })
    await store.trial({ packageId: v2.id, version: v2.version, expectedSkills: expected(v2) })
    await store.approve({ packageId: v2.id, version: v2.version, expectedSkills: expected(v2) })
    const upgraded = await store.activate({ packageId: v2.id, version: v2.version })
    expect(upgraded.version).toBe('1.1.0')

    const rolledBack = await store.rollback({ packageId: v1.id })
    expect(rolledBack.version).toBe('1.0.0')

    const forward = await store.rollback({ packageId: v1.id, toVersion: '1.1.0' })
    expect(forward.version).toBe('1.1.0')

    // A tampered earlier version must not be selectable; the current version stays.
    await writeFile(join(extensionsDir, 'packages', v1.id, '1.0.0', 'skills', v1.toolId, 'source.mjs'), 'export function run() { return 0 }\n')
    await expect(store.rollback({ packageId: v1.id, toVersion: '1.0.0' }))
      .rejects
      .toBeInstanceOf(PackageRollbackUnavailableError)
    const [entry] = await store.list()
    expect(entry?.versions.find(status => status.active)?.version).toBe('1.1.0')
  })

  it('rejects activation without approval and rollback without an earlier version', async () => {
    const v1 = await imported()
    await expect(store.activate({ packageId: v1.id, version: v1.version }))
      .rejects
      .toBeInstanceOf(PackageNotApprovedError)

    await store.trial({ packageId: v1.id, version: v1.version, expectedSkills: expected(v1) })
    await store.approve({ packageId: v1.id, version: v1.version, expectedSkills: expected(v1) })
    await store.activate({ packageId: v1.id, version: v1.version })
    await expect(store.rollback({ packageId: v1.id }))
      .rejects
      .toBeInstanceOf(PackageRollbackUnavailableError)
  })

  it('withdraws activation on uninstall and keeps private data by default', async () => {
    const created = await imported({ data: '{"private":true}' })
    await store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await store.approve({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await store.activate({ packageId: created.id, version: created.version })

    await store.uninstall({ packageId: created.id, version: created.version })
    const remaining = await readdir(join(extensionsDir, 'packages', created.id, created.version))
    expect(remaining).toEqual(['data'])
    expect(await readFile(join(extensionsDir, 'packages', created.id, created.version, 'data', 'state.json'), 'utf8')).toBe('{"private":true}')
    expect(await store.list()).toEqual([{ packageId: created.id, versions: [] }])

    const purged = await imported({ id: 'other-pack', data: '{"private":true}' })
    await store.trial({ packageId: purged.id, version: purged.version, expectedSkills: expected(purged) })
    await store.approve({ packageId: purged.id, version: purged.version, expectedSkills: expected(purged) })
    await store.activate({ packageId: purged.id, version: purged.version })
    await store.uninstall({ packageId: purged.id, version: purged.version, purgeData: true })
    await expect(stat(join(extensionsDir, 'packages', purged.id, purged.version))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('records approvals from concurrent calls without losing either record', async () => {
    const first = await imported()
    const second = await imported({ id: 'second-pack', toolId: 'second-skill' })
    await store.trial({ packageId: first.id, version: first.version, expectedSkills: expected(first) })
    await store.trial({ packageId: second.id, version: second.version, expectedSkills: expected(second) })

    await Promise.all([
      store.approve({ packageId: first.id, version: first.version, expectedSkills: expected(first) }),
      store.approve({ packageId: second.id, version: second.version, expectedSkills: expected(second) }),
    ])

    const file = JSON.parse(await readFile(join(extensionsDir, 'packages.json'), 'utf8'))
    expect(file.approvals.map((approval: { packageId: string }) => approval.packageId).sort())
      .toEqual(['demo-pack', 'second-pack'])
  })

  it('imports a ZIP archive and trials it like a directory package', async () => {
    const created = await fixture()
    const archivePath = join(workDir, 'demo-pack.zip')
    await zipDirectory(created.directory, archivePath)

    const importedPackage = await store.importFromArchive({ archivePath })
    expect(importedPackage.packageId).toBe(created.id)
    const trial = await store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    expect(trial.skillChecks[0]?.reason).toBe('ok')
  })

  it('never silently resets a corrupt packages.json', async () => {
    await mkdir(extensionsDir, { recursive: true })
    await writeFile(join(extensionsDir, 'packages.json'), '{ not json')
    await expect(store.list()).rejects.toBeInstanceOf(PackagesFileInvalidError)
  })

  it('cancels an in-flight trial so uninstall is not blocked (ep-2b)', async () => {
    const created = await imported()
    let rejectTrial: (error: Error) => void = () => {}
    const hangingStore = new PackageStore({
      extensionsDir,
      trialRunner: {
        run: () => new Promise((_resolve, reject) => {
          rejectTrial = reject
        }),
        dispose: async () => {
          rejectTrial(new PackageTrialWorkerError('cancelled', 'cancelled'))
          return true
        },
      },
    })

    const trial = hangingStore.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(await hangingStore.cancelTrial()).toBe(true)
    await expect(trial).rejects.toMatchObject({ name: 'PackageTrialWorkerError', reason: 'cancelled' })

    // Uninstall proceeds normally after the cancellation.
    await expect(hangingStore.uninstall({ packageId: created.id, version: created.version })).resolves.toBeUndefined()
  })

  it('lists only enabled active packages whose bytes still match their approval', async () => {
    const created = await imported()
    await store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await store.approve({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await store.activate({ packageId: created.id, version: created.version })

    const active = await store.activePackages()
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ packageId: created.id, version: created.version })
    expect(active[0]?.descriptor.tools[0]?.name).toBe('demo_tool')

    await store.deactivate({ packageId: created.id })
    expect(await store.activePackages()).toHaveLength(0)

    await store.activate({ packageId: created.id, version: created.version })
    await writeFile(join(extensionsDir, 'packages', created.id, created.version, 'skills', created.toolId, 'source.mjs'), 'export function run() { return 9 }\n')
    expect(await store.activePackages()).toHaveLength(0)
  })

  it('exports only approved and verifiable versions with the registry', async () => {
    const approved = await imported({ data: '{"private":true}' })
    await store.trial({ packageId: approved.id, version: approved.version, expectedSkills: expected(approved) })
    await store.approve({ packageId: approved.id, version: approved.version, expectedSkills: expected(approved) })
    await store.activate({ packageId: approved.id, version: approved.version })
    const staged = await imported({ id: 'staged-pack', toolId: 'staged-skill' })

    const exported = await store.exportApprovedFiles()
    const paths = exported.map(entry => entry.path).sort()
    expect(paths).toContain('packages/registry.json')
    expect(paths).toContain(`packages/versions/${approved.id}/${approved.version}/airi-package.json`)
    expect(paths).toContain(`packages/versions/${approved.id}/${approved.version}/skills/${approved.toolId}/source.mjs`)
    expect(paths).toContain(`packages/versions/${approved.id}/${approved.version}/data/state.json`)
    expect(paths.some(path => path.includes(staged.id))).toBe(false)

    // A tampered approved version stays out of the backup: restore must never
    // re-import bytes an approval no longer covers.
    await writeFile(join(extensionsDir, 'packages', approved.id, approved.version, 'skills', approved.toolId, 'source.mjs'), 'export function run() { return 9 }\n')
    const afterTamper = await store.exportApprovedFiles()
    expect(afterTamper.some(entry => entry.path.includes(`${approved.id}/${approved.version}/airi-package.json`))).toBe(false)
  })

  it('normalizes a restored registry to disabled and demotes unverifiable approvals', async () => {
    const created = await imported({ data: '{"private":true}' })
    await store.trial({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await store.approve({ packageId: created.id, version: created.version, expectedSkills: expected(created) })
    await store.activate({ packageId: created.id, version: created.version })

    const normalized = await store.prepareRestoredProfile()
    expect(normalized).toEqual({ approvals: 1, demoted: 0, corrupt: false })
    const [entry] = await store.list()
    expect(entry?.versions[0]).toMatchObject({ active: true, enabled: false, approved: true })

    await writeFile(join(extensionsDir, 'packages', created.id, created.version, 'skills', created.toolId, 'source.mjs'), 'export function run() { return 9 }\n')
    const demoted = await store.prepareRestoredProfile()
    expect(demoted).toEqual({ approvals: 0, demoted: 1, corrupt: false })
    const [afterDemotion] = await store.list()
    expect(afterDemotion?.versions[0]).toMatchObject({ enabled: false, approved: false })
  })

  it('preserves a corrupt restored registry and starts from an empty one', async () => {
    await mkdir(extensionsDir, { recursive: true })
    await writeFile(join(extensionsDir, 'packages.json'), '{ not json')

    const result = await store.prepareRestoredProfile()
    expect(result).toMatchObject({ approvals: 0, demoted: 0, corrupt: true })
    const renamed = (await readdir(extensionsDir)).find(name => name.startsWith('packages.json.corrupt-'))
    expect(renamed).toBeDefined()
    expect(JSON.parse(await readFile(join(extensionsDir, 'packages.json'), 'utf8'))).toEqual({ packageVersion: 1, approvals: [], active: {} })
  })
})
