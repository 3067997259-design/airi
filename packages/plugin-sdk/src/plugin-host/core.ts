import type { ForkProtocolDescriptor, ModuleForkState } from '@proj-airi/plugin-protocol/types'

import type {
  Extension,
  ExtensionKitRegistry,
  ExtensionModuleContext,
  ExtensionSetupContext,
  RegisterExtensionModuleInput,
} from '../extension/shared'
import type { KitAvailability, KitRef, KitUseResult } from '../kit'
import type { AnnounceBindingInput, UpdateBindingInput } from '../plugin/apis/client/bindings'
import type { CapabilityDescriptor } from '../plugin/apis/protocol'
import type {
  CapabilityChange,
  CapabilityPatch,
  CapabilityRecord,
  CapabilityRecordKey,
  CapabilityRequirement,
  CapabilityResolution,
  CapabilitySnapshot,
} from './capability-registry'
import type { BindingRecord, KitCapabilityDescriptor, KitDescriptor } from './shared'
import type { ExtensionLoader } from './shared/loader'
import type {
  ExtensionHostContribution,
  ExtensionHostInstallContext,
  ExtensionHostOptions,
  ExtensionHostPermissionRequest,
  ExtensionManifestV1,
  ExtensionStartOptions,
  HostDataRecord,
  HostDataValue,
  ModulePermissionDeclaration,
  ModulePermissionGrant,
  PluginRuntime,
} from './shared/types'

import { forkProtocolSupportedVersions, negotiateForkProtocol } from '@proj-airi/plugin-protocol/types'

import { DisposableStore } from '../extension/disposable'
import { kitUseFailure } from '../kit'
import {
  getKitBindingResourceKey,
  pluginBindingApiActivateEventName,
  pluginBindingApiAnnounceEventName,
  pluginBindingApiUpdateEventName,
  pluginBindingApiWithdrawEventName,
} from '../plugin/apis/client/bindings'
import {
  protocolListProvidersEventName,
} from '../plugin/apis/protocol/resources/providers'
import { CapabilityRegistry, isCapabilityHealth } from './capability-registry'
import { FileSystemLoader } from './runtimes/node/loaders'
import {
  ExtensionSessionService,
  KitApiBindingRegistryService,
  KitRegistryService,
  PermissionService,
  ResourceService,
} from './runtimes/shared'

/**
 * Extension host lifecycle overview.
 *
 * The host owns manifest validation, extension setup sessions, extension-level
 * permission grants, and module cleanup. Extension code uses `setup(ctx)` as
 * the common authoring entrypoint and requests host-installed kits through
 * `ctx.kits`. Explicit modules are optional lifecycle and attribution scopes
 * that can narrow kit usage through `module.kits`.
 *
 * Permission checks are intentionally two-layered: the extension grant is the
 * package/session ceiling. Extension-scoped kit usage is checked against that
 * ceiling directly; module-scoped kit usage is checked against the module grant
 * derived from `extension grant intersection module request`.
 */

class PermissionDeniedError extends Error {
  readonly details: {
    area: 'apis' | 'resources' | 'capabilities' | 'processors' | 'pipelines'
    action: string
    key: string
  }

  constructor(details: PermissionDeniedError['details']) {
    super(`Permission denied: ${details.area}.${details.action} "${details.key}"`)
    this.name = 'PermissionDeniedError'
    this.details = details
  }
}

// NOTICE: The host declares fork protocol version 1 and no Next Steps extensions.
// Keep this descriptor and forkProtocolSupportedVersions in sync so the local
// register path and the remote announce path negotiate the same result.
const hostForkProtocolDescriptor: ForkProtocolDescriptor = {
  version: 1,
  extensions: [],
}

// NOTICE: The legacy key-based capability methods (announceCapability and
// friends) delegate to the capability registry under these defaults. The host
// id and provider module id are fixed; consumers pass their own consumer id
// through `metadata.providerModuleId` so the registry observer set sees them.
const hostCapabilityHostId = 'extension-host'
const hostCapabilityProviderModuleId = 'plugin-host'

/**
 * Describes the host-owned state for one extension setup session.
 */
export interface ExtensionSession {
  /** Unique host-generated session id. */
  id: string
  /** Extension identity and session metadata. */
  extension: {
    id: string
    version?: string
    sessionId: string
  }
  /** Manifest used to start this extension. */
  manifest: ExtensionManifestV1
  /** Working directory used to resolve relative manifest entrypoints. */
  cwd?: string
  /** Runtime used to choose manifest entrypoints. */
  runtime?: PluginRuntime
  /** Loaded extension definition. */
  entrypoint: Extension
  /** Current extension setup phase. */
  phase: 'setting-up' | 'waiting-deps' | 'ready' | 'degraded' | 'failed' | 'stopped'
  /** Capability requirements declared by the extension via `requires`. */
  requires?: CapabilityRequirement
  /** Dependency visibility written while waiting or degraded. */
  dependencyStatus?: ExtensionDependencyStatus
  /** Modules registered by this extension setup. */
  modules: Map<string, ExtensionModuleContext>
  /** Requested and granted permissions for the extension session. */
  permissions: {
    requested: ModulePermissionDeclaration
    granted: ModulePermissionGrant
    revision: number
  }
  /** Extension-session cleanup callbacks. */
  subscriptions: DisposableStore
}

