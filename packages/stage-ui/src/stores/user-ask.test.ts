import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useJournalStore } from './journal'
import { useUserAskStore } from './user-ask'

describe('user ask store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('raises the question, resolves on answer, and journals both sides', async () => {
    const store = useUserAskStore()
    const pending = store.ask('Which file name?', ['a.md', 'b.md'])

    expect(store.pending?.question).toBe('Which file name?')
    expect(store.pending?.choices).toEqual(['a.md', 'b.md'])

    store.answer({ requestId: store.pending!.requestId, answer: 'a.md', channel: 'choice' })
    const answer = await pending

    expect(answer.answer).toBe('a.md')
    expect(store.pending).toBeUndefined()

    const types = useJournalStore().events.map(event => event.type)
    expect(types).toContain('user/asked')
    expect(types).toContain('user/answered')
  })

  it('resolves dismissed questions with an empty answer', async () => {
    const store = useUserAskStore()
    const pending = store.ask('Continue anyway?')

    store.dismiss(store.pending!.requestId)
    const answer = await pending

    expect(answer.channel).toBe('dismissed')
    expect(answer.answer).toBe('')
    expect(store.pending).toBeUndefined()
  })

  it('ignores answers for stale requests', async () => {
    const store = useUserAskStore()
    const first = store.ask('First?')
    const firstRequestId = store.pending!.requestId

    store.answer({ requestId: firstRequestId, answer: 'yes', channel: 'text' })
    await first
    expect(store.pending).toBeUndefined()

    store.answer({ requestId: firstRequestId, answer: 'stale', channel: 'text' })
    expect(store.pending).toBeUndefined()
  })
})
