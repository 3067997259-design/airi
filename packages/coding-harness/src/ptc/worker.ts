/**
 * PTC sandbox worker (CODING-HARNESS-DESIGN §3 / §3.2).
 *
 * Generalized from the minecraft `js-planner-worker`: the same bridge
 * request/response loop and error serialization, with `node:vm` replacing
 * isolated-vm as the in-process guest context. Execution still happens in a
 * forked child under `--permission` / `--frozen-intrinsics` with an empty
 * environment, so the worker has no filesystem, network or module access
 * beyond what the parent explicitly injects.
 */
import type {
  ParentToWorkerMessage,
  SandboxRunPayload,
  SerializedWorkerError,
  WorkerToParentMessage,
} from './protocol'

import process from 'node:process'

import { inspect } from 'node:util'
import { createContext, runInContext } from 'node:vm'

function cloneStructured<T>(value: T): T {
  if (typeof value === 'undefined')
    return value

  try {
    return structuredClone(value)
  }
  catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

// NOTICE:
// The worker cannot import workspace packages: its permission-frozen child must
// start with only the worker source directory readable. Keep error extraction
// local so dependency package resolution cannot widen that boundary.
// Removal condition: only remove this helper when the worker is bundled into a
// permission-safe artifact that does not need package manifest access.
function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    return error.message
  if (error instanceof Error)
    return error.message
  return String(error)
}

function serializeWorkerError(error: unknown): SerializedWorkerError {
  const name = typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string'
    ? error.name
    : error instanceof Error
      ? error.name
      : 'Error'
  const message = messageOf(error)
  const stack = typeof error === 'object' && error !== null && 'stack' in error && typeof error.stack === 'string'
    ? error.stack
    : error instanceof Error
      ? error.stack
      : undefined
  return stack ? { message, name, stack } : { message, name }
}

function hydrateWorkerError(error: SerializedWorkerError): Error {
  const hydrated = new Error(error.message)
  hydrated.name = error.name
  if (error.stack)
    hydrated.stack = error.stack
  return hydrated
}

function send(message: WorkerToParentMessage): void {
  process.send?.(message)
}

function appendLog(logs: string[], args: unknown[]): string {
  const rendered = args.map(arg => inspect(arg, { depth: 4, breakLength: 120 })).join(' ')
  logs.push(rendered)
  return rendered
}

let nextRequestId = 1
const pendingRequests = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()

async function requestParent(method: string, args: unknown[]): Promise<unknown> {
  const requestId = nextRequestId++
  send({
    type: 'bridge-request',
    requestId,
    method,
    args: cloneStructured(args),
  })

  return await new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
  })
}

async function runEvaluation(payload: SandboxRunPayload): Promise<void> {
  const logs: string[] = []

  try {
    // The sandbox object IS the vm context's global object; plain data from
    // the payload is injected as globals, bridge and log stay host-side.
    const sandbox: Record<string, unknown> = { ...payload.globals }
    sandbox.bridge = async (method: string, args: unknown[]) => requestParent(method, args)
    sandbox.log = (...args: unknown[]) => appendLog(logs, args)
    sandbox.bridgeAvailable = Object.fromEntries(payload.bridgeToolNames.map(name => [name, true]))
    const context = createContext(sandbox)

    // NOTICE:
    // `runInContext`'s `timeout` guards the SYNCHRONOUS portion of the
    // evaluation only, so the IIFE must be invoked here — an infinite loop
    // then dies inside evaluation, while a program that reaches its first
    // `await` yields the promise and keeps executing asynchronously under
    // the runner's hard timeout.
    const promise: Promise<unknown> = runInContext(
      `(async () => { {\n${payload.script}\n} })()`,
      context,
      { timeout: payload.timeoutMs },
    )

    const returnRaw = await promise

    send({
      type: 'result',
      result: {
        logs: cloneStructured(logs),
        returnRaw: typeof returnRaw === 'undefined' ? undefined : cloneStructured(returnRaw),
      },
    })
  }
  catch (error) {
    send({
      type: 'error',
      error: serializeWorkerError(error),
      state: { logs: cloneStructured(logs) },
    })
  }
  finally {
    for (const pending of pendingRequests.values())
      pending.reject(new Error('Sandbox worker is shutting down'))

    pendingRequests.clear()
    process.disconnect?.()
  }
}

let hasStarted = false

process.on('message', (message: ParentToWorkerMessage) => {
  if (!message || typeof message !== 'object')
    return

  if (message.type === 'bridge-response') {
    const pending = pendingRequests.get(message.requestId)
    if (!pending)
      return

    pendingRequests.delete(message.requestId)
    if (message.ok)
      pending.resolve(message.result)
    else
      pending.reject(hydrateWorkerError(message.error))
    return
  }

  if (message.type === 'evaluate' && !hasStarted) {
    hasStarted = true
    void runEvaluation(message.payload)
  }
})

process.on('disconnect', () => {
  for (const pending of pendingRequests.values())
    pending.reject(new Error('Sandbox worker lost its parent process'))
  pendingRequests.clear()
})

process.on('uncaughtException', (error) => {
  send({ type: 'error', error: serializeWorkerError(error) })
  process.exitCode = 1
})

process.on('unhandledRejection', (reason) => {
  send({ type: 'error', error: serializeWorkerError(reason) })
  process.exitCode = 1
})

send({ type: 'ready' })
