import { describe, expect, it, vi } from 'vitest'

import { codeModeResultToText, codingTools } from './coding'

const { setWorkspaceRoot } = vi.hoisted(() => ({
  setWorkspaceRoot: vi.fn(async (root: string) => ({ status: 'switched' as const, workspaceRoot: root })),
}))

vi.mock('@proj-airi/stage-ui/stores/coding', () => ({
  useCodingToolsStore: () => ({ setWorkspaceRoot }),
}))

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

  it('exposes an explicit root switch for repositories outside the current root', async () => {
    const tools = await codingTools({ kind: 'powershell', label: 'Windows PowerShell', syntax: 'powershell' })
    const rootTool = tools.find(tool => tool.function.name === 'setWorkspaceRoot')

    expect(rootTool?.function.description).toContain('explicit absolute directory')
    const result = await rootTool?.execute?.({ root: 'D:\\airi' }, { abortSignal: undefined } as never)

    expect(setWorkspaceRoot).toHaveBeenCalledWith('D:\\airi')
    expect(result).toBe('{"status":"switched","workspaceRoot":"D:\\\\airi"}')
  })
})
