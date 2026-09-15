import type { EventContext } from '@moeru/eventa'

import type { PluginTransport } from '../../transports'

import { createContext } from '@moeru/eventa'

import { createNodeWorkerContext } from './worker/context'

export * from '../../capability-registry'
export * from '../../core'
export * from '../../shared'
export * from '../../transports'
// Fork addition (CP-2): the node runtime entry must expose the shared runtime
// services (PermissionService, DependencyService, ...) just like the
// `plugin-host` barrel does; without this, the `node` export condition
// resolves to a subset and app-side permission wiring cannot reuse them.
export * from '../shared'
export * from './loaders'
export * from './worker'

/**
 * Creates the Eventa context used by node-side extension host sessions.
 *
 * Use when:
 * - Bootstrapping a node runtime extension session
 *
 * Expects:
 * - `transport` describes a transport supported by the node runtime
 *
 * Returns:
 * - A node-compatible Eventa context, or throws if the transport is not implemented
 */
export function createPluginContext(transport: PluginTransport): EventContext<any, any> {
  switch (transport.kind) {
    case 'in-memory':
      return createContext()
    case 'websocket':
      throw new Error('WebSocket transport is not implemented for node runtime yet.')
    case 'node-worker':
      return createNodeWorkerContext(transport.worker)
    case 'electron':
      throw new Error('Electron transport is not implemented yet.')
    case 'web-worker':
      throw new Error('Web worker transport is not available in node runtime.')
    default:
      throw new Error('Unknown plugin transport kind.')
  }
}
