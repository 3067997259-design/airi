import type { CharacterSparkNotifyReaction } from '../../../../stores/character'
import type { AttentionTask } from '../../../../stores/tasks'
import type { ChatHistoryItem } from '../../../../types/chat'

import en from '@proj-airi/i18n/locales/en'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { createI18n } from 'vue-i18n'

import ChatHistory from './history.vue'

import { getChatHistoryItemKey } from '../utils'

function createEnglishI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en },
  })
}

describe('chat history', () => {
  // ROOT CAUSE:
  //
  // Rendering every message keeps every backdrop-filter surface alive, even when
  // most of the history is outside the viewport. Long histories then cost more to
  // lay out and composite during fast mobile scrolling.
  //
  // We virtualize the history and mount only the viewport plus a small overscan area.
  it('virtualizes long histories and reveals messages inside the viewport', async () => {
    const messages: ChatHistoryItem[] = Array.from({ length: 100 }, (_, index) => ({
      id: `user-${index}`,
      role: 'user',
      content: `Message ${index} `.repeat(index % 6 + 1),
      createdAt: index,
    }))

    const screen = await render(ChatHistory, {
      props: {
        messages,
        variant: 'mobile',
        style: 'height: 240px; width: 320px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    await vi.waitFor(() => {
      const renderedMessages = screen.container.querySelectorAll('.chat-message-item')
      expect(renderedMessages.length).toBeGreaterThan(0)
      expect(renderedMessages.length).toBeLessThan(messages.length)
      expect(screen.container.textContent).toContain('Message 99')
    })

    await vi.waitFor(() => {
      const visibleMessages = screen.container.querySelectorAll('.chat-message-item-visible')
      const hiddenMessages = screen.container.querySelectorAll('.chat-message-item:not(.chat-message-item-visible)')

      expect(visibleMessages.length).toBeGreaterThan(0)
      expect(hiddenMessages.length).toBeGreaterThan(0)
      expect(visibleMessages[0].classList.contains('opacity-100')).toBe(true)
      expect(visibleMessages[0].classList.contains('transition-opacity')).toBe(true)
      expect(hiddenMessages[0].classList.contains('opacity-0')).toBe(true)
    })

    const history = screen.container.querySelector<HTMLElement>('.chat-history-list')
    expect(history).not.toBeNull()
    if (!history)
      throw new Error('Expected a chat history viewport.')

    history.scrollTop = 0
    history.dispatchEvent(new Event('scroll'))

    await vi.waitFor(() => {
      expect(screen.container.textContent).toContain('Message 0')
    })
  })

  it('keeps a stable mask on each mobile message container', async () => {
    const screen = await render(ChatHistory, {
      props: {
        messages: [{ role: 'user', content: 'hello' }],
        variant: 'mobile',
        style: 'height: 240px; width: 320px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    await vi.waitFor(() => {
      expect(screen.container.querySelector('.chat-message-item-container')).not.toBeNull()
    })

    const messageContainer = screen.container.querySelector<HTMLElement>('.chat-message-item-container')
    expect(messageContainer).not.toBeNull()
    if (!messageContainer)
      throw new Error('Expected a mobile chat message container.')

    expect(getComputedStyle(messageContainer).maskImage).not.toBe('none')
    await vi.waitFor(() => {
      expect(messageContainer.closest('.chat-message-item-visible')).not.toBeNull()
    })
  })

  // ROOT CAUSE:
  //
  // Cross-window synchronization can publish `sending` before it publishes the new stream.
  // The initial stream object has a timestamp but no message id, which rendered a short-lived bubble.
  //
  // We fixed this by rendering only a stream that has the stable id assigned to the assistant turn.
  it('does not render the initial empty stream while a synchronized send starts', async () => {
    const screen = await render(ChatHistory, {
      props: {
        messages: [],
        sending: true,
        streamingMessage: {
          role: 'assistant',
          content: '',
          slices: [],
          tool_results: [],
          createdAt: 1710000000000,
        },
        style: 'height: 240px; width: 320px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    expect(screen.container.querySelectorAll('.chat-message-item')).toHaveLength(0)
  })

  it('renders reactions and task cards beside chat messages', async () => {
    const reaction: CharacterSparkNotifyReaction = {
      id: 'reaction-1',
      message: 'The build needs attention.',
      createdAt: 2,
      sourceEventId: 'spark-1',
    }
    const task: AttentionTask = {
      taskId: 'task-1',
      goal: 'Watch the build',
      kind: 'ci',
      status: 'blocked',
      memory: {
        status: 'blocked',
        goal: 'Watch the build',
        currentStep: 'Read the failure',
        confirmedFacts: [],
        artifacts: [],
        blockers: ['The lint job failed'],
        nextStep: 'Choose whether to retry',
        updatedAt: 3,
        sourceTurnId: 'turn-1',
      },
      startedAt: 1,
      updatedAt: 3,
      needsInput: 'Choose whether to retry',
      sourceEventId: 'task-event-1',
    }

    const screen = await render(ChatHistory, {
      props: {
        messages: [{ role: 'user', content: 'Keep working.' }],
        reactions: [reaction],
        tasks: [task],
        style: 'height: 480px; width: 480px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    await vi.waitFor(() => {
      expect(screen.container.querySelector('[data-testid="chat-reaction-line"]')).not.toBeNull()
      expect(screen.container.querySelector('[data-testid="chat-task-card"]')).not.toBeNull()
    })

    expect(screen.container.textContent).toContain('The build needs attention.')
    expect(screen.container.textContent).toContain('Choose whether to retry')
  })

  it('opens an existing task card when the task becomes blocked', async () => {
    const activeTask: AttentionTask = {
      taskId: 'task-transition',
      goal: 'Watch the build',
      kind: 'ci',
      status: 'active',
      memory: {
        status: 'active',
        goal: 'Watch the build',
        currentStep: 'Wait for CI',
        confirmedFacts: [],
        artifacts: [],
        blockers: [],
        nextStep: 'Wait',
        updatedAt: 2,
        sourceTurnId: 'turn-1',
      },
      startedAt: 1,
      updatedAt: 2,
      sourceEventId: 'event-active',
    }
    const screen = await render(ChatHistory, {
      props: {
        messages: [],
        tasks: [activeTask],
        style: 'height: 480px; width: 480px; overflow-y: auto;',
      },
      global: { plugins: [createEnglishI18n()] },
    })
    let trigger: HTMLButtonElement | null = null
    await vi.waitFor(() => {
      trigger = screen.container.querySelector<HTMLButtonElement>('button[aria-expanded]')
      expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    })

    await screen.rerender({
      tasks: [{
        ...activeTask,
        status: 'blocked',
        memory: { ...activeTask.memory, status: 'blocked', blockers: ['CI failed'] },
        needsInput: 'Choose whether to retry',
        sourceEventId: 'event-blocked',
      }],
    })

    await vi.waitFor(() => {
      expect(trigger?.getAttribute('aria-expanded')).toBe('true')
      expect(screen.container.textContent).toContain('Choose whether to retry')
    })
  })

  it('shows provider compaction state and keeps the summary expandable', async () => {
    const screen = await render(ChatHistory, {
      props: {
        messages: [
          { role: 'user', id: 'old-user', content: 'The original question.' },
          { role: 'assistant', id: 'old-assistant', content: 'The original answer.', slices: [], tool_results: [] },
          { role: 'user', id: 'user-4', content: 'The retained question.' },
        ],
        compaction: {
          summary: 'The earlier turns established the project context.',
          keepFromMessageId: 'user-4',
          removedTurnCount: 3,
          fromTurnIndex: 1,
          toTurnIndex: 4,
        },
        style: 'height: 240px; width: 320px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    const notice = screen.container.querySelector<HTMLElement>('[data-testid="chat-compaction-notice"]')
    expect(notice).not.toBeNull()
    if (!notice)
      throw new Error('Expected a compaction notice.')
    expect(notice.textContent).toContain('3 older turns are compacted')

    const details = notice.querySelector('details')
    const summary = details?.querySelector('summary')
    expect(details).not.toBeNull()
    expect(summary).not.toBeNull()
    if (!details || !summary)
      throw new Error('Expected an expandable compaction summary.')

    summary.click()
    expect(details.open).toBe(true)
    expect(notice.textContent).toContain('The earlier turns established the project context.')
    expect(notice.textContent).toContain('The original turns remain in this conversation.')
    expect(notice.textContent).toContain('Show 2 original messages')

    const originalSummary = notice.querySelectorAll('details')[1]?.querySelector('summary')
    expect(originalSummary).not.toBeNull()
    originalSummary?.click()
    expect(notice.textContent).toContain('The original question.')
    expect(notice.textContent).toContain('The original answer.')
  })

  it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'hello' },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    const screen = await render(ChatHistory, {
      props: {
        messages,
        style: 'height: 480px; width: 480px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    await screen.getByRole('button', { name: 'Retry' }).click()

    expect(screen.emitted('retryMessage')).toEqual([[
      {
        message: messages[1],
        index: 1,
        key: getChatHistoryItemKey(messages[1], 1),
      },
    ]])
  })

  it('keeps retry available when a reaction is displayed between the two messages', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'hello', createdAt: 1 },
      { role: 'error', content: 'Remote sent 400 response', createdAt: 3 },
    ]
    const screen = await render(ChatHistory, {
      props: {
        messages,
        reactions: [{ id: 'reaction-between', message: 'Still working.', createdAt: 2, sourceEventId: 'spark-1' }],
        style: 'height: 480px; width: 480px; overflow-y: auto;',
      },
      global: { plugins: [createEnglishI18n()] },
    })

    await screen.getByRole('button', { name: 'Retry' }).click()
    expect(screen.emitted('retryMessage')).toEqual([[expect.objectContaining({ index: 1 })]])
  })

  it('does not render the retry button when the error is not preceded by a user message', async () => {
    const screen = await render(ChatHistory, {
      props: {
        messages: [
          { role: 'assistant', content: 'hello', slices: [], tool_results: [] },
          { role: 'error', content: 'Remote sent 400 response' },
        ],
        style: 'height: 480px; width: 480px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    expect(screen.container.textContent).not.toContain('Retry')
  })

  // ROOT CAUSE:
  //
  // appendSendError historically appended the error item without a
  // `createdAt`, and the timeline sorted untimed items to the very top
  // (Number.MIN_SAFE_INTEGER fallback). In a long virtualized history the
  // failed-send error therefore rendered above the viewport while the user
  // was looking at the message tail — the failure appeared to produce no
  // error at all. Untimed items now sort to the tail, where the send
  // happened.
  it('renders an untimed failed-send error at the tail of a long history', async () => {
    const messages: ChatHistoryItem[] = Array.from({ length: 100 }, (_, index): ChatHistoryItem => {
      const base = { id: `msg-${index}`, content: index % 2 === 0 ? `Question ${index}` : `Answer ${index}`, createdAt: index }
      return index % 2 === 0
        ? { ...base, role: 'user' as const }
        // The assistant variant carries the streaming slice records.
        : { ...base, role: 'assistant' as const, slices: [], tool_results: [] }
    })
    // Mirrors the appendSendError output shape before the timestamp fix:
    // no id, no createdAt.
    messages.push({ role: 'error', content: 'Remote sent 401 response' })

    const screen = await render(ChatHistory, {
      props: {
        messages,
        style: 'height: 240px; width: 320px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    const history = screen.container.querySelector<HTMLElement>('.chat-history-list')
    expect(history).not.toBeNull()
    if (!history)
      throw new Error('Expected a chat history viewport.')

    history.scrollTop = history.scrollHeight
    history.dispatchEvent(new Event('scroll'))

    await vi.waitFor(() => {
      expect(screen.container.textContent).toContain('Remote sent 401 response')
    })
  })

  it('emits tool-call-rerun with message context when a tool call rerun button is clicked', async () => {
    const args = JSON.stringify({ location: 'Tokyo' })
    const assistantMessage: ChatHistoryItem = {
      role: 'assistant',
      content: '',
      slices: [
        {
          type: 'tool-call',
          toolCall: {
            toolCallId: 'call-weather',
            toolCallType: 'function',
            toolName: 'weather',
            args,
          },
        },
      ],
      tool_results: [],
      createdAt: 1710000000000,
    }
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'weather in Tokyo' },
      assistantMessage,
    ]

    const screen = await render(ChatHistory, {
      props: {
        messages,
        style: 'height: 480px; width: 480px; overflow-y: auto;',
      },
      global: {
        plugins: [createEnglishI18n()],
      },
    })

    await screen.getByLabelText('Re-run tool call').click()

    expect(screen.emitted('toolCallRerun')).toEqual([[
      {
        message: assistantMessage,
        index: 1,
        key: getChatHistoryItemKey(assistantMessage, 1),
        toolCallId: 'call-weather',
        toolName: 'weather',
        args,
      },
    ]])
  })
})
