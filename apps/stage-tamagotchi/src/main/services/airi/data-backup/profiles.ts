import type { RestoreBootstrap } from '../../../../shared/eventa/data-backup'

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { inspectDataBackup } from '@proj-airi/stage-ui/services/data-backup'
import { checkRestoreData } from '@proj-airi/stage-ui/services/data-restore'
import { Mutex } from 'async-mutex'

import * as v from 'valibot'

import { PackageStore } from '../plugins/packages/store'

const markerSchema = v.object({
  state: v.picklist(['pending', 'importing', 'complete', 'failed']),
  snapshotId: v.string(),
  workspaceRoot: v.string(),
  /** Local user id recorded in the archive; lets an unauthenticated boot name its owner. */
  ownerId: v.optional(v.string()),
  error: v.optional(v.string()),
  effectsHeld: v.optional(v.boolean()),
})

/**
 * Creates a new profile after archive and domain checks. The active profile is
 * never a restore target. A failed preparation keeps its files for inspection.
 */
export async function prepareRestoreProfile(parent: string, data: Uint8Array): Promise<string> {
  const backup = await inspectDataBackup(data)
  const { identity } = checkRestoreData(backup)
  await mkdir(parent, { recursive: true })
  const profile = await mkdtemp(join(parent, 'restore-'))
  const workspaceRoot = join(profile, 'workspace')
  await mkdir(workspaceRoot)
  await mkdir(join(profile, 'journal'))
  await writeFile(join(profile, 'restore.zip'), data, { flag: 'wx' })
  for (const entry of backup.entries) {
    if (entry.domain === 'journal')
      await writeFile(join(profile, entry.path), entry.data, { flag: 'wx' })
    if (entry.domain === 'skills' && entry.path !== 'skills/registry.json') {
      const [, toolId, file] = entry.path.split('/')
      const directory = join(workspaceRoot, 'skills', toolId!)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, file!), entry.data, { flag: 'wx' })
    }
    if (entry.domain === 'packages') {
      // Registry → `<profile>/extensions/packages.json`; version files →
      // `<profile>/extensions/packages/<id>/<version>/...`. The package host
      // reads these on boot, so they must be on disk before the profile is.
      const extensions = join(profile, 'extensions')
      if (entry.path === 'packages/registry.json') {
        await mkdir(extensions, { recursive: true })
        await writeFile(join(extensions, 'packages.json'), entry.data, { flag: 'wx' })
        continue
      }
      if (entry.path.startsWith('packages/versions/')) {
        const target = join(extensions, entry.path.slice('packages/'.length).replace(/^versions\//, 'packages/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, entry.data, { flag: 'wx' })
      }
    }
  }
  // Restored packages stay disabled and unverifiable approvals are demoted
  // before the profile can boot (EP-2a restore semantics).
  if (backup.entries.some(entry => entry.domain === 'packages'))
    await new PackageStore({ extensionsDir: join(profile, 'extensions') }).prepareRestoredProfile()
  await writeFile(join(profile, 'coding-host.json'), JSON.stringify({ workspaceRoot }), { flag: 'wx' })
  // The marker is published last. Incomplete staging never becomes bootable.
  await writeFile(join(profile, 'restore-state.json'), JSON.stringify({
    state: 'pending',
    snapshotId: backup.manifest.snapshotId,
    workspaceRoot,
    ownerId: identity.userId,
  }), { flag: 'wx' })
  return profile
}

/**
 * Owns one profile's restore lifecycle. A claimed restore cannot be replayed
 * after a crash: partial browser writes require a new isolated target.
 * Followers wait for the leader receipt, with a bounded startup deadline.
 */
export async function createProfileRestore(profile: string) {
  const path = join(profile, 'restore-state.json')
  let marker: v.InferOutput<typeof markerSchema> | undefined
  try {
    marker = v.parse(markerSchema, JSON.parse(await readFile(path, 'utf8')))
  }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
      throw error
  }
  const mutex = new Mutex()
  const waiters = new Set<() => void>()
  const failedAtBoot = marker?.state === 'importing' || marker?.state === 'failed'

  async function begin(leader: boolean): Promise<RestoreBootstrap> {
    if (!marker)
      return { restored: false }
    if (failedAtBoot || marker.state === 'failed')
      throw new Error('The isolated restore is incomplete. Create a new restore profile from the original backup.')
    if (marker.state === 'complete')
      return { restored: true, effectsHeld: marker.effectsHeld ?? true, ...(marker.ownerId ? { ownerId: marker.ownerId } : {}) }
    if (!leader) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>
        const done = () => {
          clearTimeout(timer)
          waiters.delete(done)
          resolve()
        }
        timer = setTimeout(() => {
          waiters.delete(done)
          reject(new Error('The restore leader did not finish within two minutes.'))
        }, 120_000)
        waiters.add(done)
      })
      return begin(false)
    }
    return mutex.runExclusive(async () => {
      if (!marker || marker.state !== 'pending')
        throw new Error('A renderer already claimed this restore.')
      const data = new Uint8Array(await readFile(join(profile, 'restore.zip')))
      const inspected = await inspectDataBackup(data)
      checkRestoreData(inspected)
      if (inspected.manifest.snapshotId !== marker.snapshotId)
        throw new Error('The restore archive does not match its profile marker.')
      const claimed = { ...marker, state: 'importing' as const }
      await writeFile(path, JSON.stringify(claimed))
      marker = claimed
      return { restored: true, data, workspaceRoot: marker.workspaceRoot, effectsHeld: true, ...(marker.ownerId ? { ownerId: marker.ownerId } : {}) }
    })
  }

  async function complete(snapshotId: string, error?: string): Promise<void> {
    await mutex.runExclusive(async () => {
      // IPC delivery can lose a response after the receipt is durable. Only
      // the same snapshot and outcome can acknowledge that receipt again.
      const state = error ? 'failed' : 'complete'
      if (marker?.snapshotId === snapshotId && marker.state === state && marker.error === error)
        return
      if (!marker || marker.state !== 'importing' || marker.snapshotId !== snapshotId)
        throw new Error('The restore receipt does not match the active snapshot.')
      const completed = { ...marker, state, error, effectsHeld: true } as const
      // Bootstrap and followers must observe only durable transitions. A
      // failed write leaves the import claimed and allows the receipt retry.
      await writeFile(path, JSON.stringify(completed))
      marker = completed
      for (const done of waiters)
        done()
    })
  }

  async function adopt(): Promise<void> {
    await mutex.runExclusive(async () => {
      if (!marker || marker.state !== 'complete')
        throw new Error('The restored profile is not complete.')
      if (marker.effectsHeld === false)
        return
      const adopted = { ...marker, effectsHeld: false }
      await writeFile(path, JSON.stringify(adopted))
      marker = adopted
    })
  }

  return { begin, complete, adopt, restored: marker !== undefined }
}
