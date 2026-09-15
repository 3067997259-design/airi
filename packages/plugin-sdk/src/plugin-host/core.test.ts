import type { CapabilityResolution } from '.'
import type { ExtensionManifestV1, ModulePermissionDeclaration } from './shared/types'

import { join } from 'node:path'

import { ProtocolVersionIncompatibleError } from '@proj-airi/plugin-protocol/types'
import { safeParse } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExtensionHost, extensionManifestV1Schema, FileSystemLoader } from '.'
import { defineExtension } from '../extension'
import { defineKit } from '../kit'

describe('extension manifest schema', () => {
  it('accepts extension.airi.json v1 manifests', () => {
    const result = safeParse(extensionManifestV1Schema, {
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'airi-extension-test',
      permissions: {},
      entrypoints: {
        electron: './extension.mjs',
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects legacy extension manifests', () => {
    const result = safeParse(extensionManifestV1Schema, {
      apiVersion: 'v1',
      kind: 'manifest.plugin.airi.moeru.ai',
      name: 'airi-plugin-test',
      permissions: {},
      entrypoints: {
        electron: './plugin.mjs',
      },
    })

    expect(result.success).toBe(false)
  })
})

describe('for ExtensionHost', () => {
  it('runs extension setup and registers multiple module sessions', async () => {
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-test',
      async setup(ctx) {
        await ctx.modules.register({ id: 'module-a' })
        await ctx.modules.register({ id: 'module-b' })
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-test',
        permissions: {},
        entrypoints: {},
      },
    })

    expect(session.extension.id).toBe('airi-extension-test')
    expect(host.listModules().map(module => module.id)).toEqual(['module-a', 'module-b'])
  })

  it('records an absent fork negotiation when the module omits forkProtocol', async () => {
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-test',
      async setup(ctx) {
        await ctx.modules.register({ id: 'module-a' })
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-test',
        permissions: {},
        entrypoints: {},
      },
    })

    const module = session.modules.get('module-a')
    expect(module?.forkState).toEqual({
      moduleId: 'module-a',
      negotiation: {
        agreedVersion: null,
        agreedExtensions: [],
        mode: 'absent',
      },
    })
  })

  it('carries forkProtocol through the local register path and negotiates exactly', async () => {
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-test',
      async setup(ctx) {
        await ctx.modules.register({
          id: 'module-a',
          forkProtocol: { version: 1, extensions: ['capability-registry'] },
        })
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-test',
        permissions: {},
        entrypoints: {},
      },
    })

    const module = session.modules.get('module-a')
    expect(module?.forkState?.negotiation).toEqual({
      agreedVersion: 1,
      agreedExtensions: [],
      mode: 'exact',
    })
  })

  it('rejects local module registration when the fork version intersection is empty', async () => {
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-test',
      async setup(ctx) {
        await ctx.modules.register({
          id: 'module-a',
          forkProtocol: { version: 2, extensions: [] },
        })
      },
    })

    await expect(host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-test',
        permissions: {},
        entrypoints: {},
      },
    })).rejects.toBeInstanceOf(ProtocolVersionIncompatibleError)
  })

  it('rejects defineExtension entrypoint ids that do not match the manifest id', async () => {
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-entrypoint-id',
      async setup() {},
    })

    await expect(host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-manifest-id',
        permissions: {},
        entrypoints: {},
      },
    })).rejects.toThrow(
      'Extension entrypoint id `airi-extension-entrypoint-id` must match manifest id `airi-extension-manifest-id`.',
    )
  })

  it('disposes modules registered before setup failure', async () => {
    const disposed: string[] = []
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-failing',
      async setup(ctx) {
        const first = await ctx.modules.register({ id: 'first' })
        first.subscriptions.add({
          dispose: () => {
            disposed.push('first-subscription')
          },
        })
        const second = await ctx.modules.register({ id: 'second' })
        second.subscriptions.add({
          dispose: () => {
            disposed.push('second-subscription')
          },
        })
        throw new Error('setup failed')
      },
    })

    await expect(host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-failing',
        permissions: {},
        entrypoints: {},
      },
    })).rejects.toThrow('setup failed')

    expect(disposed).toEqual(['second-subscription', 'first-subscription'])
    expect(host.listModules()).toEqual([])
  })

  it('cleans up extension kit resources registered before setup failure', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.cleanup-failure',
      version: '1.0.0',
      createClient: runtime => ({
        bind() {
          return host.bindExtensionKitModule(runtime.sessionId, {
            moduleId: 'cleanup-failure-gamelet',
            kitId: 'kit.cleanup-failure',
            kitModuleType: 'gamelet',
            config: {},
          })
        },
      }),
    })
    host.registerKit({
      kitId: 'kit.cleanup-failure',
      version: '1.0.0',
      runtimes: ['electron'],
      capabilities: [],
    })
    host.registerKitApi(kit)
    const extension = defineExtension({
      id: 'airi-extension-cleanup-failure',
      async setup(ctx) {
        const client = await ctx.kits.use(kit)
        client.bind()
        throw new Error('setup failed after resource registration')
      },
    })

    await expect(host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-cleanup-failure',
        permissions: {
          apis: [
            { key: 'kit.cleanup-failure', actions: ['invoke'] },
          ],
          resources: [
            { key: 'proj-airi:plugin-sdk:resources:kits:kit.cleanup-failure:bindings', actions: ['write'] },
          ],
        },
        entrypoints: {},
      },
    })).rejects.toThrow('setup failed after resource registration')

    expect(host.listBindings()).toEqual([])
  })

  /**
   * @example
   * expect(host.listBindings()).toEqual([])
   */
  it('cleans up module-scoped kit resources when the module is disposed', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.module-dispose',
      version: '1.0.0',
      createClient: runtime => ({
        bind() {
          return host.bindExtensionKitModule(runtime.sessionId, {
            moduleId: 'module-dispose-gamelet',
            kitId: 'kit.module-dispose',
            kitModuleType: 'gamelet',
            config: {},
          }, runtime.moduleId)
        },
      }),
    })
    host.registerKit({
      kitId: 'kit.module-dispose',
      version: '1.0.0',
      runtimes: ['electron'],
      capabilities: [],
    })
    host.registerKitApi(kit)
    const permissions: ModulePermissionDeclaration = {
      apis: [
        { key: 'kit.module-dispose', actions: ['invoke'] },
      ],
      resources: [
        { key: 'proj-airi:plugin-sdk:resources:kits:kit.module-dispose:bindings', actions: ['write'] },
      ],
    }
    const extension = defineExtension({
      id: 'airi-extension-module-dispose',
      async setup(ctx) {
        const module = await ctx.modules.register({
          id: 'module-dispose',
          permissions,
        })
        const client = await module.kits.use(kit)
        client.bind()

        await module.dispose()
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-module-dispose',
        permissions,
        entrypoints: {},
      },
    })

    expect(session.phase).toBe('ready')
    expect(host.listModules()).toEqual([])
    expect(host.listBindings()).toEqual([])
  })

  it('lets extension setup use granted kits without registering a module', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.extension-direct',
      version: '1.0.0',
      createClient: runtime => ({
        ping: () => `${runtime.extensionId}:${runtime.sessionId}:${runtime.moduleId ?? 'root'}`,
      }),
    })
    host.registerKitApi(kit)

    let observed = ''
    const extension = defineExtension({
      id: 'airi-extension-direct-kit',
      async setup(ctx) {
        const client = await ctx.kits.use(kit)
        observed = client.ping()
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-direct-kit',
        permissions: {
          apis: [{ key: 'kit.extension-direct', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })

    expect(observed).toContain('airi-extension-direct-kit:')
    expect(observed).toContain(':root')
    expect(host.listModules()).toEqual([])
  })

  it('denies extension-scoped kit use when the extension grant does not allow the kit', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.extension-denied',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    const extension = defineExtension({
      id: 'airi-extension-direct-kit-denied',
      async setup(ctx) {
        const result = await ctx.kits.tryUse(kit)
        expect(result.ok).toBe(false)
        if (!('reason' in result)) {
          throw new Error('Expected direct kit use to be denied.')
        }
        expect(result.reason).toBe('permission-denied')
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-direct-kit-denied',
        permissions: {
          apis: [{ key: 'kit.other', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })
  })

  it('denies extension-scoped kit use when host permission resolver narrows the manifest grant', async () => {
    const host = new ExtensionHost({
      permissionResolver: () => ({
        apis: [{ key: 'kit.other', actions: ['invoke'] }],
      }),
    })
    const kit = defineKit({
      id: 'kit.extension-resolver-denied',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    const extension = defineExtension({
      id: 'airi-extension-direct-kit-resolver-denied',
      async setup(ctx) {
        const result = await ctx.kits.tryUse(kit)
        expect(result.ok).toBe(false)
        if (!('reason' in result)) {
          throw new Error('Expected direct kit use to be denied.')
        }
        expect(result.reason).toBe('permission-denied')
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-direct-kit-resolver-denied',
        permissions: {
          apis: [{ key: 'kit.extension-resolver-denied', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })
  })

  it('does not let persisted grants override a later permission resolver decision', async () => {
    let grantRequestedKit = true
    const host = new ExtensionHost({
      permissionResolver: () => ({
        apis: [{
          key: grantRequestedKit ? 'kit.extension-persisted-revoked' : 'kit.other',
          actions: ['invoke'],
        }],
      }),
    })
    const kit = defineKit({
      id: 'kit.extension-persisted-revoked',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    const manifest = {
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'airi-extension-direct-kit-persisted-revoked',
      permissions: {
        apis: [{ key: 'kit.extension-persisted-revoked', actions: ['invoke'] }],
      },
      entrypoints: {},
    } satisfies ExtensionManifestV1

    const grantedExtension = defineExtension({
      id: 'airi-extension-direct-kit-persisted-revoked',
      async setup(ctx) {
        const result = await ctx.kits.tryUse(kit)
        expect(result.ok).toBe(true)
      },
    })

    await host.startExtension(grantedExtension, { manifest })

    grantRequestedKit = false
    const revokedExtension = defineExtension({
      id: 'airi-extension-direct-kit-persisted-revoked',
      async setup(ctx) {
        const result = await ctx.kits.tryUse(kit)
        expect(result.ok).toBe(false)
        if (!('reason' in result)) {
          throw new Error('Expected direct kit use to be denied.')
        }
        expect(result.reason).toBe('permission-denied')
      },
    })

    await host.startExtension(revokedExtension, { manifest })
  })

  it('lets module-scoped kit use inherit the extension grant when module permissions are omitted', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.module-inherited-grant',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    const extension = defineExtension({
      id: 'airi-extension-module-inherited-grant',
      async setup(ctx) {
        const module = await ctx.modules.register({ id: 'module-a' })
        const result = await module.kits.tryUse(kit)

        expect(result.ok).toBe(true)
        if (!result.ok) {
          throw new Error('Expected inherited module kit use to be allowed.')
        }
        expect(result.client.ping()).toBe('pong')
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-module-inherited-grant',
        permissions: {
          apis: [{ key: 'kit.module-inherited-grant', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })
  })

  it('denies module-scoped kit use when host permission resolver narrows the extension grant', async () => {
    const host = new ExtensionHost({
      permissionResolver: () => ({
        apis: [{ key: 'kit.other', actions: ['invoke'] }],
      }),
    })
    const kit = defineKit({
      id: 'kit.module-resolver-denied',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    const extension = defineExtension({
      id: 'airi-extension-module-kit-resolver-denied',
      async setup(ctx) {
        const module = await ctx.modules.register({
          id: 'module-a',
          permissions: {
            apis: [{ key: 'kit.module-resolver-denied', actions: ['invoke'] }],
          },
        })
        const result = await module.kits.tryUse(kit)
        expect(result.ok).toBe(false)
        if (!('reason' in result)) {
          throw new Error('Expected module kit use to be denied.')
        }
        expect(result.reason).toBe('permission-denied')
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-module-kit-resolver-denied',
        permissions: {
          apis: [{ key: 'kit.module-resolver-denied', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })
  })

  it('lets extension setup watch kit availability without registering a module', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.extension-watch',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })

    const observed: boolean[] = []
    const extension = defineExtension({
      id: 'airi-extension-direct-kit-watch',
      async setup(ctx) {
        ctx.kits.watch(kit, (availability) => {
          observed.push(availability.available)
        })
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-direct-kit-watch',
        permissions: {
          apis: [{ key: 'kit.extension-watch', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })

    host.registerKitApi(kit)

    expect(observed).toEqual([false, true])
  })

  it('disposes extension-scoped kit availability watchers with the extension session', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.extension-watch-dispose',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })

    const observed: boolean[] = []
    const extension = defineExtension({
      id: 'airi-extension-direct-kit-watch-dispose',
      async setup(ctx) {
        ctx.kits.watch(kit, (availability) => {
          observed.push(availability.available)
        })
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-direct-kit-watch-dispose',
        permissions: {
          apis: [{ key: 'kit.extension-watch-dispose', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })

    await session.subscriptions.dispose()
    host.registerKitApi(kit)

    expect(observed).toEqual([false])
  })

  it('supports required, optional, and watched kit availability', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.test',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    let watched = false
    const extension = defineExtension({
      id: 'airi-extension-kit-test',
      async setup(ctx) {
        const module = await ctx.modules.register({
          id: 'module-a',
          permissions: {
            apis: [{ key: 'kit.test', actions: ['invoke'] }],
          },
        })
        const client = await module.kits.use(kit)
        expect(client.ping()).toBe('pong')

        const result = await module.kits.tryUse(kit)
        expect(result.ok).toBe(true)

        module.kits.watch(kit, (availability) => {
          watched = availability.available
        })
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-kit-test',
        permissions: {
          apis: [{ key: 'kit.*', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })

    expect(watched).toBe(true)
  })

  it('disposes module-scoped kit availability watchers with the module scope', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.module-watch-dispose',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })

    const observed: boolean[] = []
    let disposeModule: (() => Promise<void>) | undefined
    const extension = defineExtension({
      id: 'airi-extension-module-kit-watch-dispose',
      async setup(ctx) {
        const module = await ctx.modules.register({
          id: 'module-a',
          permissions: {
            apis: [{ key: 'kit.module-watch-dispose', actions: ['invoke'] }],
          },
        })
        disposeModule = module.dispose
        module.kits.watch(kit, (availability) => {
          observed.push(availability.available)
        })
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-module-kit-watch-dispose',
        permissions: {
          apis: [{ key: 'kit.module-watch-dispose', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })

    if (!disposeModule) {
      throw new Error('Expected module scope to be registered.')
    }
    await disposeModule()
    host.registerKitApi(kit)

    expect(observed).toEqual([false])
  })

  it('rejects duplicate module ids without replacing the registered module', async () => {
    const host = new ExtensionHost()
    const disposed: string[] = []
    const extension = defineExtension({
      id: 'airi-extension-duplicate-module',
      async setup(ctx) {
        const first = await ctx.modules.register({ id: 'module-a' })
        first.subscriptions.add({
          dispose: () => {
            disposed.push('first')
          },
        })

        await expect(ctx.modules.register({ id: 'module-a' })).rejects.toThrow(
          'Extension module `module-a` is already registered',
        )
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-duplicate-module',
        permissions: {},
        entrypoints: {},
      },
    })

    expect([...session.modules.keys()]).toEqual(['module-a'])

    await host.stop(session.id)

    expect(disposed).toEqual(['first'])
  })

  it('waits for async extension module cleanup while stopping a defineExtension session', async () => {
    const host = new ExtensionHost()
    const cleanupOrder: string[] = []
    const extension = defineExtension({
      id: 'airi-extension-async-stop-cleanup',
      async setup(ctx) {
        const module = await ctx.modules.register({ id: 'module-a' })
        module.subscriptions.add({
          dispose: async () => {
            await new Promise(resolve => setTimeout(resolve, 0))
            cleanupOrder.push('module-cleanup')
          },
        })
      },
    })

    const session = await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-async-stop-cleanup',
        permissions: {},
        entrypoints: {},
      },
    })

    const stopped = host.stop(session.id)

    expect(cleanupOrder).toEqual([])

    await stopped

    expect(cleanupOrder).toEqual(['module-cleanup'])
  })

  it('denies kit use when module permissions exceed the extension grant ceiling', async () => {
    const host = new ExtensionHost()
    const kit = defineKit({
      id: 'kit.denied',
      version: '1.0.0',
      createClient: () => ({ ping: () => 'pong' }),
    })
    host.registerKitApi(kit)

    const extension = defineExtension({
      id: 'airi-extension-kit-denied',
      async setup(ctx) {
        const module = await ctx.modules.register({
          id: 'module-a',
          permissions: {
            apis: [{ key: 'kit.denied', actions: ['invoke'] }],
          },
        })
        const result = await module.kits.tryUse(kit)
        expect(result.ok).toBe(false)
        if (!('reason' in result)) {
          throw new Error('Expected kit use to be denied.')
        }
        expect(result.reason).toBe('permission-denied')
      },
    })

    await host.startExtension(extension, {
      manifest: {
        apiVersion: 'v1',
        kind: 'manifest.extension.airi.moeru.ai' as const,
        id: 'airi-extension-kit-denied',
        permissions: {
          apis: [{ key: 'kit.other', actions: ['invoke'] }],
        },
        entrypoints: {},
      },
    })
  })
})

describe('for FileSystemLoader', () => {
  const testPermissions: ModulePermissionDeclaration = {
    apis: [
      { key: 'proj-airi:plugin-sdk:apis:protocol:capabilities:wait', actions: ['invoke'] },
      { key: 'proj-airi:plugin-sdk:apis:protocol:resources:providers:list-providers', actions: ['invoke'] },
    ],
    resources: [
      { key: 'proj-airi:plugin-sdk:apis:protocol:resources:providers:list-providers', actions: ['read'] },
    ],
    capabilities: [
      { key: 'proj-airi:plugin-sdk:apis:protocol:resources:providers:list-providers', actions: ['wait'] },
    ],
  }

  /**
   * @example
   * expect(host.listModules().map(module => module.id)).toEqual(['defined-extension-module'])
   */
  it('loads defineExtension entrypoints from extension manifests', async () => {
    const host = new ExtensionHost()

    await host.start({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-define-extension-entrypoint',
      permissions: {},
      entrypoints: {
        electron: join(import.meta.dirname, 'testdata', 'test-define-extension-entrypoint.ts'),
      },
    }, { cwd: '', runtime: 'electron' })

    expect(host.listModules().map(module => module.id)).toEqual(['defined-extension-module'])
  })

  /**
   * @example
   * expect(host.listModules()).toEqual([])
   */
  it('stops defineExtension entrypoint sessions loaded through host.start', async () => {
    const host = new ExtensionHost()
    const entrypointPath = join(import.meta.dirname, 'testdata', 'test-stoppable-extension-entrypoint.ts')
    const testEntrypoint = await import('./testdata/test-stoppable-extension-entrypoint')
    testEntrypoint.disposedSessionIds.splice(0)

    const session = await host.start({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-stoppable-extension-entrypoint',
      permissions: {},
      entrypoints: {
        electron: entrypointPath,
      },
    }, { cwd: '', runtime: 'electron' })

    expect(host.listModules().map(module => module.id)).toEqual(['stoppable-extension-module'])

    host.stop(session.id)

    await vi.waitFor(() => {
      expect(testEntrypoint.disposedSessionIds).toEqual([session.id])
    })
    expect(host.listModules()).toEqual([])
  })

  /**
   * @example
   * expect(reloaded.phase).toBe('ready')
   */
  it('reloads defineExtension entrypoint sessions loaded through host.start', async () => {
    const host = new ExtensionHost()
    const entrypointPath = join(import.meta.dirname, 'testdata', 'test-stoppable-extension-entrypoint.ts')
    const testEntrypoint = await import('./testdata/test-stoppable-extension-entrypoint')
    testEntrypoint.disposedSessionIds.splice(0)

    const session = await host.start({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-stoppable-extension-entrypoint',
      permissions: {},
      entrypoints: {
        electron: entrypointPath,
      },
    }, { cwd: '', runtime: 'electron' })

    const reloaded = await host.reload(session.id)

    expect(reloaded.phase).toBe('ready')
    expect(testEntrypoint.disposedSessionIds).toEqual([session.id])
    expect(host.listModules().map(module => module.id)).toEqual(['stoppable-extension-module'])
  })

  it('should resolve runtime-specific extension entrypoint with node fallback', async () => {
    const host = new FileSystemLoader()

    const extension = await host.loadExtensionFor({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-extension',
      permissions: testPermissions,
      entrypoints: {
        node: join(import.meta.dirname, 'testdata', 'test-define-extension-entrypoint.ts'),
      },
    }, { cwd: '', runtime: 'node' })

    expect(extension).toBeDefined()
    expect(extension.id).toBe('test-define-extension-entrypoint')
    expect(typeof extension.setup).toBe('function')
  })

  it('should reject entrypoints that do not export defineExtension', async () => {
    const host = new FileSystemLoader()

    await expect(host.loadExtensionFor({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-extension',
      permissions: testPermissions,
      entrypoints: {
        electron: join(import.meta.dirname, 'testdata', 'test-invalid-extension-entrypoint.ts'),
      },
    }, { cwd: '', runtime: 'electron' })).rejects.toThrow('Failed to resolve extension module. The entrypoint must export defineExtension(...).')
  })

  it('should resolve entrypoint by runtime then default then electron', () => {
    const host = new FileSystemLoader()
    const baseManifest = {
      apiVersion: 'v1' as const,
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-extension',
      permissions: testPermissions,
    }

    const runtimeEntryManifest = {
      ...baseManifest,
      entrypoints: {
        node: './node-entry.ts',
        default: './default-entry.ts',
        electron: './electron-entry.ts',
      },
    }
    const defaultFallbackManifest = {
      ...baseManifest,
      entrypoints: {
        default: './default-entry.ts',
        electron: './electron-entry.ts',
      },
    }
    const electronFallbackManifest = {
      ...baseManifest,
      entrypoints: {
        electron: './electron-entry.ts',
      },
    }

    expect(host.resolveEntrypointFor(runtimeEntryManifest, {
      cwd: '/tmp/extension',
      runtime: 'node',
    })).toBe('/tmp/extension/node-entry.ts')

    expect(host.resolveEntrypointFor(defaultFallbackManifest, {
      cwd: '/tmp/extension',
      runtime: 'node',
    })).toBe('/tmp/extension/default-entry.ts')

    expect(host.resolveEntrypointFor(electronFallbackManifest, {
      cwd: '/tmp/extension',
      runtime: 'node',
    })).toBe('/tmp/extension/electron-entry.ts')
  })

  it('should preserve absolute runtime entrypoints', () => {
    const host = new FileSystemLoader()

    expect(host.resolveEntrypointFor({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-extension',
      permissions: testPermissions,
      entrypoints: {
        node: '/opt/extensions/entry.ts',
      },
    }, {
      cwd: '/tmp/extension',
      runtime: 'node',
    })).toBe('/opt/extensions/entry.ts')
  })

  it('should throw deterministic error when no runtime entrypoint exists', () => {
    const host = new FileSystemLoader()

    expect(() => host.resolveEntrypointFor({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-extension',
      permissions: testPermissions,
      entrypoints: {},
    }, { runtime: 'node' })).toThrow('Extension entrypoint is required for runtime `node`.')
  })
})

describe('for migrated extension testdata', () => {
  it('starts the normal defineExtension fixture', async () => {
    const host = new ExtensionHost()

    const session = await host.start({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-plugin',
      permissions: {},
      entrypoints: {
        electron: join(import.meta.dirname, 'testdata', 'test-normal-plugin.ts'),
      },
    }, { cwd: '', runtime: 'electron' })

    expect(session.phase).toBe('ready')
    expect(session.manifest.id).toBe('test-plugin')
  })

  it('surfaces setup failures from migrated defineExtension fixtures', async () => {
    const host = new ExtensionHost()

    await expect(host.start({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-plugin-no-connect',
      permissions: {},
      entrypoints: {
        electron: join(import.meta.dirname, 'testdata', 'test-no-connect-plugin.ts'),
      },
    }, { cwd: '', runtime: 'electron' })).rejects.toThrow(
      'Plugin initialization aborted by plugin: test-plugin-no-connect',
    )
  })

  it('runs the migrated injected kit fixture through ctx.modules and module.kits', async () => {
    const host = new ExtensionHost()
    const { testWidgetKit } = await import('./testdata/test-injected-host-apis-plugin')
    host.registerKitApi(testWidgetKit)

    const session = await host.start({
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id: 'test-plugin-injected-host-apis',
      permissions: {
        apis: [{ key: testWidgetKit.id, actions: ['invoke'] }],
      },
      entrypoints: {
        electron: join(import.meta.dirname, 'testdata', 'test-injected-host-apis-plugin.ts'),
      },
    }, { cwd: '', runtime: 'electron' })

    expect(session.phase).toBe('ready')
    expect(host.listModules().map(module => module.id)).toEqual(['test-injected-host-apis-module'])
  })
})

describe('for ExtensionHost capability lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function testManifest(id: string): ExtensionManifestV1 {
    return {
      apiVersion: 'v1',
      kind: 'manifest.extension.airi.moeru.ai' as const,
      id,
      permissions: {},
      entrypoints: {},
    }
  }

  it('delegates the existing capability methods to the registry', () => {
    const host = new ExtensionHost()

    expect(host.isCapabilityReady('cap.manual')).toBe(false)

    host.announceCapability('cap.manual', { source: 'test' })
    expect(host.isCapabilityReady('cap.manual')).toBe(false)

    host.markCapabilityReady('cap.manual', { source: 'test' })
    expect(host.isCapabilityReady('cap.manual')).toBe(true)
    expect(host.listCapabilities()).toContainEqual(
      expect.objectContaining({ key: 'cap.manual', state: 'ready' }),
    )

    host.markCapabilityDegraded('cap.manual', { reason: 'flaky' })
    expect(host.isCapabilityReady('cap.manual')).toBe(false)

    host.withdrawCapability('cap.manual')
    expect(host.listCapabilities()).toContainEqual(
      expect.objectContaining({ key: 'cap.manual', state: 'withdrawn' }),
    )
  })

  it('resolves a pre-existing ready capability for a late waiter immediately', async () => {
    const host = new ExtensionHost()
    host.markCapabilityReady('cap.ready', { source: 'bootstrap' })

    await expect(host.waitForCapability('cap.ready', 1000)).resolves.toMatchObject({
      key: 'cap.ready',
      state: 'ready',
    })

    const resolution = await host.waitForCapabilityRequirement({ allOf: ['cap.ready'], timeoutMs: 1000 })
    expect(resolution.satisfied).toBe(true)
    expect(resolution.missing).toEqual([])
    expect(typeof resolution.since).toBe('number')
  })

  it('moves a session from setting-up to waiting-deps and recovers deterministically', async () => {
    const host = new ExtensionHost()
    const extension = defineExtension({
      id: 'airi-extension-waiting-deps',
      requires: { allOf: ['cap.dependency'] },
      async setup(ctx) {
        await ctx.modules.register({ id: 'module-a' })
      },
    })

    const session = await host.startExtension(extension, { manifest: testManifest(extension.id) })

    expect(session.phase).toBe('waiting-deps')
    expect(session.dependencyStatus?.missing).toEqual(['cap.dependency'])
    expect(typeof session.dependencyStatus?.since).toBe('number')

    host.markCapabilityReady('cap.dependency', { source: 'provider' })
    expect(session.phase).toBe('ready')
    expect(session.dependencyStatus?.missing).toEqual([])
    expect(session.dependencyStatus?.bound).toEqual(['cap.dependency'])

    host.markCapabilityDegraded('cap.dependency', { reason: 'executor lost' })
    expect(session.phase).toBe('degraded')
    expect(session.dependencyStatus?.degraded).toEqual({
      capabilityId: 'cap.dependency',
      reason: 'executor lost',
    })

    host.markCapabilityReady('cap.dependency', { source: 'recovered' })
    expect(session.phase).toBe('ready')
    expect(session.dependencyStatus?.degraded).toBeUndefined()
  })

  it('resolves a requirement that is already satisfied when the session starts', async () => {
    const host = new ExtensionHost()
    host.markCapabilityReady('cap.pre', { source: 'bootstrap' })
    const extension = defineExtension({
      id: 'airi-extension-late-requirement',
      requires: { allOf: ['cap.pre'] },
      async setup() {},
    })

    const session = await host.startExtension(extension, { manifest: testManifest(extension.id) })

    expect(session.phase).toBe('ready')
    expect(session.dependencyStatus?.bound).toEqual(['cap.pre'])

    host.markCapabilityDegraded('cap.pre', { reason: 'provider restart' })
    expect(session.phase).toBe('degraded')
    expect(session.dependencyStatus?.degraded).toEqual({
      capabilityId: 'cap.pre',
      reason: 'provider restart',
    })

    host.markCapabilityReady('cap.pre', { source: 'bootstrap' })
    expect(session.phase).toBe('ready')
    expect(session.dependencyStatus?.degraded).toBeUndefined()
  })

  it('times out with explicit missing ids and leaves the session in waiting-deps', async () => {
    vi.useFakeTimers()

    const host = new ExtensionHost()
    let result: (CapabilityResolution & { since: number }) | undefined
    const extension = defineExtension({
      id: 'airi-extension-timeout',
      requires: { allOf: ['cap.never'] },
      async setup() {
        result = await host.waitForCapabilityRequirement({ allOf: ['cap.never'], timeoutMs: 50 })
      },
    })

    const startPromise = host.startExtension(extension, { manifest: testManifest(extension.id) })
    await vi.advanceTimersByTimeAsync(50)
    const session = await startPromise

    expect(result?.satisfied).toBe(false)
    expect(result?.missing).toEqual(['cap.never'])
    expect(typeof result?.since).toBe('number')
    expect(session.phase).toBe('waiting-deps')
    expect(session.dependencyStatus?.missing).toEqual(['cap.never'])
  })

  it('flips observer mode only after both consumer ids announce a capability', () => {
    const host = new ExtensionHost()

    expect(host.getCapabilityConsumerState()).toEqual({ observed: ['plugin-host'], observerMode: true })

    host.announceCapability('game.minecraft.control', {
      providerModuleId: 'game-host',
      version: '1.0.0',
    })
    expect(host.getCapabilityConsumerState()).toEqual({
      observed: ['game-host', 'plugin-host'],
      observerMode: true,
    })

    host.announceCapability('skill.adapter.self-authored', { providerModuleId: 'skill-adapter' })
    expect(host.getCapabilityConsumerState()).toEqual({
      observed: ['game-host', 'plugin-host', 'skill-adapter'],
      observerMode: false,
    })
  })

  it('emits capability changes through the public subscription', () => {
    const host = new ExtensionHost()
    const changes: Array<{ revision: number, kind: string }> = []
    const unsubscribe = host.subscribeCapabilities((change) => {
      changes.push({ revision: change.revision, kind: change.kind })
    })

    host.announceCapability('cap.subscribed')
    host.markCapabilityReady('cap.subscribed')
    host.withdrawCapability('cap.subscribed')
    unsubscribe()

    expect(changes.map(change => change.kind)).toEqual(['upsert', 'upsert', 'withdrawn'])
    expect(host.getCapabilitySnapshot().revision).toBeGreaterThanOrEqual(changes.length)
  })
})
