import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { executeUserAsk } from './user-ask'

describe('user_ask executor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns the user answer as the tool result', async () => {
    const pending = executeUserAsk({ question: 'Which name?', choices: ['a.md', 'b.md'] })
    const { useUserAskStore } = await import('@proj-airi/stage-ui/stores/user-ask')
    const store = useUserAskStore()

    store.answer({ requestId: store.pending!.requestId, answer: 'a.md', channel: 'choice' })
    const result = await pending

    expect(result).toContain('"a.md"')
  })

  it('tells the model to state its assumption when the card is dismissed', async () => {
    const pending = executeUserAsk({ question: 'Continue anyway?' })
    const { useUserAskStore } = await import('@proj-airi/stage-ui/stores/user-ask')
    const store = useUserAskStore()

    store.dismiss(store.pending!.requestId)
    const result = await pending

    expect(result).toContain('dismissed')
    expect(result).toContain('assumption')
  })
})
