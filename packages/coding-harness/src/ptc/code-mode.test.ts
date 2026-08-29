import type { CodeModeTool, CodeRunFailureKind, CodeRunResult } from './code-mode'

import { describe, expect, it } from 'vitest'

import { createCodeModeRuntime } from './code-mode'

function echoTool(): CodeModeTool {
  return {
    name: 'echo',
    description: 'echoes its arguments',
    async run(args) {
      return args
    },
  }
}

function boomTool(): CodeModeTool {
  return {
    name: 'boom',
    description: 'throws',
    async run() {
      throw new Error('host exploded')
    },
  }
}

/** Expects a failed run and narrows `failure` for the following assertions. */
function expectFailure(result: CodeRunResult, kind: CodeRunFailureKind, messagePart?: string): void {
  expect(result.ok).toBe(false)
  if (result.ok)
    throw new Error('expected a failed run')
  expect(result.failure.kind).toBe(kind)
  if (messagePart)
    expect(result.failure.message).toContain(messagePart)
}

describe('code mode runtime', () => {
  const runtime = createCodeModeRuntime([echoTool(), boomTool()], { timeoutMs: 2_000 })

  it('runs a program and returns its value and logs', async () => {
    const result = await runtime.run(`
      log('computing', 1 + 1)
      return 2 + 2
    `)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(4)
      expect(result.traces).toEqual([])
      // inspect() renders strings with quotes, matching the MC semantics.
      expect(result.logs).toEqual(['\'computing\' 2'])
    }
  })

  it('lets the program call bridge capabilities', async () => {
    const result = await runtime.run(`
      const echoed = await bridge('echo', ['hello', { n: 1 }])
      return echoed
    `)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual(['hello', { n: 1 }])
      expect(result.traces[0]).toMatchObject({ toolName: 'echo', ok: true })
    }
  })

  it('reports unknown globals as runtime errors', async () => {
    const result = await runtime.run(`return seed.x + 1`)
    expectFailure(result, 'runtime', 'seed is not defined')
  })

  it('propagates bridge failures as runtime errors the program can catch', async () => {
    const caught = await runtime.run(`
      try {
        await bridge('boom', [])
        return 'no-error'
      }
      catch (error) {
        return 'caught:' + error.message
      }
    `)
    expect(caught.ok).toBe(true)
    if (caught.ok)
      expect(caught.value).toBe('caught:host exploded')

    const propagated = await runtime.run(`return await bridge('boom', [])`)
    expectFailure(propagated, 'runtime', 'host exploded')
  })

  it('rejects unknown tools', async () => {
    const result = await runtime.run(`return await bridge('nope', [])`)
    expectFailure(result, 'runtime', 'Unknown tool "nope"')
  })

  it('classifies syntax errors as parse', async () => {
    const result = await runtime.run(`return )`)
    expectFailure(result, 'parse')
  })

  it('classifies a runaway program as timeout', async () => {
    // Short bridge timeout keeps the runner's hard timeout (max(script+2s,
    // bridge+2s)) inside the vitest budget.
    const quickRuntime = createCodeModeRuntime([echoTool(), boomTool()], { timeoutMs: 2_000, bridgeTimeoutMs: 1_500 })
    const result = await quickRuntime.run(`while (true) {}`, { timeoutMs: 1_000 })
    expectFailure(result, 'timeout')
  })

  it('enforces the bridge call cap', async () => {
    const capped = createCodeModeRuntime([echoTool()], { maxBridgeCalls: 2, timeoutMs: 2_000 })
    const result = await capped.run(`
      await bridge('echo', [1])
      await bridge('echo', [2])
      await bridge('echo', [3])
      return 'never'
    `)
    expectFailure(result, 'bridge-limit')
  })
})
