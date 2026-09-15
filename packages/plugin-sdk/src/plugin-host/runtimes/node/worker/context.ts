import type { Worker } from 'node:worker_threads'

import { createContext as createWorkerThreadContext } from '@moeru/eventa/adapters/worker-threads'

/**
 * CP-2 fork helper: host-side Eventa context for a node-worker extension.
 *
 * Fills the `node-worker` transport branch of `createPluginContext` with the
 * Eventa worker-threads adapter. The worker side creates the matching context
 * through `@moeru/eventa/adapters/worker-threads/worker`.
 */
export function createNodeWorkerContext(worker: Worker) {
  return createWorkerThreadContext(worker).context
}
