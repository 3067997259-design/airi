/**
 * PTC sandbox protocol (CODING-HARNESS-DESIGN §3).
 *
 * The shared, generic half of the minecraft `js-planner` sandbox: a forked
 * worker runs the model-written program; the worker may only request
 * host capabilities through `bridge-request` envelopes and the parent
 * decides each call (`capability-mediated bridge`). Payload types are
 * intentionally neutral — the minecraft copy keeps its MC-typed runtime
 * snapshot; everything here is transport.
 */

export interface SandboxRunPayload {
  script: string
  timeoutMs: number
  memoryLimitMb: number
  /** Capability names the program may call through `bridge`. */
  bridgeToolNames: string[]
  /** Plain-data globals injected into the program's context. */
  globals?: Record<string, unknown>
}

export interface SandboxRunResult {
  logs: string[]
  returnRaw?: unknown
}

export interface SandboxWorkerState {
  logs: string[]
}

export interface SerializedWorkerError {
  message: string
  name: string
  stack?: string
}

export type WorkerToParentMessage
  = | { type: 'ready' }
    | { type: 'bridge-request', requestId: number, method: string, args: unknown[] }
    | { type: 'result', result: SandboxRunResult }
    | { type: 'error', error: SerializedWorkerError, state?: SandboxWorkerState }
    | { type: 'catastrophic-error', error: SerializedWorkerError }

export type ParentToWorkerMessage
  = | { type: 'evaluate', payload: SandboxRunPayload }
    | { type: 'bridge-response', requestId: number, ok: true, result?: unknown }
    | { type: 'bridge-response', requestId: number, ok: false, error: SerializedWorkerError }

function workerErrorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string')
    return error.name
  if (error instanceof Error)
    return error.name
  return 'Error'
}

function workerErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    return error.message
  if (error instanceof Error)
    return error.message
  return String(error)
}

function workerErrorStack(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'stack' in error && typeof error.stack === 'string')
    return error.stack
  if (error instanceof Error)
    return error.stack
  return undefined
}

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  const stack = workerErrorStack(error)
  return stack
    ? {
        message: workerErrorMessage(error),
        name: workerErrorName(error),
        stack,
      }
    : {
        message: workerErrorMessage(error),
        name: workerErrorName(error),
      }
}

export function hydrateWorkerError(error: SerializedWorkerError): Error {
  const hydrated = new Error(error.message)
  hydrated.name = error.name
  if (error.stack)
    hydrated.stack = error.stack
  return hydrated
}

export function createWorkerError(message: string, state?: SandboxWorkerState, cause?: unknown): Error & { state?: SandboxWorkerState } {
  const error = cause instanceof Error ? cause : new Error(message)
  error.message = message
  return Object.assign(error, state ? { state } : {})
}