/**
 * Capability dependency summary written to an {@link ExtensionSession} while it
 * waits on `requires` or runs degraded. The summary is diagnostic only: settings
 * pages and logs read it, and the host never derives scheduling from it while
 * the registry is in observer mode.
 */
export interface ExtensionDependencyStatus {
  /** The requirement the session declared via `requires`. */
  requires: CapabilityRequirement
  /** Capability ids the session bound to when it last became ready. */
  bound: string[]
  /** Unresolved capability ids while in `waiting-deps`. */
  missing: string[]
  /** Timestamp when the session entered `waiting-deps`. */
  since: number
  /** Bound capability that degraded or withdrew, while in `degraded`. */
  degraded?: { capabilityId: string, reason: string }
}

/**
 * Filters the binding list returned by `ExtensionHost.listBindings(...)`.
 *
 * Use when:
 * - Narrowing the host binding snapshot by owner session or kit
 *
 * Expects:
 * - Omitted fields mean "do not filter by this dimension"
 *
 * Returns:
 * - Optional filter criteria for the in-memory binding registry
 */
export interface ExtensionHostBindingListOptions {
  /** Limit results to bindings owned by one extension session. */
  ownerSessionId?: string
  /** Limit results to bindings declared against one kit. */
  kitId?: string
}

type BoundAnnounceBindingInput<C extends HostDataRecord = HostDataRecord> = AnnounceBindingInput<C>
type BoundUpdateBindingInput<C extends HostDataRecord = HostDataRecord> = UpdateBindingInput<C>

interface ExtensionModuleResourceTracker {
  bindingIds: Set<string>
}

function omitModuleId<C extends HostDataRecord>(input: BoundUpdateBindingInput<C>) {
  return {
    state: input.state,
    config: input.config,
  }
}

function cloneHostDataValue<T extends HostDataValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneHostDataValue(item)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneHostDataValue(item as HostDataValue)]),
    ) as T
  }

  return value
}

function cloneHostDataRecord<T extends HostDataRecord>(record: T): T {
  return cloneHostDataValue(record)
}

function cloneKitCapabilities(capabilities: KitCapabilityDescriptor[]): KitCapabilityDescriptor[] {
  return capabilities.map(capability => ({
    key: capability.key,
    actions: [...capability.actions],
  }))
}

function cloneKitDescriptor<TKit extends KitDescriptor>(kit: TKit): TKit {
  return {
    ...kit,
    runtimes: [...kit.runtimes],
    capabilities: cloneKitCapabilities(kit.capabilities),
  }
}

function cloneBindingRecord<C extends HostDataRecord>(module: BindingRecord<C>): BindingRecord<C> {
  return {
    ...module,
    config: cloneHostDataRecord(module.config),
  }
}

/**
 * Orchestrates extension loading, setup sessions, bindings, resources, and permissions.
 *
 * Use when:
 * - Running extension entrypoints inside the in-memory host implementation
 * - Tests or applications need one place to start, stop, reload, and query extension sessions
 *
 * Expects:
 * - Extensions are loaded from manifest entrypoints through {@link FileSystemLoader}
 * - Each session gets its own permission scope, module registry, and cleanup store
 *
 * Returns:
 * - A host instance that exposes extension sessions plus access to kits, bindings, resources, and capabilities
 *
 * Call stack:
 *
 * caller
 *   -> {@link ExtensionHost.start}
 *     -> {@link FileSystemLoader.resolveEntrypointFor}
 *     -> {@link FileSystemLoader.loadExtensionFor}
 *     -> {@link ExtensionHost.startExtension}
 */
export class ExtensionHost {
  private readonly loader: ExtensionLoader
  private readonly extensionSessionService = new ExtensionSessionService<ExtensionSession>()
  private readonly runtime: PluginRuntime
  private readonly capabilities = new CapabilityRegistry()
  private readonly kits = new KitRegistryService()
  private readonly kitApis = new Map<string, KitRef<unknown>>()
  private readonly kitApiWatchers = new Map<string, Set<() => Promise<void>>>()
  private readonly modules = new KitApiBindingRegistryService()
  private readonly extensionModuleResources = new Map<string, ExtensionModuleResourceTracker>()
  private readonly permissions = new PermissionService()
  private readonly permissionResolver?: ExtensionHostOptions['permissionResolver']
  private readonly persistedPermissionGrants = new Map<string, ModulePermissionGrant>()
  private readonly resources = new ResourceService()
  private capabilityReconciler?: () => void

