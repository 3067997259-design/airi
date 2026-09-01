import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Tool } from '@xsai/shared-chat'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamFromMock } = vi.hoisted(() => ({ streamFromMock: vi.fn() }))

vi.mock('@proj-airi/core-agent', async importOriginal => ({
  ...(await importOriginal<typeof import('@proj-airi/core-agent')>()),
  streamFrom: streamFromMock,
}))

const provider = { chat: () => ({ baseURL: 'https://example.com/' }) } as unknown as ChatProvider

function fakeTool(name: string): Tool {
  return { type: 'function', function: { name, parameters: { type: 'object', properties: {} } } } as unknown as Tool
}

describe('delegation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    streamFromMock.mockReset()
  })

  it('runs the child in its own context and returns only its report', async () => {
    const { useDelegationStore } = await import('./delegation')
    streamFromMock.mockImplementation(async ({ options }: { options?: { onStreamEvent?: (event: unknown) => void } }) => {
      options?.onStreamEvent?.({ type: 'text-delta', text: 'found it in src/a.ts:12' })
    })

    const store = useDelegationStore()
    const report = await store.delegate({
      objective: 'where is the gate evaluated?',
      model: 'gpt-test',
      chatProvider: provider,
      tools: [fakeTool('grep'), fakeTool('read')],
    })

    expect(report).toBe('found it in src/a.ts:12')
    const call = streamFromMock.mock.calls[0]?.[0]
    // Its own message list: the parent transcript never enters the child.
    expect(call.messages).toHaveLength(2)
    expect(call.messages[1]).toEqual({ role: 'user', content: 'where is the gate evaluated?' })
    // Read-only by construction, and bounded so a search cannot run forever.
    expect(call.options.tools.map((tool: Tool) => tool.function.name)).toEqual(['grep', 'read'])
    expect(call.options.maxSteps).toBe(12)
  })

  it('reports a failed run as text instead of throwing into the parent turn', async () => {
    const { useDelegationStore } = await import('./delegation')
    streamFromMock.mockRejectedValueOnce(new Error('provider refused'))

    const store = useDelegationStore()
    const report = await store.delegate({
      objective: 'anything',
      model: 'gpt-test',
      chatProvider: provider,
      tools: [],
    })

    expect(report).toBe('delegation failed: provider refused')
    expect(store.state.running).toBe(0)
  })
})
