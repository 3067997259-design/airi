import { describe, expect, it } from 'vitest'

import { codeModeResultToText } from './coding'

describe('codeModeResultToText', () => {
  it('flattens a successful run with value, logs, and traces', () => {
    const text = codeModeResultToText({
      ok: true,
      value: { status: 'written' },
      logs: ['step one done'],
      traces: [
        { toolName: 'read', args: ['a.ts'], ok: true, resultSummary: '12 lines' },
        { toolName: 'write', args: ['a.ts'], ok: true, resultSummary: '{"status":"written"}' },
      ],
    })

    expect(text).toContain('program finished, 2 tool call(s)')
    expect(text).toContain('return: {"status":"written"}')
    expect(text).toContain('log: step one done')
    expect(text).toContain('ok read -> 12 lines')
  })

  it('keeps the failure kind, message, and partial traces visible', () => {
    const text = codeModeResultToText({
      ok: false,
      failure: {
        kind: 'timeout',
        message: 'program exceeded 10000ms',
        logs: ['partial log'],
        traces: [{ toolName: 'read', args: ['a.ts'], ok: true, resultSummary: '12 lines' }],
      },
    })

    expect(text).toContain('program failed (timeout): program exceeded 10000ms')
    expect(text).toContain('log: partial log')
    expect(text).toContain('ok read -> 12 lines')
  })
})
