import type { Tool } from '@xsai/shared-chat'
import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { ExecutableTool } from './tools'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'

import { useLlmToolsStore } from './tools'

const syncedContexts: Array<{
  pinia: ReturnType<typeof createPinia>
  runtime: SyncedPiniaRuntime
}> = []

function createSyncedContext(namespace: string, leadership: LeadershipMode, onError: (error: unknown) => void) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({
    callTimeout: 1_000,
    leadership,
    namespace,
    onError,
  })
  pinia.use(runtime.plugin)
  createApp({}).use(pinia)
  syncedContexts.push({ pinia, runtime })
  return { pinia, runtime }
}

afterEach(() => {
  for (const context of syncedContexts.splice(0)) {
    context.runtime.dispose()
    disposePinia(context.pinia)
  }
})

describe('llm tool synchronization', () => {
  it('keeps executable functions out of cross-window action arguments', async () => {
    const errors: unknown[] = []
    const namespace = `llm-tools:${crypto.randomUUID()}`
    const leaderContext = createSyncedContext(namespace, 'leader-only', error => errors.push(error))
    await vi.waitFor(() => expect(leaderContext.runtime.isLeader()).toBe(true))

    setActivePinia(leaderContext.pinia)
    const leaderStore = useLlmToolsStore()

    const followerContext = createSyncedContext(namespace, 'follower-only', error => errors.push(error))
    setActivePinia(followerContext.pinia)
    const followerStore = useLlmToolsStore()
    await vi.waitFor(() => expect(followerContext.runtime.getLeaderId()).toBe(leaderContext.runtime.participantId))

    const execute = vi.fn(async () => 'ok')
    const tool: ExecutableTool = {
      id: 'tamagotchi:image_journal',
      type: 'function',
      function: {
        name: 'image_journal',
        description: 'Create an image journal entry.',
        parameters: { type: 'object', properties: {} },
      },
      execute,
    }

    setActivePinia(followerContext.pinia)
    await followerStore.addTools(tool)
    await vi.waitFor(() => expect(leaderStore.tools.map(item => item.id)).toContain(tool.id))
    await vi.waitFor(() => expect(followerStore.tools.map(item => item.id)).toContain(tool.id))

    expect(errors).toEqual([])
    const registeredTool = followerStore.activeTools.find(item => item.function.name === tool.function.name)
    if (!registeredTool)
      throw new Error(`Tool ${tool.function.name} was not registered in the follower runtime.`)

    await expect(registeredTool.execute({}, {} as Parameters<Tool['execute']>[1])).resolves.toBe('ok')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
