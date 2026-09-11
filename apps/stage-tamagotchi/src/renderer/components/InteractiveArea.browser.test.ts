import type { ChatSessionMeta } from '@proj-airi/stage-ui/types/chat-session'
import type { Component } from 'vue'

import SharedInteractiveArea from '@proj-airi/stage-layouts/components/Layouts/InteractiveArea'
import MobileInteractiveArea from '@proj-airi/stage-layouts/components/Layouts/MobileInteractiveArea'
import ChatArea from '@proj-airi/stage-layouts/components/Widgets/ChatArea'

import { PiniaColada } from '@pinia/colada'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { usePlanStore } from '@proj-airi/stage-ui/stores/plans'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { userEvent } from 'vitest/browser'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import InteractiveArea from './InteractiveArea.vue'

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))

const electronInvokeMock = vi.hoisted(() => vi.fn())

vi.mock('vue-sonner', () => ({ toast: toastMock }))

vi.mock('@proj-airi/electron-vueuse', async (importOriginal) => {
  // The test graph also pulls bridge modules that import the raw context
  // helper, so the mock keeps every real export and only replaces the invoke
  // composable this component uses.
  const actual = await importOriginal<typeof import('@proj-airi/electron-vueuse')>()
  return {
    ...actual,
    useElectronEventaInvoke: () => electronInvokeMock,
  }
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: {} },
  })
}