  private readonly installContext: ExtensionHostInstallContext

  constructor(options: ExtensionHostOptions = {}) {
    this.loader = options.loader ?? new FileSystemLoader()
    this.runtime = options.runtime ?? 'electron'
    this.permissionResolver = options.permissionResolver
    this.resources.setValue(protocolListProvidersEventName, [] as Array<{ name: string }>)
    this.markCapabilityReady(protocolListProvidersEventName, { source: 'plugin-host' })
    this.installContext = this.createInstallContext()

    for (const contribution of options.contributions ?? []) {
      this.installContribution(contribution)
    }
  }

  async startExtension(
    extension: Extension,
    options: { manifest: ExtensionManifestV1, cwd?: string, runtime?: PluginRuntime },
  ) {
    if (extension.id !== options.manifest.id) {
      throw new Error(`Extension entrypoint id \`${extension.id}\` must match manifest id \`${options.manifest.id}\`.`)
    }

    const sessionIdentity = this.extensionSessionService.nextSessionIdentity()
    const extensionIdentity = {
      id: extension.id,
      version: extension.version,
      sessionId: sessionIdentity.sessionId,
    }
    const persistedGrant = this.persistedPermissionGrants.get(extension.id)
    const resolvedGrant = await this.permissionResolver?.({
      identity: extensionIdentity,
      manifest: options.manifest,
      requested: options.manifest.permissions,
      persisted: persistedGrant,
    }) ?? options.manifest.permissions
    const permissionSnapshot = this.permissions.initialize(sessionIdentity.sessionId, options.manifest.permissions, {
      grant: resolvedGrant,
      persisted: this.permissionResolver ? undefined : persistedGrant,
    })
    this.persistedPermissionGrants.set(extension.id, permissionSnapshot.granted)
    const subscriptions = new DisposableStore()
    const session: ExtensionSession = {
      id: sessionIdentity.sessionId,
      extension: extensionIdentity,
      manifest: options.manifest,
      cwd: options.cwd,
      runtime: options.runtime,
      entrypoint: extension,
      phase: 'setting-up',
      requires: extension.requires,
      modules: new Map(),
      permissions: {
        requested: permissionSnapshot.requested,
        granted: permissionSnapshot.granted,
        revision: permissionSnapshot.revision,
      },
      subscriptions,
    }

    this.extensionSessionService.register(session)

    const ctx: ExtensionSetupContext = {
      extension: session.extension,
      kits: this.createExtensionKitRegistry(session),
      subscriptions,
      modules: {
        register: async (input: RegisterExtensionModuleInput) => {
          if (session.modules.has(input.id)) {
            throw new Error(`Extension module \`${input.id}\` is already registered for session ${session.id}.`)
          }

          const moduleSubscriptions = new DisposableStore()
          const permissions = this.permissions.intersectGrant(
            session.permissions.granted,
            input.permissions ?? session.permissions.granted,
          )
          const forkState: ModuleForkState = {
            moduleId: input.id,
            negotiation: negotiateForkProtocol({
              local: hostForkProtocolDescriptor,
              localSupported: forkProtocolSupportedVersions,
              remote: input.forkProtocol,
            }),
          }
          const module: ExtensionModuleContext = {
            id: input.id,
            identity: {
              id: input.id,
              extension: session.extension,
              labels: input.labels,
            },
            permissions,
            kits: this.createModuleKitRegistry(session, moduleSubscriptions, input.id),
            subscriptions: moduleSubscriptions,
            forkState,
            dispose: async () => {
              await this.cleanupExtensionModuleResources(session, input.id)
              await moduleSubscriptions.dispose()
              session.modules.delete(input.id)
            },
          }
          session.modules.set(module.id, module)
          return module
        },
      },
    }

    try {
      await extension.setup(ctx)
      if (extension.requires) {
        this.ensureCapabilityReconciler()
        const resolution = this.capabilities.resolve(extension.requires)
        if (resolution.satisfied) {
          session.phase = 'ready'
          session.dependencyStatus = this.createReadyDependencyStatus(extension.requires, resolution, undefined)
        }
        else {
          session.phase = 'waiting-deps'
          session.dependencyStatus = {
            requires: extension.requires,
            bound: [],
            missing: resolution.missing,
            since: Date.now(),
          }
        }
      }
      else {
        session.phase = 'ready'
      }
      return session
    }
    catch (error) {
      session.phase = 'failed'
      await this.cleanupExtensionSession(session)
      throw error
    }
  }

  listModules() {
    return this.extensionSessionService
      .list()
      .flatMap(session => [...session.modules.values()])
  }

  registerKitApi<TClient>(kit: KitRef<TClient>) {
    this.kitApis.set(kit.id, kit as KitRef<unknown>)
    void this.notifyKitApiWatchers(kit.id)
    return kit
  }

