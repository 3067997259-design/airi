import type { ChatProvider } from '@xsai-ext/providers/utils'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { streamFromMock } = vi.hoisted(() => ({ streamFromMock: vi.fn() }))

vi.mock('@proj-airi/core-agent', async importOriginal => ({
  ...(await importOriginal<typeof import('@proj-airi/core-agent')>()),
  streamFrom: streamFromMock,
}))

const provider = { chat: () => ({ baseURL: 'https://example.com/' }) } as unknown as ChatProvider

describe('btw side channel', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    streamFromMock.mockReset()
    const { useJournalStore } = await import('./journal')
    useJournalStore().ensureSession('btw-session')
  })

  it('answers from a bounded work projection and never touches the chat session', async () => {
    const { useJournalStore } = await import('./journal')
    const { useTodoStore } = await import('./todos')
    const { useBtwStore } = await import('./btw')

    const journal = useJournalStore()
    useTodoStore().write([{ content: 'fix the parser', status: 'in_progress' }])
    for (let index = 0; index < 12; index++) {
      journal.appendActive({
        type: 'tool/result',
        toolName: `tool-${index}`,
        ok: true,
        summary: `result ${index}`,
      })
    }

    streamFromMock.mockImplementation(async ({ options }: { options?: { onStreamEvent?: (event: unknown) => void } }) => {
      options?.onStreamEvent?.({ type: 'text-delta', text: 'still on the parser' })
    })

    const store = useBtwStore()
    const answer = await store.ask({ question: 'how is it going?', model: 'gpt-test', chatProvider: provider, persona: 'You are AIRI.' })

    expect(answer).toBe('still on the parser')
    expect(store.state.status).toBe('answered')
    expect(store.state.exchanges).toHaveLength(1)

    const messages = streamFromMock.mock.calls[0]?.[0]?.messages as Array<{ role: string, content: string }>
    const system = messages[0].content
    // Bounded: only the recent tail of the tool activity, never the whole run.
    expect(system).toContain('tool-11')
    expect(system).not.toContain('tool-0 ')
    expect(system).toContain('[in_progress] fix the parser')
    // No tools in the side channel: it describes, it never acts.
    expect(streamFromMock.mock.calls[0]?.[0]?.options?.tools).toBeUndefined()
  })

  it('reports a failed answer without losing earlier exchanges', async () => {
    const { useBtwStore } = await import('./btw')
    streamFromMock.mockImplementationOnce(async ({ options }: { options?: { onStreamEvent?: (event: unknown) => void } }) => {
      options?.onStreamEvent?.({ type: 'text-delta', text: 'first answer' })
    })
    const store = useBtwStore()
    await store.ask({ question: 'first?', model: 'gpt-test', chatProvider: provider })

    streamFromMock.mockRejectedValueOnce(new Error('provider refused'))
    await store.ask({ question: 'second?', model: 'gpt-test', chatProvider: provider })

    expect(store.state.status).toBe('failed')
    expect(store.state.error).toBe('provider refused')
    expect(store.state.exchanges).toHaveLength(1)
  })

  it('raises a non-blocking question and records the later answer', async () => {
    const { useBtwStore } = await import('./btw')
    const { useJournalStore } = await import('./journal')
    const store = useBtwStore()
    const requestId = store.askUser('Which file should I change?', ['a.ts', 'b.ts'])

    expect(requestId).toBeTruthy()
    expect(store.state.pendingUserQuestion).toMatchObject({ question: 'Which file should I change?' })
    store.answerUser(requestId, 'a.ts', 'choice')

    expect(store.state.pendingUserQuestion).toBeUndefined()
    expect(useJournalStore().events).toContainEqual(expect.objectContaining({ type: 'user/asked', source: 'btw' }))
    expect(useJournalStore().events).toContainEqual(expect.objectContaining({ type: 'user/answered', source: 'btw', answer: 'a.ts' }))
  })
})
