import { describe, expect, it, vi } from 'vitest'

import { codeModeResultToText, codingTools } from './coding'

const { readFile, setWorkspaceRoot, writeFileIfUnchanged } = vi.hoisted(() => ({
  readFile: vi.fn(),
  setWorkspaceRoot: vi.fn(async (root: string) => ({ status: 'switched' as const, workspaceRoot: root })),
  writeFileIfUnchanged: vi.fn(),
}))

vi.mock('../../../bridges/coding-host', () => ({
  createCodingHostClient: () => ({ readFile, writeFileIfUnchanged }),
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
    // The root belongs to the user; a missing path must be reported, not
    // repaired by silently switching back (ACC-20260911 #14).
    expect(rootTool?.function.description).toContain('Do not switch the root')
    const result = await rootTool?.execute?.({ root: 'D:\\airi' }, { abortSignal: undefined } as never)

    expect(setWorkspaceRoot).toHaveBeenCalledWith('D:\\airi')
    expect(result).toBe('{"status":"switched","workspaceRoot":"D:\\\\airi"}')
  })

  it('does not write when a Flow is interrupted while preparing a diff', async () => {
    readFile.mockReset()
    writeFileIfUnchanged.mockReset()
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    readFile.mockImplementationOnce(async () => {
      await readGate
      return { content: 'before\n' }
    })

    const tools = await codingTools({ kind: 'powershell', label: 'Windows PowerShell', syntax: 'powershell' })
    const write = tools.find(tool => tool.function.name === 'write')
    expect(write?.execute).toBeDefined()
    const controller = new AbortController()
    const pending = write!.execute!({ path: 'marker.txt', content: 'after\n', baseHash: 'before-hash' }, {
      messages: [],
      toolCallId: 'interrupted-write',
      abortSignal: controller.signal,
    })

    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce())
    controller.abort()
    releaseRead()

    await expect(pending).resolves.toContain('flow_interrupted')
    expect(writeFileIfUnchanged).not.toHaveBeenCalled()
  })
})