  unregisterKitApi(kitId: string) {
    const deleted = this.kitApis.delete(kitId)
    void this.notifyKitApiWatchers(kitId)
    return deleted
  }

  private async cleanupExtensionSessionModules(session: ExtensionSession) {
    for (const module of [...session.modules.values()].reverse()) {
      await module.dispose()
    }
    session.modules.clear()
  }

  private getExtensionModuleResourceKey(sessionId: string, moduleId: string) {
    return `${sessionId}:${moduleId}`
  }

  private getOrCreateExtensionModuleResourceTracker(sessionId: string, moduleId: string) {
    const key = this.getExtensionModuleResourceKey(sessionId, moduleId)
    let resources = this.extensionModuleResources.get(key)
    if (!resources) {
      resources = {
        bindingIds: new Set(),
      }
      this.extensionModuleResources.set(key, resources)
    }

    return resources
  }

  private async cleanupExtensionModuleResources(session: ExtensionSession, moduleId: string) {
    const key = this.getExtensionModuleResourceKey(session.id, moduleId)
    const resources = this.extensionModuleResources.get(key)
    if (!resources) {
      return
    }

    for (const bindingId of resources.bindingIds) {
      const binding = this.modules.get(bindingId)
      if (!binding) {
        continue
      }

      if (binding.state !== 'withdrawn') {
        this.modules.withdraw(session.id, session.extension.id, bindingId)
      }
      this.modules.unbind(session.id, session.extension.id, bindingId)
    }

    this.extensionModuleResources.delete(key)
  }

  private async notifyKitApiWatchers(kitId: string) {
    const watchers = this.kitApiWatchers.get(kitId)
    if (!watchers?.size) {
      return
    }

    for (const watcher of watchers) {
      await watcher()
    }
  }

  private resolveKitApi<TClient>(
    session: ExtensionSession,
    kit: KitRef<TClient>,
    subscriptions: DisposableStore,
    moduleId?: string,
  ): KitUseResult<TClient> {
    const registered = this.kitApis.get(kit.id) as KitRef<TClient> | undefined
    if (!registered) {
      return kitUseFailure(kit, 'missing-kit')
    }

    const grant = moduleId
      ? session.modules.get(moduleId)?.permissions
      : session.permissions.granted

    if (!grant || !this.permissions.grantAllows(grant, 'apis', 'invoke', kit.id)) {
      return kitUseFailure(kit, 'permission-denied')
    }

    return {
      ok: true,
      client: registered.createClient({
        extensionId: session.extension.id,
        sessionId: session.id,
        moduleId,
        subscriptions,
      }),
    }
  }

  private createKitRegistry(session: ExtensionSession, subscriptions: DisposableStore, moduleId?: string): ExtensionKitRegistry {
    return {
      use: async <TClient>(kit: KitRef<TClient>) => {
        const result = this.resolveKitApi(session, kit, subscriptions, moduleId)
        if (result.ok) {
          return result.client
        }
        const failure = result as Extract<KitUseResult<TClient>, { ok: false }>
        throw failure.error
      },
      tryUse: async <TClient>(kit: KitRef<TClient>) => {
        return this.resolveKitApi(session, kit, subscriptions, moduleId)
      },
      watch: <TClient>(kit: KitRef<TClient>, callback: (availability: KitAvailability<TClient>) => void | Promise<void>) => {
        const watchers = this.kitApiWatchers.get(kit.id) ?? new Set()
        let disposed = false
        const watcher = async () => {
          if (disposed) {
            return
          }

          const result = this.resolveKitApi(session, kit, subscriptions, moduleId)
          if (result.ok) {
            await callback({ available: true, kit, client: result.client })
            return
          }

          const failure = result as Extract<KitUseResult<TClient>, { ok: false }>
          await callback({ available: false, kit, reason: failure.reason, error: failure.error })
        }
        watchers.add(watcher)
        this.kitApiWatchers.set(kit.id, watchers)
        void watcher()
        return subscriptions.add({
          dispose: () => {
            if (disposed) {
              return
            }

            disposed = true
            watchers.delete(watcher)
            if (watchers.size === 0) {
              this.kitApiWatchers.delete(kit.id)
            }
          },
        })
      },
    }
  }

  private createExtensionKitRegistry(session: ExtensionSession): ExtensionKitRegistry {
    return this.createKitRegistry(session, session.subscriptions)
  }

  private createModuleKitRegistry(session: ExtensionSession, subscriptions: DisposableStore, moduleId: string): ExtensionModuleContext['kits'] {
    return this.createKitRegistry(session, subscriptions, moduleId)
  }

  private assertExtensionPermission(
    session: ExtensionSession,
    input: ExtensionHostPermissionRequest,
    moduleId?: string,
  ) {
    const grant = moduleId
      ? session.modules.get(moduleId)?.permissions
      : session.permissions.granted

    if (grant && this.permissions.grantAllows(grant, input.area, input.action, input.key)) {
      return
    }

    throw new PermissionDeniedError({
      area: input.area,
      action: input.action,
      key: input.key,
    })
  }

