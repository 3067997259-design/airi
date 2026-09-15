import type { ExtensionSetupContext } from '../../../../extension'
import type { NodeWorkerInitData } from './protocol'

import process from 'node:process'

import { pathToFileURL } from 'node:url'
import { workerData } from 'node:worker_threads'

import { createContext } from '@moeru/eventa/adapters/worker-threads/worker'
import { errorMessageFrom } from '@moeru/std'

import { coerceExtensionFromModule } from '../loaders/fs'
import { workerDisposeEvent, workerFailedEvent, workerInitializeEvent, workerReadyEvent, workerSpawnedEvent } from './protocol'

/**
 * CP-2 node-worker bootstrap (fork).
 *
 * Runs inside `worker_threads`; the host spawns this file with
 * `workerData = { entrypoint }` and drives it through the protocol events.
 * Extension setup executes here, so a crash, throw, or loop is contained by
 * the worker boundary; the host only observes `ready` / `failed` / exit.
 */

const { context } = createContext()
const initData = workerData as NodeWorkerInitData | undefined

function reportFailure(error: unknown): void {
  context.emit(workerFailedEvent, { error: errorMessageFrom(error) ?? String(error) })
}

process.on('uncaughtException', (error) => {
  reportFailure(error)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  reportFailure(error)
  process.exit(1)
})

context.on(workerDisposeEvent, () => {
  process.exit(0)
})

/**
 * Worker-side setup context (CP-2 increment 2).
 *
 * The host setup context owns live kit/module/service objects in the main
 * process; those calls are not proxied yet. Accessing them fails with an
 * explainable error instead of silently missing APIs.
 */
function createWorkerSetupContext(): ExtensionSetupContext {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`Worker extension setup cannot use ctx.${String(property)}: host setup APIs are not proxied into the worker yet (CP-2 increment 2).`)
    },
  }) as ExtensionSetupContext
}

context.on(workerInitializeEvent, async () => {
  try {
    if (!initData?.entrypoint)
      throw new Error('Worker bootstrap requires workerData.entrypoint.')
    const entryModule = await import(pathToFileURL(initData.entrypoint).href)
    const extension = coerceExtensionFromModule(entryModule)
    await extension.setup(createWorkerSetupContext())
    context.emit(workerReadyEvent, { extensionId: extension.id })
  }
  catch (error) {
    reportFailure(error)
    process.exit(1)
  }
})

context.emit(workerSpawnedEvent, { pid: process.pid })
