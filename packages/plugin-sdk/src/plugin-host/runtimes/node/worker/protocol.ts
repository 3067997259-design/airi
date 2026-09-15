import { defineEventa } from '@moeru/eventa'

/**
 * CP-2 node-worker protocol (fork namespace).
 *
 * The host loads the bootstrap in a `worker_threads.Worker`, hands the
 * entrypoint through `workerData`, then drives the session with these events.
 * Both sides import this module; it must stay side-effect free.
 */

/** `workerData` shape the host passes when spawning the bootstrap. */
export interface NodeWorkerInitData {
  /** Absolute path of the extension entrypoint to import inside the worker. */
  entrypoint: string
}

/** Worker → host: the bootstrap is alive and ready to receive `initialize`. */
export const workerSpawnedEvent = defineEventa<{ pid: number | undefined }>('fork:plugin:worker:spawned')
/** Host → worker: import the entrypoint and run `setup`. */
export const workerInitializeEvent = defineEventa<void>('fork:plugin:worker:initialize')
/** Worker → host: setup finished; carries the resolved extension id. */
export const workerReadyEvent = defineEventa<{ extensionId: string }>('fork:plugin:worker:ready')
/** Worker → host: setup failed or the worker crashed; carries the reason. */
export const workerFailedEvent = defineEventa<{ error: string }>('fork:plugin:worker:failed')
/** Host → worker: tear the session down inside the worker. */
export const workerDisposeEvent = defineEventa<void>('fork:plugin:worker:dispose')