  private getExtensionSessionOrThrow(sessionId: string) {
    const session = this.extensionSessionService.get(sessionId)
    if (!session) {
      throw new Error(`Unknown extension session: ${sessionId}`)
    }

    return session
  }

  private createInstallContext(): ExtensionHostInstallContext {
    return {
      registerKit: kit => this.registerKit(kit),
      unregisterKit: kitId => this.unregisterKit(kitId),
      setResourceResolver: (key, resolver) => this.setResourceResolver(key, resolver),
      setResourceValue: (key, value) => this.setResourceValue(key, value),
      announceCapability: (key, metadata) => {
        this.announceCapability(key, metadata)
      },
      markCapabilityReady: (key, metadata) => {
        this.markCapabilityReady(key, metadata)
      },
      markCapabilityDegraded: (key, metadata) => {
        this.markCapabilityDegraded(key, metadata)
      },
      withdrawCapability: (key, metadata) => {
        this.withdrawCapability(key, metadata)
      },
    }
  }

  private installContribution(contribution: ExtensionHostContribution) {
    contribution.install(this.installContext)
  }

  private async cleanupExtensionSession(session: ExtensionSession) {
    session.phase = 'stopped'

    for (const module of this.modules.listByOwner(session.id)) {
      this.modules.withdraw(session.id, session.extension.id, module.moduleId)
      this.modules.unbind(session.id, session.extension.id, module.moduleId)
    }
    await this.cleanupExtensionSessionModules(session)
    await session.subscriptions.dispose()
    this.extensionSessionService.remove(session.id)
  }

  private getModuleOrThrow(moduleId: string) {
    const module = this.modules.get(moduleId)
    if (!module) {
      throw new Error(`Module \`${moduleId}\` was not found.`)
    }

    return module
  }

  private assertKitAvailableForRuntime(kitId: string, runtime: PluginRuntime) {
    const kit = this.kits.get(kitId)
    if (!kit) {
      throw new Error(`Kit \`${kitId}\` is not registered.`)
    }

    if (!kit.runtimes.includes(runtime)) {
      throw new Error(`Kit \`${kitId}\` is not available for runtime \`${runtime}\`.`)
    }

    return kit
  }

  listSessions() {
    return this.extensionSessionService.list()
  }

  getSession(sessionId: string) {
    return this.extensionSessionService.get(sessionId)
  }

  registerKit(kit: KitDescriptor) {
    return this.kits.register(kit)
  }

  unregisterKit(kitId: string) {
    return this.kits.remove(kitId)
  }

  getKit(kitId: string) {
    const kit = this.kits.get(kitId)
    if (!kit) {
      return undefined
    }

    return cloneKitDescriptor(kit)
  }

  listKits(runtime?: PluginRuntime) {
    const kits = runtime
      ? this.kits.listByRuntime(runtime)
      : this.kits.list()

    return kits.map(kit => cloneKitDescriptor(kit))
  }

  getKitCapabilities(kitId: string): KitCapabilityDescriptor[] {
    const capabilities = this.kits.get(kitId)?.capabilities
    if (!capabilities) {
      return []
    }

    return cloneKitCapabilities(capabilities)
  }

  getBinding(moduleId: string): BindingRecord<HostDataRecord> | undefined {
    const module = this.modules.get(moduleId)
    if (!module) {
      return undefined
    }

    return cloneBindingRecord(module)
  }

  listBindings(options: ExtensionHostBindingListOptions = {}) {
    return this.modules.list().filter((module) => {
      if (options.ownerSessionId && module.ownerSessionId !== options.ownerSessionId) {
        return false
      }

      if (options.kitId && module.kitId !== options.kitId) {
        return false
      }

      return true
    }).map(module => cloneBindingRecord(module))
  }

  announceBinding<C extends HostDataRecord = HostDataRecord>(
    sessionId: string,
    input: BoundAnnounceBindingInput<C>,
  ): BindingRecord<C> {
    const session = this.getExtensionSessionOrThrow(sessionId)
    const kit = this.assertKitAvailableForRuntime(input.kitId, session.runtime ?? this.runtime)

    this.assertExtensionPermission(session, {
      area: 'apis',
      action: 'invoke',
      key: pluginBindingApiAnnounceEventName,
    })
    this.assertExtensionPermission(session, {
      area: 'resources',
      action: 'write',
      key: getKitBindingResourceKey(kit.kitId),
      reason: `Module announce requires write access to kit \`${kit.kitId}\`.`,
    })

    return cloneBindingRecord(this.modules.bind({
      ...input,
      ownerSessionId: session.id,
      ownerExtensionId: session.extension.id,
      runtime: session.runtime ?? this.runtime,
    }) as BindingRecord<C>)
  }

