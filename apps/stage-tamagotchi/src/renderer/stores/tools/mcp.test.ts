import type { Tool } from '@xsai/shared-chat'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/toolset-prompts'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(async () => ({
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
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:list-tools-receive')
      return invokeMocks.listMcpTools
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:call-tool-receive')
      return invokeMocks.callMcpTool
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:get-runtime-status-receive')
      return invokeMocks.getRuntimeStatus

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
    invokeMocks.callMcpTool.mockClear()
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
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith({
      name: 'filesystem::search',
      arguments: { query: 'hello' },
    })
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
})
