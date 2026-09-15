import type { ModulePermissionDeclaration } from '@proj-airi/plugin-sdk/plugin-host'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { manifestDigestOf, PermissionsFileInvalidError, PermissionStore } from './store'

function manifest(permissions: ModulePermissionDeclaration = {}): { id: string, permissions: ModulePermissionDeclaration } {
  return { id: 'demo-ext', permissions }
}

const requested: ModulePermissionDeclaration = { apis: [{ key: 'kit.demo', actions: ['invoke'] }] }

describe('cp-2 permission store', () => {
  let extensionsDir: string
  let store: PermissionStore

  beforeEach(async () => {
    extensionsDir = await mkdtemp(join(tmpdir(), 'airi-permissions-'))
    store = new PermissionStore({ extensionsDir, now: () => 1_700_000_000_000 })
  })

  afterEach(async () => {
    await rm(extensionsDir, { recursive: true, force: true })
  })

  it('denies by default and never falls back to the manifest declaration', async () => {
    const declared = manifest({ apis: [{ key: 'kit.demo', actions: ['invoke'] }] })

    const resolved = await store.resolve({ extensionId: 'demo-ext', manifest: declared, requested })

    expect(resolved).toEqual({
      grant: { apis: [], resources: [], capabilities: [], processors: [], pipelines: [] },
      reason: 'not_approved',
    })
  })

  it('approves, narrows to the request, and persists across instances', async () => {
    const declared = manifest({
      apis: [{ key: 'kit.demo', actions: ['invoke', 'emit'] }],
      resources: [{ key: 'plugin.resource.settings', actions: ['read', 'write'] }],
    })
    const record = await store.approve({
      extensionId: 'demo-ext',
      manifest: declared,
      grant: {
        apis: [{ key: 'kit.demo', actions: ['invoke'] }],
        resources: [{ key: 'plugin.resource.settings', actions: ['read'] }],
      },
    })
    expect(record.grant.apis).toEqual([{ key: 'kit.demo', actions: ['invoke'] }])
    expect(record.approvedBy).toBe('user')
    expect(record.manifestDigest).toBe(manifestDigestOf(declared))

    // A fresh instance reads the persisted file (restart recovery).
    const reopened = new PermissionStore({ extensionsDir })
    const resolved = await reopened.resolve({
      extensionId: 'demo-ext',
      manifest: declared,
      requested: {
        apis: [{ key: 'kit.demo', actions: ['invoke', 'emit'] }],
        resources: [{ key: 'plugin.resource.settings', actions: ['read'] }],
      },
    })
    expect(resolved.reason).toBeUndefined()
    // `emit` was not part of the approved ceiling.
    expect(resolved.grant.apis).toEqual([{ key: 'kit.demo', actions: ['invoke'] }])
    expect(resolved.grant.resources).toEqual([{ key: 'plugin.resource.settings', actions: ['read'] }])
  })

  it('invalidates an approval when the manifest bytes change', async () => {
    const declared = manifest({ apis: [{ key: 'kit.demo', actions: ['invoke'] }] })
    await store.approve({ extensionId: 'demo-ext', manifest: declared })

    const changed = manifest({
      apis: [{ key: 'kit.demo', actions: ['invoke'] }],
      resources: [{ key: 'plugin.resource.extra', actions: ['read'] }],
    })
    const resolved = await store.resolve({ extensionId: 'demo-ext', manifest: changed, requested })

    expect(resolved.reason).toBe('manifest_changed')
    expect(resolved.grant.apis).toEqual([])
  })

  it('revokes and reports whether a record existed', async () => {
    const declared = manifest({ apis: [{ key: 'kit.demo', actions: ['invoke'] }] })
    await store.approve({ extensionId: 'demo-ext', manifest: declared })

    expect(await store.revoke('demo-ext')).toBe(true)
    expect(await store.revoke('demo-ext')).toBe(false)
    expect(await store.list()).toEqual([])
    expect((await store.resolve({ extensionId: 'demo-ext', manifest: declared, requested })).reason).toBe('not_approved')
  })

  it('serializes concurrent approvals without losing records', async () => {
    await Promise.all([
      store.approve({ extensionId: 'ext-a', manifest: { permissions: { apis: [{ key: 'kit.a', actions: ['invoke'] }] } } }),
      store.approve({ extensionId: 'ext-b', manifest: { permissions: { apis: [{ key: 'kit.b', actions: ['invoke'] }] } } }),
    ])

    const file = JSON.parse(await readFile(join(extensionsDir, 'permissions.json'), 'utf8')) as { grants: Array<{ extensionId: string }> }
    expect(file.grants.map(grant => grant.extensionId).sort()).toEqual(['ext-a', 'ext-b'])
  })

  it('hashes the manifest independent of key order', () => {
    expect(manifestDigestOf({ id: 'a', permissions: { apis: [] } }))
      .toBe(manifestDigestOf({ permissions: { apis: [] }, id: 'a' }))
  })

  it('never silently resets a corrupt permissions.json', async () => {
    await mkdir(extensionsDir, { recursive: true })
    await writeFile(join(extensionsDir, 'permissions.json'), '{ not json')

    await expect(store.list()).rejects.toBeInstanceOf(PermissionsFileInvalidError)
  })
})