async function renderArea(component: Component = InteractiveArea) {
  const sessionB: ChatSessionMeta = {
    sessionId: 'session-b',
    userId: 'local',
    characterId: 'default',
    createdAt: 1,
    updatedAt: 1,
  }
  const sessionA: ChatSessionMeta = {
    ...sessionB,
    sessionId: 'session-a',
    createdAt: 2,
    updatedAt: 2,
  }
  const pinia = createPinia()
  pinia.state.value = {
    // The composer requires a configured provider (UI-4); tests that need the
    // blocked state clear this store explicitly.
    'consciousness': { activeProvider: 'test-provider', activeModel: 'test-model' },
    'chat-session-selection': { activeSessionId: 'session-b' },
    'chat-session': {
      sessionMetas: { 'session-a': sessionA, 'session-b': sessionB },
      sessionMessages: {
        'session-a': [{ id: 'system-a', role: 'system', content: 'session A prompt' }],
        'session-b': [{ id: 'system', role: 'system', content: 'system prompt' }],
      },
    },
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()

  const screen = await render(component, {
    global: { plugins: [pinia, PiniaColada, createTestI18n(), router] },
  })
  return {
    chat: useChatStore(pinia),
    chatSession: useChatSessionStore(pinia),
    chatStream: useChatStreamStore(pinia),
    consciousness: useConsciousnessStore(pinia),
    plan: usePlanStore(pinia),
    screen,
  }
}

/**
 * Builds one persisted plan row for the timeline/plan-center split tests.
 *
 * The state snapshot is the restart fallback; with an empty journal, the
 * store projects the card straight from it.
 */
function planRecord(input: {
  id: string
  goal: string
  horizon: 'session' | 'long'
  sessionId?: string
  lifecycle?: 'running' | 'completed'
  updatedAt?: number
}) {
  const longGoal = input.horizon === 'long'
    ? { lifecycle: input.lifecycle ?? ('running' as const), constraintVersion: 1 }
    : undefined
  return {
    id: input.id,
    spec: {
      goal: input.goal,
      horizon: input.horizon,
      steps: [{
        id: 'verify',
        lane: 'coding' as const,
        intent: 'Run the focused tests',
        allowedTools: ['bash'],
        expectedEvidence: [{ source: 'tool_result' as const, description: 'tests pass' }],
        riskLevel: 'low' as const,
        approvalRequired: false,
      }],
    },
    stateSnapshot: {
      currentStepId: 'verify',
      completedSteps: [],
      failedSteps: [],
      skippedSteps: [],
      evidenceRefs: [],
      blockers: [],
      ...(longGoal ? { longGoal } : {}),
    },
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    createdAt: 1,
    updatedAt: input.updatedAt ?? 1,
  }
}

async function submitDraft(screen: Awaited<ReturnType<typeof renderArea>>['screen'], draft: string) {
  const input = screen.getByRole('textbox')
  await userEvent.fill(input, draft)
  await userEvent.click(input)
  await userEvent.keyboard('{Enter}')
  return input
}

describe('interactive area synchronized state', () => {
  it('interrupts the active turn with Escape and routes it to the leader action', async () => {
    const { chat, screen } = await renderArea()
    const abort = vi.spyOn(chat, 'abortActiveSend').mockResolvedValueOnce(true)
    chat.$patch({ activeSendSessionId: 'session-b', sending: true })
    await nextTick()

    const input = screen.getByRole('textbox', { name: 'stage.message' })
    await userEvent.click(input)
    await userEvent.keyboard('{Escape}')

    expect(abort).toHaveBeenCalledWith('session-b')
  })

  it('interrupts with Escape even when the composer does not hold focus', async () => {
    const { chat, screen } = await renderArea()
    const abort = vi.spyOn(chat, 'abortActiveSend').mockResolvedValueOnce(true)
    chat.$patch({ activeSendSessionId: 'session-b', sending: true })
    await nextTick()

    // Focus stays wherever the user left it (history pane, tool chip); the
    // interrupt is global, matching the CLI harness convention.
    await userEvent.keyboard('{Escape}')

    expect(abort).toHaveBeenCalledWith('session-b')
    await expect.element(screen.getByRole('textbox', { name: 'stage.message' })).toBeInTheDocument()
  })

  it('uses Shift + Enter to queue a message while the active session is sending', async () => {
    const { chat, screen } = await renderArea()
    const send = vi.spyOn(chat, 'send').mockResolvedValueOnce({ messages: [], sessionId: 'session-b' })
    chat.$patch({ activeSendSessionId: 'session-b', sending: true })
    await nextTick()

    // The btw side card renders its own textarea while a turn is sending;
    // scope to the main composer.
    const input = screen.getByRole('textbox', { name: 'stage.message' })
    await userEvent.fill(input, 'wait for the next turn')
    await userEvent.click(input)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-b',
      text: 'wait for the next turn',
      delivery: 'next-turn',
    })))
  })

  it('disables the composer with a readable reason when no session exists', async () => {
    // ROOT CAUSE (#11/UI-4): with no active session the send promise rejected,
    // the catch restored the draft, and the user saw an input that did
    // nothing. The composer now disables and the notice names the reason and
    // the recovery entry.
    const { chatSession, screen } = await renderArea()
    chatSession.activeSessionId = ''
    await nextTick()

    await expect.element(screen.getByTestId('chat-composer-blocked')).toBeVisible()
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-main-input"]')
    expect(input?.disabled).toBe(true)
  })

  it('disables the composer and opens provider settings when no provider is configured', async () => {
    // UI-4: a missing provider used to look like a working composer whose
    // sends failed upstream. The blocked notice names the recovery entry.
    const { consciousness, screen } = await renderArea()
    electronInvokeMock.mockClear()
    consciousness.activeProvider = ''
    await nextTick()

    await expect.element(screen.getByTestId('chat-composer-blocked')).toBeVisible()
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-main-input"]')
    expect(input?.disabled).toBe(true)
    await userEvent.click(screen.getByTestId('chat-composer-open-settings'))
    expect(electronInvokeMock).toHaveBeenCalledWith({ route: '/settings/providers' })
  })

  it('marks the main composer so automation cannot target the btw side channel', async () => {
    // #10/#20: with the side card open, the first textarea in the document is
    // the btw input. Automation using `document.querySelector('textarea')`
    // silently routed user revisions into the side channel.
    const { chat } = await renderArea()
    chat.$patch({ activeSendSessionId: 'session-b', sending: true })
    await nextTick()

    const main = document.querySelector('[data-testid="chat-main-input"]')
    expect(main).not.toBeNull()
    expect(document.querySelector('textarea')).not.toBe(main)
    expect(main?.getAttribute('placeholder')).toBe('stage.message')
  })

  it('keeps finished, superseded, and other-session goals out of the timeline but reachable from the plan center', async () => {
    // ROOT CAUSE:
    //
    // Chat rendered every plan the store held, so completed and cancelled
    // long goals from many sessions accumulated in the timeline until they
    // pushed the composer out of view (2026-09-11 field report). A second
    // acceptance run found the same pile-up in the session lane: older
    // session plans superseded by a newer plan and completed plans without
    // verification still rendered as live work. The timeline now carries only
    // work the lane still targets; the plan center keeps the rest, including
    // the unverified marks and source navigation.
    const { plan, screen } = await renderArea()
    plan.$patch({
      plans: [
        planRecord({ id: 'session-superseded', goal: 'Superseded session plan', horizon: 'session', sessionId: 'session-b' }),
        planRecord({ id: 'session-live', goal: 'Live session plan', horizon: 'session', sessionId: 'session-b' }),
        planRecord({ id: 'long-finished', goal: 'Finished long goal', horizon: 'long', sessionId: 'session-b', lifecycle: 'completed' }),
        planRecord({ id: 'long-other', goal: 'Other session goal', horizon: 'long', sessionId: 'session-a', lifecycle: 'running', updatedAt: 2 }),
      ],
    })
    await nextTick()

    await expect.element(screen.getByText('Live session plan')).toBeVisible()
    await expect.element(screen.getByText('Superseded session plan')).not.toBeInTheDocument()
    await expect.element(screen.getByText('Finished long goal')).not.toBeInTheDocument()
    await expect.element(screen.getByText('Other session goal')).not.toBeInTheDocument()
    await expect.element(screen.getByTestId('chat-plan-center')).toBeVisible()

    await userEvent.click(screen.getByTestId('chat-plan-center-toggle'))
    await expect.element(screen.getByTestId('chat-plan-center-other-sessions')).toBeVisible()
    // The archive stays closed until asked; opening it proves the record and
    // its evidence were kept, not deleted.
    await userEvent.click(screen.getByTestId('chat-plan-history-toggle'))
    await expect.element(screen.getByText('Finished long goal')).toBeVisible()
    await expect.element(screen.getByText('Superseded session plan')).toBeVisible()
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743121861
  it('renders the active synchronized stream through the real chat history for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // A follower received the leader-owned active stream in the real chat
    // store, but InteractiveArea passed its unrelated foreground stream to
    // ChatHistory. Mocking either store or component hid that broken binding.
    const { chat, chatStream, screen } = await renderArea()
    chat.$patch({
      activeSendSessionId: 'session-b',
      activeStreamingMessage: {
        id: 'follower-b-stream',
        role: 'assistant',
        content: 'Follower B live response',
        slices: [{ type: 'text', text: 'Follower B live response' }],
        tool_results: [],
        createdAt: 2,
      },
      sending: true,
    })
    chatStream.$patch({
      streamingMessage: {
        id: 'leader-a-stream',
        role: 'assistant',
        content: 'Leader A foreground response',
        slices: [{ type: 'text', text: 'Leader A foreground response' }],
        tool_results: [],
        createdAt: 3,
      },
    })
    await nextTick()

    await expect.element(screen.getByText('Follower B live response')).toBeVisible()
    await expect.element(screen.getByText('Leader A foreground response')).not.toBeInTheDocument()
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743309235
  it('scopes the mobile synchronized stream to its local session for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // MobileInteractiveArea passed the synchronized global sending state and
    // foreground stream directly to ChatHistory. A mobile window on session B
    // therefore rendered the live response from a send targeting session A.
    const { chat, chatStream, screen } = await renderArea(MobileInteractiveArea)
    chat.$patch({
      activeSendSessionId: 'session-a',
      activeStreamingMessage: {
        id: 'session-a-stream',
        role: 'assistant',
        content: 'Session A live response',
        slices: [{ type: 'text', text: 'Session A live response' }],
        tool_results: [],
        createdAt: 2,
      },
      sending: true,
    })
    chatStream.$patch({
      streamingMessage: {
        id: 'session-a-foreground',
        role: 'assistant',
        content: 'Session A live response',
        slices: [{ type: 'text', text: 'Session A live response' }],
        tool_results: [],
        createdAt: 2,
      },
    })
    await nextTick()
    await expect.element(screen.getByText('Session A live response')).not.toBeInTheDocument()

    chat.$patch({
      activeSendSessionId: 'session-b',
      activeStreamingMessage: {
        id: 'session-b-stream',
        role: 'assistant',
        content: 'Session B live response',
        slices: [{ type: 'text', text: 'Session B live response' }],
        tool_results: [],
        createdAt: 3,
      },
    })
    await nextTick()
    await expect.element(screen.getByText('Session B live response')).toBeVisible()
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743366443
  it('scopes the stage-web desktop synchronized stream to its local session for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // The shared desktop layout derived sending from the target session but
    // still passed the leader foreground stream to ChatHistory. A web window
    // on B could therefore append A's live response.
    const { chat, chatStream, screen } = await renderArea(SharedInteractiveArea)
    chat.$patch({
      activeSendSessionId: 'session-b',
      activeStreamingMessage: {
        id: 'session-b-web-stream',
        role: 'assistant',
        content: 'Session B web response',
        slices: [{ type: 'text', text: 'Session B web response' }],
        tool_results: [],
        createdAt: 2,
      },
      sending: true,
    })
    chatStream.$patch({
      streamingMessage: {
        id: 'session-a-web-foreground',
        role: 'assistant',
        content: 'Session A foreground response',
        slices: [{ type: 'text', text: 'Session A foreground response' }],
        tool_results: [],
        createdAt: 3,
      },
    })
    await nextTick()

    await expect.element(screen.getByText('Session B web response')).toBeVisible()
    await expect.element(screen.getByText('Session A foreground response')).not.toBeInTheDocument()
  })

  it('routes a stage-web send through the synchronized chat action', async () => {
    const { chat, screen } = await renderArea(SharedInteractiveArea)
    const send = vi.spyOn(chat, 'send').mockResolvedValueOnce({ messages: [], sessionId: 'session-b' })

    await submitDraft(screen, 'web follower message')

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({
      sessionId: 'session-b',
      text: 'web follower message',
    }))
  })

  // https://github.com/3067997259-design/airi/issues/1
  it('includes the GitHub watch tools in the chat request for Issue #1', async () => {
    const { chat, screen } = await renderArea()
    const send = vi.spyOn(chat, 'send').mockResolvedValueOnce({ messages: [], sessionId: 'session-b' })

    await submitDraft(screen, 'read the GitHub task inbox')

    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    const payload = send.mock.calls[0]?.[0]
    const toolNames = payload?.tools?.map(tool => tool.name) ?? []
    expect(toolNames).toContain('github_list_task_issues')
    expect(toolNames).toContain('github_get_pr')
    expect(toolNames).toContain('user_ask')
    expect(toolNames).not.toContain('github_post_pr_comment')
  })

  it('routes a mobile send through the synchronized chat action', async () => {
    const { chat, screen } = await renderArea(MobileInteractiveArea)
    const send = vi.spyOn(chat, 'send').mockResolvedValueOnce({ messages: [], sessionId: 'session-b' })

    await submitDraft(screen, 'mobile follower message')

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({
      sessionId: 'session-b',
      text: 'mobile follower message',
    }))
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3755530944
  it('keeps a failed mobile draft out of a newly selected session for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Shared layouts restored a rejected send into their component-wide input
    // without checking whether the window still displayed the target session.
    const { chat, chatSession, screen } = await renderArea(MobileInteractiveArea)
    let rejectSend: ((error: Error) => void) | undefined
    vi.spyOn(chat, 'send').mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSend = reject
    }))

    const input = await submitDraft(screen, 'mobile draft from B')
    chatSession.activeSessionId = 'session-a'
    rejectSend?.(new Error('send failed'))

    await expect.element(input).toHaveValue('')
  })

  it('does not restore a deleted-session draft in the shared chat widget', async () => {
    const { chat, screen } = await renderArea(ChatArea)
    let rejectSend: ((error: Error) => void) | undefined
    vi.spyOn(chat, 'send').mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSend = reject
    }))

    const input = await submitDraft(screen, 'deleted web draft')
    rejectSend?.(new Error('Chat session was removed before send completed'))

    await expect.element(input).toHaveValue('')
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3628804992
  it('does not restore a failed draft into a newly selected session for Issue #2085', async () => {
    // ROOT CAUSE:
    //
    // Failure recovery used the reactive selection instead of the session
    // captured by the send, so a late rejection could move a draft.
    const { chat, chatSession, screen } = await renderArea()
    let rejectSend: ((error: Error) => void) | undefined
    vi.spyOn(chat, 'send').mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSend = reject
    }))

    const input = await submitDraft(screen, 'send from B')
    await expect.element(input).toHaveValue('')
    chatSession.activeSessionId = 'session-a'
    rejectSend?.(new Error('hydrate failed'))

    await expect.element(input).toHaveValue('')
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3629004140
  it('restores a failed draft when its captured session is still active for Issue #2085', async () => {
    const { chat, screen } = await renderArea()
    vi.spyOn(chat, 'send').mockRejectedValueOnce(new Error('send failed'))

    const input = await submitDraft(screen, 'retry this draft')
    await expect.element(input).toHaveValue('retry this draft')
  })

  it('keeps a newer draft when an earlier send fails', async () => {
    // ROOT CAUSE:
    //
    // Failure recovery replaced the textarea unconditionally. Text entered
    // while the request was pending was lost with its attachment previews.
    const { chat, screen } = await renderArea()
    let rejectSend: ((error: Error) => void) | undefined
    vi.spyOn(chat, 'send').mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSend = reject
    }))

    const input = await submitDraft(screen, 'first draft')
    await userEvent.fill(input, 'newer draft')
    rejectSend?.(new Error('send failed'))

    await expect.element(input).toHaveValue('first draft\nnewer draft')
  })

  // https://github.com/moeru-ai/airi/pull/2086#discussion_r3743366446
  it('discards a queued draft when deletion cancels its send for Issue #2085', async () => {
    const { chat, screen } = await renderArea()
    let rejectSend: ((error: Error) => void) | undefined
    vi.spyOn(chat, 'send').mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectSend = reject
    }))

    const input = await submitDraft(screen, 'discard this deleted draft')
    rejectSend?.(new Error('Chat session was reset before send could start'))

    await expect.element(input).toHaveValue('')
  })
})
