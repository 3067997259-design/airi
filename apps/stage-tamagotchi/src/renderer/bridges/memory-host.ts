import type {
  MemoryHostFragment,
  MemoryHostInsertParams,
  MemoryHostListParams,
  MemoryHostSearchParams,
  MemoryHostStatus,
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
  memoryHostSearch,
} from '../../shared/eventa'

export interface MemoryHostClient {
  configure: (params: { connectionString?: string }) => Promise<MemoryHostStatus>
  getStatus: () => Promise<MemoryHostStatus>
  list: (params?: MemoryHostListParams) => Promise<MemoryHostFragment[]>
  search: (params: MemoryHostSearchParams) => Promise<MemoryHostFragment[]>
  insert: (params: MemoryHostInsertParams) => Promise<MemoryHostFragment>
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
  }
}