  activateBinding(sessionId: string, moduleId: string) {
    const session = this.getExtensionSessionOrThrow(sessionId)
    const module = this.getModuleOrThrow(moduleId)

    this.assertExtensionPermission(session, {
      area: 'apis',
      action: 'invoke',
      key: pluginBindingApiActivateEventName,
    })
    this.assertExtensionPermission(session, {
      area: 'resources',
      action: 'write',
      key: getKitBindingResourceKey(module.kitId),
      reason: `Module activation requires write access to kit \`${module.kitId}\`.`,
    })

    return cloneBindingRecord(this.modules.activate(session.id, session.extension.id, moduleId))
  }

  updateBinding<C extends HostDataRecord = HostDataRecord>(
    sessionId: string,
    moduleId: string,
    patch: UpdateBindingInput<C> | Omit<UpdateBindingInput<C>, 'moduleId'>,
  ) {
    const session = this.getExtensionSessionOrThrow(sessionId)
    const module = this.getModuleOrThrow(moduleId)

    this.assertExtensionPermission(session, {
      area: 'apis',
      action: 'invoke',
      key: pluginBindingApiUpdateEventName,
    })
    this.assertExtensionPermission(session, {
      area: 'resources',
      action: 'write',
      key: getKitBindingResourceKey(module.kitId),
      reason: `Module update requires write access to kit \`${module.kitId}\`.`,
    })

    const normalizedPatch = 'moduleId' in patch ? omitModuleId(patch) : patch
    return cloneBindingRecord(this.modules.update(session.id, session.extension.id, moduleId, normalizedPatch))
  }

  degradeBinding(sessionId: string, moduleId: string) {
    const session = this.getExtensionSessionOrThrow(sessionId)
    const module = this.getModuleOrThrow(moduleId)
    this.assertExtensionPermission(session, {
      area: 'resources',
      action: 'write',
      key: getKitBindingResourceKey(module.kitId),
      reason: `Module degradation requires write access to kit \`${module.kitId}\`.`,
    })

    return cloneBindingRecord(this.modules.degrade(session.id, session.extension.id, moduleId))
  }

  withdrawBinding(sessionId: string, moduleId: string) {
    const session = this.getExtensionSessionOrThrow(sessionId)
    const module = this.getModuleOrThrow(moduleId)

    this.assertExtensionPermission(session, {
      area: 'apis',
      action: 'invoke',
      key: pluginBindingApiWithdrawEventName,
    })
    this.assertExtensionPermission(session, {
      area: 'resources',
      action: 'write',
      key: getKitBindingResourceKey(module.kitId),
      reason: `Module withdrawal requires write access to kit \`${module.kitId}\`.`,
    })

    return cloneBindingRecord(this.modules.withdraw(session.id, session.extension.id, moduleId))
  }

  bindExtensionKitModule<C extends HostDataRecord = HostDataRecord>(
    sessionId: string,
    input: BoundAnnounceBindingInput<C>,
    permissionModuleId?: string,
  ): BindingRecord<C> {
    const session = this.getExtensionSessionOrThrow(sessionId)
    const kit = this.assertKitAvailableForRuntime(input.kitId, this.runtime)

    this.assertExtensionPermission(session, {
      area: 'resources',
      action: 'write',
      key: getKitBindingResourceKey(kit.kitId),
      reason: `Module announce requires write access to kit \`${kit.kitId}\`.`,
    }, permissionModuleId)

    const binding = cloneBindingRecord(this.modules.bind({
      ...input,
      ownerSessionId: session.id,
      ownerExtensionId: session.extension.id,
      runtime: this.runtime,
    }) as BindingRecord<C>)

    if (permissionModuleId) {
      this.getOrCreateExtensionModuleResourceTracker(session.id, permissionModuleId).bindingIds.add(binding.moduleId)
    }

    return binding
  }

  async start(manifest: ExtensionManifestV1, options: ExtensionStartOptions = {}): Promise<ExtensionSession> {
    const extension = await this.loader.loadExtensionFor(manifest, {
      cwd: options.cwd,
      runtime: options.runtime,
    })

    const session = await this.startExtension(extension, {
      manifest,
      cwd: options.cwd,
      runtime: options.runtime,
    })

    return session
  }

  setResourceResolver<T>(key: string, resolver: () => Promise<T> | T) {
    this.resources.setResolver(key, resolver)
  }

  setResourceValue<T>(key: string, value: T) {
    this.resources.setValue(key, value)
  }

  announceCapability(key: string, metadata?: Record<string, unknown>) {
    const scope = this.resolveCapabilityScope(metadata)
    return this.capabilities.announce(this.hostAnnounceInput(scope, key, metadata))
  }

  markCapabilityReady(key: string, metadata?: Record<string, unknown>) {
    const scope = this.resolveCapabilityScope(metadata)
    const recordKey = this.capabilityRecordKey(scope, key)
    if (!this.capabilities.has(recordKey)) {
      this.capabilities.announce(this.hostAnnounceInput(scope, key, metadata))
    }
    return this.capabilities.ready(recordKey, this.capabilityPatch(metadata))
  }

