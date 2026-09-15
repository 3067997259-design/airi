import type { Tool } from '@xsai/shared-chat'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(async (_payload: { requestId?: string, name: string, arguments?: Record<string, unknown> }) => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  })),
  listMcpTools: vi.fn(async () => [{
    serverName: 'filesystem',
    name: 'filesystem::search',
    toolName: 'search',
    description: 'Search files.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
  }]),
  getRuntimeStatus: vi.fn(async () => ({
    path: 'C:\\mcp.json',
    updatedAt: 1,
    servers: [
      {
        name: 'filesystem',
        state: 'running',
        command: 'node',
        args: [],
        pid: 1,
        instructions: 'Present every search result to the user before acting on it.',
      },
    ],
  })),
  cancelMcpTool: vi.fn(async (_payload: { requestId: string }) => ({ cancelled: true })),
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:list-tools-receive')
      return invokeMocks.listMcpTools
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:call-tool-receive')
      return invokeMocks.callMcpTool
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:get-runtime-status-receive')
      return invokeMocks.getRuntimeStatus
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:cancel-tool-receive')
      return invokeMocks.cancelMcpTool

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

describe('useTamagotchiMcpToolsStore', async () => {
  const { useTamagotchiMcpToolsStore } = await import('./mcp')

  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMocks.listMcpTools.mockReset()
    invokeMocks.listMcpTools.mockResolvedValue([{
      serverName: 'filesystem',
      name: 'filesystem::search',
      toolName: 'search',
      description: 'Search files.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    }])
    invokeMocks.getRuntimeStatus.mockReset()
    invokeMocks.getRuntimeStatus.mockResolvedValue({
      path: 'C:\\mcp.json',
      updatedAt: 1,
      servers: [
        {
          name: 'filesystem',
          state: 'running',
          command: 'node',
          args: [],
          pid: 1,
          instructions: 'Present every search result to the user before acting on it.',
        },
      ],
    })
    invokeMocks.callMcpTool.mockClear()
    invokeMocks.cancelMcpTool.mockClear()
  })

  it('registers one native tool per MCP descriptor and forwards qualified names with object arguments', async () => {
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()
    const toolOptions = {} as Parameters<Tool['execute']>[1]

    await store.refresh()

    const mcpDefinitions = llmToolsStore.tools.filter(tool => tool.id.startsWith('mcp:'))
    expect(mcpDefinitions).toEqual([
      expect.objectContaining({
        id: 'mcp:mcp_filesystem_search',
        function: expect.objectContaining({ name: 'mcp_filesystem_search' }),
      }),
    ])
    expect(JSON.stringify(llmToolsStore.$state)).not.toContain('execute')

    const nativeTool = llmToolsStore.activeTools.find(tool => tool.function.name === 'mcp_filesystem_search')
    const result = await nativeTool?.execute({ query: 'hello' }, toolOptions)

    expect(invokeMocks.listMcpTools).toHaveBeenCalledTimes(1)
    expect(invokeMocks.callMcpTool.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      name: 'filesystem::search',
      arguments: { query: 'hello' },
    }))
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })

    // The toolset prompt teaches the model the mcp_* naming convention and
    // carries the server-declared instructions from the MCP handshake.
    const toolsetPromptsStore = useLlmToolsetPromptsStore()
    expect(toolsetPromptsStore.activeToolsetPrompt).toContain('MCP Servers')
    expect(toolsetPromptsStore.activeToolsetPrompt).toContain('filesystem')
    expect(toolsetPromptsStore.activeToolsetPrompt).toContain('mcp_<server>_<tool>')
    expect(toolsetPromptsStore.activeToolsetPrompt).toContain('[filesystem] Present every search result to the user before acting on it.')

    store.dispose()

    expect(llmToolsStore.tools.filter(tool => tool.id.startsWith('mcp:'))).toEqual([])
    expect(toolsetPromptsStore.activeToolsetPrompt).toBe('')
  })

  it('sends a cancel invoke with the same request id when the call is aborted', async () => {
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()
    const controller = new AbortController()
    let capturedRequestId: string | undefined
    invokeMocks.callMcpTool.mockImplementation(async (payload) => {
      capturedRequestId = payload.requestId
      return await new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })

    await store.refresh()
    const nativeTool = llmToolsStore.activeTools.find(tool => tool.function.name === 'mcp_filesystem_search')
    const pending = nativeTool!.execute({ query: 'slow' }, { abortSignal: controller.signal } as Parameters<Tool['execute']>[1])
    controller.abort()

    await expect(pending).rejects.toThrow('aborted')
    expect(capturedRequestId).toBeTypeOf('string')
    expect(invokeMocks.cancelMcpTool).toHaveBeenCalledWith({ requestId: capturedRequestId })
  })

  it('falls back to the proxy meta-tools when no MCP tools are discovered', async () => {
    invokeMocks.listMcpTools.mockResolvedValue([])
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()

    await store.refresh()

    const names = llmToolsStore.tools
      .filter(tool => tool.id.startsWith('mcp:'))
      .map(tool => tool.function.name)
      .sort()
    expect(names).toEqual(['builtIn_mcpCallTool', 'builtIn_mcpListTools'])
    expect(useLlmToolsetPromptsStore().activeToolsetPrompt).toContain('builtIn_mcpListTools')
  })

  it('falls back to the proxy meta-tools when listing fails', async () => {
    invokeMocks.listMcpTools.mockRejectedValue(new Error('IPC failure'))
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()

    await store.refresh()

    const names = llmToolsStore.tools
      .filter(tool => tool.id.startsWith('mcp:'))
      .map(tool => tool.function.name)
      .sort()
    expect(names).toEqual(['builtIn_mcpCallTool', 'builtIn_mcpListTools'])
  })

  it('exposes no mcp tools when no server is configured', async () => {
    // ROOT CAUSE:
    //
    // With no configured server the proxy tools can reach nothing, but they
    // were still registered. The model then used builtIn_mcpListTools as a
    // generic "find a tool" entry to search for a self-authored skill and
    // silently failed (ACC-20260910 R05).
    invokeMocks.listMcpTools.mockResolvedValue([])
    invokeMocks.getRuntimeStatus.mockResolvedValue({ path: 'C:\\mcp.json', updatedAt: 1, servers: [] })
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()

    await store.refresh()

    expect(llmToolsStore.tools.filter(tool => tool.id.startsWith('mcp:'))).toEqual([])
    expect(useLlmToolsetPromptsStore().activeToolsetPrompt).not.toContain('builtIn_mcp')
  })
})
