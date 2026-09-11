import type {
  MemoryHostFragment,
  MemoryHostInsertParams,
  MemoryHostListParams,
  MemoryHostRemoveParams,
  MemoryHostSearchParams,
  MemoryHostStatus,
  MemoryHostUpdateParams,
} from '../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
/**
 * Renderer-side memory host client (MAINTENANCE-PLAN P2.4).
 *
 * Thin facade over the main-process `eventa:invoke:electron:memory-host:*`
 * contracts; shapes mirror the stage-ui `MemoryHostPort` structurally.
 */
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'

import {
  memoryHostConfigure,
  memoryHostGetStatus,
  memoryHostInsert,
  memoryHostList,
  memoryHostRemove,
  memoryHostSearch,
  memoryHostUpdate,
} from '../../shared/eventa'

export interface MemoryHostClient {
  configure: (params: { connectionString?: string }) => Promise<MemoryHostStatus>
  getStatus: () => Promise<MemoryHostStatus>
  list: (params?: MemoryHostListParams) => Promise<MemoryHostFragment[]>
  search: (params: MemoryHostSearchParams) => Promise<MemoryHostFragment[]>
  insert: (params: MemoryHostInsertParams) => Promise<MemoryHostFragment>
  update: (params: MemoryHostUpdateParams) => Promise<MemoryHostFragment | undefined>
  remove: (params: MemoryHostRemoveParams) => Promise<{ removed: boolean }>
}

let cachedClient: MemoryHostClient | undefined

/** Creates (or reuses) the memory host client for the current renderer. */
export function createMemoryHostClient(): MemoryHostClient {
  cachedClient ??= createMemoryHostClientInner()
  return cachedClient
}

function createMemoryHostClientInner(): MemoryHostClient {
  const context = getElectronEventaContext()

  return {
    configure: defineInvoke(context, memoryHostConfigure),
    getStatus: defineInvoke(context, memoryHostGetStatus),
    list: defineInvoke(context, memoryHostList),
    search: defineInvoke(context, memoryHostSearch),
    insert: defineInvoke(context, memoryHostInsert),
    update: defineInvoke(context, memoryHostUpdate),
    remove: defineInvoke(context, memoryHostRemove),
  }
}