  markCapabilityDegraded(key: string, metadata?: Record<string, unknown>) {
    const scope = this.resolveCapabilityScope(metadata)
    const recordKey = this.capabilityRecordKey(scope, key)
    if (!this.capabilities.has(recordKey)) {
      this.capabilities.announce(this.hostAnnounceInput(scope, key, metadata))
    }
    return this.capabilities.degrade(recordKey, this.capabilityPatch(metadata))
  }

  withdrawCapability(key: string, metadata?: Record<string, unknown>) {
    const scope = this.resolveCapabilityScope(metadata)
    const recordKey = this.capabilityRecordKey(scope, key)
    if (!this.capabilities.has(recordKey)) {
      this.capabilities.announce(this.hostAnnounceInput(scope, key, metadata))
    }
    return this.capabilities.withdraw(recordKey, this.capabilityPatch(metadata))
  }

  listCapabilities() {
    return this.capabilities.snapshot().records.map(record => this.capabilityRecordToDescriptor(record))
  }

  isCapabilityReady(key: string) {
    return this.capabilities.resolve({ allOf: [key] }).satisfied
  }

  async waitForCapabilities(keys: string[], timeoutMs: number = 15000) {
    const result = await this.waitForCapabilityRequirement({ allOf: keys, timeoutMs })
    if (!result.satisfied) {
      throw new Error(`Capabilities are not ready after ${timeoutMs}ms: ${result.missing.join(', ')}.`)
    }
  }

  async waitForCapability(key: string, timeoutMs: number = 15000) {
    const result = await this.waitForCapabilityRequirement({ allOf: [key], timeoutMs })
    if (!result.satisfied) {
      throw new Error(`Capability \`${key}\` is not ready after ${timeoutMs}ms.`)
    }
    const record = result.matched[0]
    if (!record) {
      throw new Error(`Capability \`${key}\` resolved without a ready record.`)
    }
    return this.capabilityRecordToDescriptor(record)
  }

  /**
   * Returns the authoritative capability snapshot. Late consumers always read
   * this before waiting so they never miss a readiness signal.
   */
  getCapabilitySnapshot(): CapabilitySnapshot {
    return this.capabilities.snapshot()
  }

  /**
   * Resolves a capability requirement immediately against the current snapshot.
   */
  resolveCapabilityRequirement(requirement: CapabilityRequirement): CapabilityResolution {
    return this.capabilities.resolve(requirement)
  }

