import type { CapabilityRecord } from '@proj-airi/plugin-sdk/plugin-host'

import type { PluginCapabilityState } from '../../../../shared/eventa/plugin/capabilities'
import type { ExtensionHostService, SetupExtensionHostOptions } from './types'

import { defineInvoke, defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { app, ipcMain } from 'electron'

import {
  extensionPermissionsApprove,
  extensionPermissionsChanged,
  extensionPermissionsList,
  extensionPermissionsRevoke,
} from '../../../../shared/eventa/permissions'
import { electronPluginGetAssetBaseUrl } from '../../../../shared/eventa/plugin/assets'
import {
  electronPluginUpdateCapability,
  pluginProtocolListProviders,
  pluginProtocolListProvidersEventName,
} from '../../../../shared/eventa/plugin/capabilities'
import {
  electronPluginInspect,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginLoadInWorker,
  electronPluginSetAutoReload,
  electronPluginSetEnabled,
  electronPluginUnload,
} from '../../../../shared/eventa/plugin/host'
import {
  electronPluginCancelTool,
  electronPluginInvokeTool,
  electronPluginListAgentTools,
  electronPluginListXsaiTools,
  electronPluginToolsChanged,
} from '../../../../shared/eventa/plugin/tools'
import { setupExtensionHostServiceInternal } from './host'
import { InFlightCallRegistry } from './inflight'

/**
 * Initializes the Electron extension host and wires IPC handlers.
 * Call once during app startup; it loads manifests, returns the host instance,
 * and registers Eventa handlers for listing, enabling, and loading plugins.
 *
 * Loads extension manifests from the app config directory under `extensions/v1`.
 *
 * - Windows: %APPDATA%\${appId}\extensions\v1
 * - Linux: $XDG_CONFIG_HOME/${appId}/extensions/v1 or ~/.config/${appId}/extensions/v1
 * - macOS: ~/Library/Application Support/${appId}/extensions/v1
 *
 * Persists enablement/known state to `extensions-v1.json` alongside config data.
 *
 * - Windows: %APPDATA%\${appId}/extensions-v1.json
 * - Linux: $XDG_CONFIG_HOME/${appId}/extensions-v1.json or ~/.config/${appId}/extensions-v1.json
 * - macOS: ~/Library/Application Support/${appId}/extensions-v1.json
 */
export async function setupExtensionHost(options: SetupExtensionHostOptions): Promise<ExtensionHostService> {
  const hostService = await setupExtensionHostServiceInternal(options)
  const { context } = createContext(ipcMain)
  // In-flight plugin tool calls keyed by the renderer's correlation id and
  // indexed by owner so unload/disable/revoke terminate them in bounded time.
  const inFlightCalls = new InFlightCallRegistry()
  const invokePluginProtocolListProviders = defineInvoke(context, pluginProtocolListProviders)

  const abortExtensionCalls = (extensionId: string, reason: string) => {
    const aborted = inFlightCalls.abortByOwner(extensionId, reason)
    if (aborted > 0)
      console.warn(`[plugin-host] Aborted ${aborted} in-flight call(s) of ${extensionId}.`)
  }

  defineInvokeHandler(context, electronPluginList, async () => {
    return await hostService.list()
  })

  defineInvokeHandler(context, electronPluginSetEnabled, async (payload) => {
    const result = await hostService.setEnabled(payload)
    if (!payload.enabled)
      abortExtensionCalls(payload.extensionId, `Extension ${payload.extensionId} was disabled.`)
    context.emit(electronPluginToolsChanged, {
      reason: 'enabled-state-changed',
      extensionId: payload.extensionId,
    })
    return result
  })

  defineInvokeHandler(context, electronPluginSetAutoReload, async (payload) => {
    return await hostService.setAutoReload(payload)
  })

  defineInvokeHandler(context, electronPluginLoadEnabled, async () => {
    const result = await hostService.loadEnabled()
    context.emit(electronPluginToolsChanged, {
      reason: 'load-enabled',
    })
    return result
  })

  defineInvokeHandler(context, electronPluginLoad, async (payload) => {
    const result = await hostService.load(payload.extensionId)
    context.emit(electronPluginToolsChanged, {
      reason: 'loaded',
      extensionId: payload.extensionId,
    })
    return result
  })

  defineInvokeHandler(context, electronPluginLoadInWorker, async (payload) => {
    const result = await hostService.loadInWorker(payload.extensionId)
    context.emit(electronPluginToolsChanged, {
      reason: 'loaded',
      extensionId: payload.extensionId,
    })
    return result
  })

  defineInvokeHandler(context, electronPluginUnload, async (payload) => {
    const result = await hostService.unload(payload.extensionId)
    abortExtensionCalls(payload.extensionId, `Extension ${payload.extensionId} was unloaded.`)
    context.emit(electronPluginToolsChanged, {
      reason: 'unloaded',
      extensionId: payload.extensionId,
    })
    return result
  })

  defineInvokeHandler(context, electronPluginInspect, async () => {
    return await hostService.inspect()
  })

  defineInvokeHandler(context, extensionPermissionsList, async () => {
    return await hostService.listPermissionEntries()
  })

  defineInvokeHandler(context, extensionPermissionsApprove, async (payload) => {
    const entries = await hostService.approvePermission(payload)
    context.emit(extensionPermissionsChanged, undefined)
    context.emit(electronPluginToolsChanged, {
      reason: 'unloaded',
      extensionId: payload.extensionId,
    })
    return entries
  })

  defineInvokeHandler(context, extensionPermissionsRevoke, async ({ extensionId }) => {
    const entries = await hostService.revokePermission(extensionId)
    abortExtensionCalls(extensionId, `Permissions for ${extensionId} were revoked.`)
    context.emit(extensionPermissionsChanged, undefined)
    context.emit(electronPluginToolsChanged, {
      reason: 'unloaded',
      extensionId,
    })
    return entries
  })

  defineInvokeHandler(context, electronPluginGetAssetBaseUrl, async () => {
    return hostService.getAssetBaseUrl()
  })

  defineInvokeHandler(context, electronPluginListAgentTools, async () => {
    return await hostService.tools.listAvailableDescriptors()
  })

  defineInvokeHandler(context, electronPluginListXsaiTools, async () => {
    return await hostService.tools.listSerializedXsaiTools()
  })

  defineInvokeHandler(context, electronPluginInvokeTool, async (payload) => {
    // The renderer cancels by correlation id when the registration is
    // revoked; Eventa cannot carry an AbortSignal object. Calls are indexed
    // by owner so an unload/disable/revoke aborts them in bounded time.
    const controller = inFlightCalls.register(payload.requestId, payload.ownerExtensionId)
    try {
      return await hostService.tools.invoke(payload.ownerExtensionId, payload.name, payload.input, { abortSignal: controller.signal })
    }
    finally {
      inFlightCalls.settle(payload.requestId)
    }
  })

  defineInvokeHandler(context, electronPluginCancelTool, async ({ requestId }) => {
    const controller = inFlightCalls.get(requestId)
    if (!controller)
      return { cancelled: false }
    controller.abort(new Error(`Plugin tool call ${requestId} was cancelled.`))
    return { cancelled: true }
  })

  defineInvokeHandler(context, electronPluginUpdateCapability, async (payload) => {
    if (payload.key === pluginProtocolListProvidersEventName && payload.state === 'ready') {
      hostService.host.setResourceResolver(
        pluginProtocolListProvidersEventName,
        async () => await invokePluginProtocolListProviders(),
      )
    }

    // The registry returns provider records (revision-scoped); the renderer
    // contract is key/state/metadata with a receipt timestamp, so the boundary
    // maps explicitly instead of leaking the record shape over IPC.
    const toCapabilityState = (key: string, record: CapabilityRecord): PluginCapabilityState => ({
      key,
      state: record.state,
      ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
      updatedAt: Date.now(),
    })

    switch (payload.state) {
      case 'announced':
        return toCapabilityState(payload.key, hostService.host.announceCapability(payload.key, payload.metadata))
      case 'ready':
        return toCapabilityState(payload.key, hostService.host.markCapabilityReady(payload.key, payload.metadata))
      case 'degraded':
        return toCapabilityState(payload.key, hostService.host.markCapabilityDegraded(payload.key, payload.metadata))
      case 'withdrawn':
        return toCapabilityState(payload.key, hostService.host.withdrawCapability(payload.key, payload.metadata))
      default: {
        const unexpectedState: never = payload.state
        throw new Error(`Unsupported capability state: ${unexpectedState}`)
      }
    }
  })

  if (typeof app.once === 'function') {
    app.once('before-quit', () => {
      inFlightCalls.abortAll('Plugin host is shutting down.')
      void hostService.dispose()
    })
  }

  return {
    host: hostService.host,
    manifests: hostService.manifests,
  }
}
