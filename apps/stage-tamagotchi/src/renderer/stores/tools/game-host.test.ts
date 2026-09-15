import type { Tool } from '@xsai/shared-chat'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMocks = vi.hoisted(() => ({
  listDomainTools: vi.fn(async () => [
    { name: 'game_observe', action: 'observe', description: 'Observe.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'game_move_to', action: 'move_to', description: 'Move.', parameters: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false } },
    { name: 'game_status', action: 'status', description: 'Status.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'game_cancel', action: 'cancel', description: 'Cancel.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  ]),
  executeCommand: vi.fn(async (_payload: { requestId: string, action: string, params: Record<string, unknown> }) => ({ status: 'ok', checked: true, commandId: 'req-1', endReason: 'observed', postCondition: { kind: 'none', target: 0, actual: 0, met: true } })),
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:game-host:domain-tools-receive')
      return invokeMocks.listDomainTools
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:game-host:execute-receive')
      return invokeMocks.executeCommand

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

describe('useTamagotchiGameHostToolsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMocks.listDomainTools.mockClear()
    invokeMocks.executeCommand.mockClear()
  })

  it('registers the four domain tools as game_adapter entries', async () => {
    const { useTamagotchiGameHostToolsStore } = await import('./game-host')
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiGameHostToolsStore()

    await store.refresh()

    expect(llmToolsStore.tools.map(tool => tool.id).sort()).toEqual([
      'game:game-host:game_cancel',
      'game:game-host:game_move_to',
      'game:game-host:game_observe',
      'game:game-host:game_status',
    ])
    expect(llmToolsStore.registrations).toHaveLength(4)
    expect(llmToolsStore.registrations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ownerKind: 'game_adapter',
        ownerId: 'game-host',
        execution: { kind: 'remote', chain: ['game-adapter', 'game-host'] },
      }),
    ]))
    expect(JSON.stringify(llmToolsStore.$state)).not.toContain('execute')
  })

  it('forwards one execution with a correlation id and the active session', async () => {
    const { useTamagotchiGameHostToolsStore } = await import('./game-host')
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiGameHostToolsStore()
    await store.refresh()

    const tool = llmToolsStore.activeTools.find(candidate => candidate.function.name === 'game_observe')
    await tool?.execute({ radius: 8 }, {} as Parameters<Tool['execute']>[1])

    expect(invokeMocks.executeCommand).toHaveBeenCalledTimes(1)
    const payload = invokeMocks.executeCommand.mock.calls[0]?.[0] as { requestId: string, action: string, params: Record<string, unknown> }
    expect(payload.action).toBe('observe')
    expect(payload.params).toEqual({ radius: 8 })
    expect(payload.requestId).toBeTypeOf('string')

    await store.dispose()
    expect(llmToolsStore.tools).toHaveLength(0)
    expect(llmToolsStore.registrations).toHaveLength(0)
  })

  // 2026-09-12: after an app reload, the leader's single boot refresh could
  // race the game host RPC channel and observe an empty descriptor list. The
  // game tools then stayed off the face for the whole session while the
  // bridge was healthy. Discovery now retries until the static list arrives.
  it('retries discovery after an empty listing and registers the tools', async () => {
    vi.useFakeTimers()
    try {
      invokeMocks.listDomainTools.mockResolvedValueOnce([])
      const { useTamagotchiGameHostToolsStore } = await import('./game-host')
      const llmToolsStore = useLlmToolsStore()
      const store = useTamagotchiGameHostToolsStore()

      await store.refresh()
      expect(llmToolsStore.tools).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(llmToolsStore.tools.map(tool => tool.id).sort()).toEqual([
        'game:game-host:game_cancel',
        'game:game-host:game_move_to',
        'game:game-host:game_observe',
        'game:game-host:game_status',
      ])
      expect(llmToolsStore.registrations).toHaveLength(4)

      await store.dispose()
    }
    finally {
      vi.useRealTimers()
    }
  })

  // 2026-09-12: after an app reload the first discovery invoke could stick
  // forever behind an unready main-process channel, so the retry after the
  // await never armed and game tools stayed missing. The retry is armed
  // before the await; a hung pass must still be followed by a fresh one.
  it('retries discovery when the first listing never settles', async () => {
    vi.useFakeTimers()
    try {
      invokeMocks.listDomainTools.mockImplementationOnce(() => new Promise(() => {}))
      const { useTamagotchiGameHostToolsStore } = await import('./game-host')
      const llmToolsStore = useLlmToolsStore()
      const store = useTamagotchiGameHostToolsStore()

      void store.refresh()
      await vi.advanceTimersByTimeAsync(0)
      expect(llmToolsStore.tools).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(2_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(llmToolsStore.tools).toHaveLength(4)
      expect(llmToolsStore.registrations).toHaveLength(4)

      await store.dispose()
    }
    finally {
      vi.useRealTimers()
    }
  })
})