  /**
   * Waits until a capability requirement is satisfied, or until
   * `requirement.timeoutMs` elapses. Resolves immediately when the snapshot
   * already satisfies the requirement. A timeout returns
   * `{ satisfied: false, missing, since }` and never silently proceeds.
   */
  async waitForCapabilityRequirement(
    requirement: CapabilityRequirement,
  ): Promise<CapabilityResolution & { since: number }> {
    const since = Date.now()
    const initial = this.capabilities.resolve(requirement)
    if (initial.satisfied) {
      return { ...initial, since }
    }

    const timeoutMs = requirement.timeoutMs ?? 15000
    return await new Promise<CapabilityResolution & { since: number }>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const unsubscribe = this.capabilities.subscribe(() => {
        if (settled) {
          return
        }
        const resolution = this.capabilities.resolve(requirement)
        if (!resolution.satisfied) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        unsubscribe()
        resolve({ ...resolution, since })
      })
      timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        unsubscribe()
        resolve({
          satisfied: false,
          matched: [],
          missing: this.capabilities.resolve(requirement).missing,
          since,
        })
      }, timeoutMs)
    })
  }

  /**
   * Subscribes to capability changes. The listener receives
   * `{ revision, record, kind }` only when a record actually changes. Returns
   * an idempotent unsubscribe function.
   */
  subscribeCapabilities(listener: (change: CapabilityChange) => void): () => void {
    return this.capabilities.subscribe(listener)
  }

  /**
   * Returns the registry observer state: which consumers have announced a
   * capability, and whether observer mode is still active. Observer mode ends
   * only after both `game-host` and `skill-adapter` have announced.
   */
  getCapabilityConsumerState(): { observed: string[], observerMode: boolean } {
    return this.capabilities.getConsumerState()
  }

  private resolveCapabilityScope(metadata?: Record<string, unknown>) {
    return {
      hostId: hostCapabilityHostId,
      providerModuleId: typeof metadata?.providerModuleId === 'string'
        ? metadata.providerModuleId
        : hostCapabilityProviderModuleId,
      instanceId: typeof metadata?.instanceId === 'string' ? metadata.instanceId : undefined,
    }
  }

  private hostAnnounceInput(
    scope: { hostId: string, providerModuleId: string, instanceId?: string },
    key: string,
    metadata?: Record<string, unknown>,
  ) {
    return {
      capabilityId: key,
      providerModuleId: scope.providerModuleId,
      hostId: scope.hostId,
      instanceId: scope.instanceId,
      runtime: this.runtime as CapabilityRecord['runtime'],
      version: typeof metadata?.version === 'string' ? metadata.version : undefined,
      health: isCapabilityHealth(metadata?.health) ? metadata.health : undefined,
      metadata,
    }
  }

  private capabilityRecordKey(scope: { hostId: string, instanceId?: string }, key: string): CapabilityRecordKey {
    return {
      capabilityId: key,
      hostId: scope.hostId,
      instanceId: scope.instanceId,
    }
  }

  private capabilityPatch(metadata?: Record<string, unknown>): CapabilityPatch {
    return {
      version: typeof metadata?.version === 'string' ? metadata.version : undefined,
      health: isCapabilityHealth(metadata?.health) ? metadata.health : undefined,
      metadata: metadata !== undefined ? metadata : undefined,
    }
  }

  private capabilityRecordToDescriptor(record: CapabilityRecord): CapabilityDescriptor {
    return {
      key: record.capabilityId,
      state: record.state,
      metadata: record.metadata,
      updatedAt: this.capabilities.getUpdatedAt({
        capabilityId: record.capabilityId,
        hostId: record.hostId,
        instanceId: record.instanceId,
      }) ?? Date.now(),
    }
  }

  private createReadyDependencyStatus(
    requirement: CapabilityRequirement,
    resolution: CapabilityResolution,
    previousSince: number | undefined,
  ): ExtensionDependencyStatus {
    return {
      requires: requirement,
      bound: this.boundCapabilityIds(requirement),
      missing: resolution.missing,
      since: previousSince ?? Date.now(),
    }
  }

  private boundCapabilityIds(requirement: CapabilityRequirement): string[] {
    const bound = new Set<string>()
    for (const id of requirement.allOf ?? []) {
      bound.add(id)
    }
    for (const id of requirement.anyOf ?? []) {
      if (this.isCapabilityReady(id)) {
        bound.add(id)
      }
    }
    if (requirement.predicate) {
      for (const record of this.capabilities.snapshot().records) {
        if (record.state === 'ready' && requirement.predicate(record)) {
          bound.add(record.capabilityId)
        }
      }
    }
    return [...bound]
  }

  private ensureCapabilityReconciler() {
    if (this.capabilityReconciler) {
      return
    }
    this.capabilityReconciler = this.capabilities.subscribe(() => {
      this.reconcileSessionDependencies()
    })
  }

  private reconcileSessionDependencies() {
    for (const session of this.extensionSessionService.list()) {
      if (!session.requires || !session.dependencyStatus) {
        continue
      }
      if (session.phase === 'waiting-deps') {
        const resolution = this.capabilities.resolve(session.requires)
        if (resolution.satisfied) {
          session.phase = 'ready'
          session.dependencyStatus = this.createReadyDependencyStatus(
            session.requires,
            resolution,
            session.dependencyStatus.since,
          )
        }
        continue
      }
      if (session.phase === 'degraded') {
        const degraded = session.dependencyStatus.degraded
        if (degraded && this.isCapabilityReady(degraded.capabilityId)) {
          session.phase = 'ready'
          session.dependencyStatus = {
            ...session.dependencyStatus,
            degraded: undefined,
          }
        }
        continue
      }
      if (session.phase === 'ready') {
        for (const boundId of session.dependencyStatus.bound) {
          const record = this.capabilities.get({
            capabilityId: boundId,
            hostId: hostCapabilityHostId,
          })
          if (record && record.state !== 'ready') {
            session.phase = 'degraded'
            session.dependencyStatus = {
              ...session.dependencyStatus,
              degraded: {
                capabilityId: boundId,
                reason: typeof record.metadata?.reason === 'string' ? record.metadata.reason : record.state,
              },
            }
            break
          }
        }
      }
    }
  }

  async stop(sessionId: string): Promise<ExtensionSession | undefined> {
    const extensionSession = this.extensionSessionService.get(sessionId)
    if (!extensionSession) {
      return undefined
    }

    await this.cleanupExtensionSession(extensionSession)
    return extensionSession
  }

  async reload(sessionId: string, options: ExtensionStartOptions = {}): Promise<ExtensionSession> {
    // Reload preserves manifest/runtime intent, then performs stop + fresh start.
    // This intentionally creates a new session identity for deterministic re-bootstrap.
    const previousExtension = this.extensionSessionService.get(sessionId)
    if (!previousExtension) {
      throw new Error(`Unable to reload missing extension session: ${sessionId}`)
    }

    const manifest = previousExtension.manifest
    await this.cleanupExtensionSession(previousExtension)
    return this.start(manifest, {
      ...options,
      cwd: options.cwd ?? previousExtension.cwd,
      runtime: options.runtime ?? previousExtension.runtime,
    })
  }
}
