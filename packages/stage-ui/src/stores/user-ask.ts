import { defineStore } from 'pinia'
import { ref } from 'vue'

import { useJournalStore } from './journal'

export interface UserAskRequest {
  requestId: string
  question: string
  choices?: string[]
}

export interface UserAskAnswer {
  requestId: string
  answer: string
  /** How the answer arrived: a card choice, free text, or dismissed. */
  channel: 'choice' | 'text' | 'dismissed'
}

type Resolver = (answer: UserAskAnswer) => void

/**
 * In-flight user question raised by the `user_ask` tool (COMMAND-PLAN §3.2).
 *
 * The plan/tool loop runs in the synchronized leader; the conversation lives
 * in other windows. The pending question rides the synced store so every
 * window renders the card, and `answer` is a leader-routed action: it
 * resolves the awaiting tool call in the leader and journals the exchange.
 * Dismissing the card resolves with a "no answer" result so the tool can
 * continue under its own assumptions instead of hanging.
 */
export const useUserAskStore = defineStore('runtime-user-ask', () => {
  const journal = useJournalStore()
  const pending = ref<UserAskRequest>()
  const resolvers = new Map<string, Resolver>()

  function createRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `user-ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }

  /** Leader-side: raises the question and resolves when the user answers or dismisses. */
  async function ask(question: string, choices?: string[]): Promise<UserAskAnswer> {
    const requestId = createRequestId()
    const promise = new Promise<UserAskAnswer>((resolve) => {
      resolvers.set(requestId, resolve)
    })
    pending.value = { requestId, question, ...(choices?.length ? { choices } : {}) }
    journal.appendActive({
      type: 'user/asked',
      requestId,
      question,
      ...(choices?.length ? { choices } : {}),
    })
    const answer = await promise
    journal.appendActive({
      type: 'user/answered',
      requestId,
      answer: answer.answer,
      channel: answer.channel,
    })
    return answer
  }

  /** Any window: answers the pending question (leader-routed action). */
  function answer(answer: UserAskAnswer): void {
    if (!pending.value || pending.value.requestId !== answer.requestId)
      return
    pending.value = undefined
    const resolver = resolvers.get(answer.requestId)
    resolvers.delete(answer.requestId)
    resolver?.(answer)
  }

  /** Any window: dismisses the card; the tool continues without an answer. */
  function dismiss(requestId: string): void {
    answer({ requestId, answer: '', channel: 'dismissed' })
  }

  function reset() {
    pending.value = undefined
    resolvers.clear()
  }

  return {
    pending,
    ask,
    answer,
    dismiss,
    reset,
  }
}, {
  synced: {
    actions: ['ask', 'answer', 'dismiss'],
    state: true,
  },
})
