/**
 * Code Mode SDK (CODING-HARNESS-DESIGN §3.2).
 *
 * Mirrors dsh's `ctx.codeRuntime` shape: run a model-written program against
 * a fixed set of named host bindings, report `{ value, logs, error? }`, and
 * classify every failure with an orthogonal kind. Each `bridge` call inside
 * the program is one tool dispatch; the caller's journal records one
 * `tool/call` + `tool/result` pair per dispatch (§3.2 evidence granularity).
 */
import type { SandboxRunPayload } from './protocol'

import { errorMessageFrom } from '@moeru/std'

import { executeSandboxedProgram } from './runner'

export interface CodeModeTool {
  name: string
  description: string
  run: (args: unknown[]) => Promise<unknown>
}

export type CodeRunFailureKind = 'parse' | 'runtime' | 'timeout' | 'bridge-limit' | 'bridge' | 'sandbox'

export interface CodeRunFailure {
  kind: CodeRunFailureKind
  message: string
  logs: string[]
  traces: CodeModeBridgeTrace[]
}

/** One capability-mediated call made by a Code Mode program. */
export interface CodeModeBridgeTrace {
  toolName: string
  args: unknown[]
  ok: boolean
  resultSummary: string
}

export type CodeRunResult
  = | { ok: true, value?: unknown, logs: string[], traces: CodeModeBridgeTrace[] }
    | { ok: false, failure: CodeRunFailure }

export interface CodeModeRuntime {
  run: (program: string, overrides?: { timeoutMs?: number }) => Promise<CodeRunResult>
}

export interface CodeModeRuntimeOptions {
  timeoutMs?: number
  memoryLimitMb?: number
  bridgeTimeoutMs?: number
  maxBridgeCalls?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MEMORY_LIMIT_MB = 256
const DEFAULT_BRIDGE_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BRIDGE_CALLS = 100

export function createCodeModeRuntime(
  tools: CodeModeTool[],
  options: CodeModeRuntimeOptions = {},
): CodeModeRuntime {
  const toolByName = new Map(tools.map(tool => [tool.name, tool]))

  const run = async (program: string, overrides: { timeoutMs?: number } = {}): Promise<CodeRunResult> => {
    const timeoutMs = overrides.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const payload: SandboxRunPayload = {
      script: program,
      timeoutMs,
      memoryLimitMb: options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB,
      bridgeToolNames: tools.map(tool => tool.name),
    }

    const traces: CodeModeBridgeTrace[] = []
    try {
      const result = await executeSandboxedProgram(payload, {
        bridgeTimeoutMs: options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
        maxBridgeCalls: options.maxBridgeCalls ?? DEFAULT_MAX_BRIDGE_CALLS,
        onBridgeRequest: async (method, args) => {
          const tool = toolByName.get(method)
          if (!tool)
            throw new Error(`Unknown tool "${method}" requested by program`)
          try {
            const value = await tool.run(args)
            traces.push({
              toolName: method,
              args: structuredClone(args),
              ok: true,
              resultSummary: summarizeBridgeResult(value),
            })
            return value
          }
          catch (error) {
            traces.push({
              toolName: method,
              args: structuredClone(args),
              ok: false,
              resultSummary: errorMessageFrom(error) ?? 'Bridge call failed',
            })
            throw error
          }
        },
      })
      return { ok: true, value: result.returnRaw, logs: result.logs, traces }
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Unknown program failure'
      const state = isRecord(error) ? error.state : undefined
      const logs = isRecord(state) && Array.isArray(state.logs) ? state.logs : []
      return {
        ok: false,
        failure: {
          kind: classifyFailure(error),
          message,
          logs,
          traces,
        },
      }
    }
  }

  return { run }
}

function summarizeBridgeResult(value: unknown): string {
  if (typeof value === 'string')
    return value.slice(0, 500)

  try {
    return JSON.stringify(value ?? '').slice(0, 500)
  }
  catch {
    return '[unserializable bridge result]'
  }
}

function classifyFailure(error: unknown): CodeRunFailureKind {
  const message = errorMessageFrom(error) ?? ''
  const name = error instanceof Error ? error.name : ''

  if (message.includes('bridge call limit exceeded'))
    return 'bridge-limit'
  // The bridge timeout message contains 'timed out' too, so it must win over
  // the generic timeout classification below.
  if (message.includes('Sandbox bridge timed out'))
    return 'bridge'
  if (message.includes('timed out'))
    return 'timeout'
  if (message.includes('Sandbox worker'))
    return 'sandbox'
  if (name === 'SyntaxError')
    return 'parse'
  // Anything else thrown by the program itself is a runtime error; the
  // worker serializes the original name, so 'ReferenceError' etc. land here.
  return 'runtime'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
