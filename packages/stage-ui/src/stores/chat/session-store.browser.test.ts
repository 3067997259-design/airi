import type { LeadershipMode, SyncedPiniaRuntime } from 'pinia-plugin-synced'

import type { ChatSessionMeta } from '../../types/chat-session'

import { createPinia, defineStore, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref } from 'vue'

const useTestAuthStore = defineStore('auth', () => {
  const userId = ref('local')
  const token = ref<string | null>(null)
  return { userId, token }
}, {
  synced: { state: true },
})

const useTestAiriCardStore = defineStore('airi-card', () => {
  const activeCardId = ref('default')
  const systemPrompt = ref('')
  return { activeCardId, systemPrompt }
})

vi.doMock('../auth', () => {
  return {
    useAuthStore: useTestAuthStore,
  }
})

vi.doMock('../modules/airi-card', () => {
  return {
    useAiriCardStore: useTestAiriCardStore,
  }
})

vi.mock('../../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    addTombstone: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    dequeueOutbox: vi.fn().mockResolvedValue(undefined),
    dropOutboxForSession: vi.fn().mockResolvedValue(undefined),
    enqueueOutbox: vi.fn().mockResolvedValue(undefined),
    getIndex: vi.fn().mockResolvedValue(null),
    getOutbox: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(null),
    getTombstones: vi.fn().mockResolvedValue([]),
    removeTombstones: vi.fn().mockResolvedValue(undefined),
    saveIndex: vi.fn().mockResolvedValue(undefined),
    saveSession: vi.fn().mockResolvedValue(undefined),
    updateOutboxEntries: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../libs/analytics', () => ({
  captureAnalyticsEvent: vi.fn(),
}))

vi.mock('../../libs/auth-fetch', () => ({
  authedFetch: vi.fn(),
}))

vi.mock('../../libs/server', () => ({
  SERVER_URL: 'http://test',
}))

vi.mock('../../libs/chat-sync', () => ({
  applyCreateActions: vi.fn().mockResolvedValue([]),
  createCloudChatMapper: () => ({
    deleteChat: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
  }),
  createChatWsClient: () => ({
    connect: vi.fn(),
    destroy: vi.fn(),
    disconnect: vi.fn(),
    onNewMessages: () => () => {},
    onStatusChange: () => () => {},
    pullMessages: vi.fn().mockResolvedValue({ messages: [], seq: 0 }),
    sendMessages: vi.fn().mockResolvedValue({ ok: true }),
    status: () => 'idle',
  }),
  extractMessageText: () => '',
  isCloudSyncableMessage: () => false,
  mergeCloudMessagesIntoLocal: () => ({ dirty: false, messages: [], maxSeq: 0 }),
  reconcileLocalAndRemote: () => ({ adopt: [], claim: [], create: [] }),
}))

const { useChatSessionStore } = await import('./session-store')

const syncedContexts: Array<{
  pinia: ReturnType<typeof createPinia>
  runtime: SyncedPiniaRuntime
}> = []

function createSyncedContext(namespace: string, leadership: LeadershipMode) {
  const pinia = createPinia()
  const runtime = createSyncedPiniaPlugin({
    callTimeout: 1000,
    leadership,
    namespace,
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

describe('chat session synchronization', () => {
  it('keeps the leader chat snapshot when new followers receive the auth identity', async () => {
    // ROOT CAUSE:
    //
    // A new settings renderer received the synchronized auth identity after
    // its chat-session store was created. Its local userId watcher cleared the
    // synchronized chat state and proposed that empty snapshot to the leader.
    //
    // The follower routes its observed auth transition to the synchronized
    // identity action. The leader keeps its matching snapshot unchanged.
    const namespace = `chat-session:${crypto.randomUUID()}`
    const leaderContext = createSyncedContext(namespace, 'leader-only')
    await vi.waitFor(() => expect(leaderContext.runtime.isLeader()).toBe(true))

    setActivePinia(leaderContext.pinia)
    const leaderAuthStore = useTestAuthStore()
    leaderAuthStore.userId = 'cloud-user'
    const leaderChatStore = useChatSessionStore()

    const session: ChatSessionMeta = {
      sessionId: 'session-a',
      userId: 'cloud-user',
      characterId: 'default',
      createdAt: 1,
      updatedAt: 1,
    }
    leaderChatStore.$patch({
      index: {
        userId: 'cloud-user',
        characters: {
          default: {
            activeSessionId: 'session-a',
            sessions: { 'session-a': session },
          },
        },
      },
      sessionMessages: {
        'session-a': [{ id: 'message-a', role: 'user', content: 'Keep this message' }],
      },
      sessionMetas: { 'session-a': session },
    })

    let leaderIdentityActions = 0
    let leaderMutations = 0
    leaderChatStore.$onAction(({ name }) => {
      if (name === 'activateCurrentUser')
        leaderIdentityActions++
    })
    leaderChatStore.$subscribe(() => leaderMutations++)

    const followerContext = createSyncedContext(namespace, 'follower-only')
    setActivePinia(followerContext.pinia)
    const followerChatStore = useChatSessionStore()
    const followerAuthStore = useTestAuthStore()
    await vi.waitFor(() => expect(followerContext.runtime.getLeaderId()).toBe(leaderContext.runtime.participantId))
    await vi.waitFor(() => expect(followerAuthStore.userId).toBe('cloud-user'))
    await vi.waitFor(() => expect(followerChatStore.sessionMessages['session-a']).toHaveLength(1))

    const secondFollowerContext = createSyncedContext(namespace, 'follower-only')
    setActivePinia(secondFollowerContext.pinia)
    const secondFollowerChatStore = useChatSessionStore()
    const secondFollowerAuthStore = useTestAuthStore()
    await vi.waitFor(() => expect(secondFollowerContext.runtime.getLeaderId()).toBe(leaderContext.runtime.participantId))
    await vi.waitFor(() => expect(secondFollowerAuthStore.userId).toBe('cloud-user'))
    await vi.waitFor(() => expect(secondFollowerChatStore.sessionMessages['session-a']).toHaveLength(1))
    await Promise.resolve()

    expect(leaderChatStore.sessionMessages['session-a']?.[0]?.id).toBe('message-a')
    expect(followerChatStore.sessionMessages['session-a']?.[0]?.id).toBe('message-a')
    expect(leaderChatStore.index?.userId).toBe('cloud-user')
    expect(followerChatStore.index?.userId).toBe('cloud-user')
    expect(secondFollowerChatStore.sessionMessages['session-a']?.[0]?.id).toBe('message-a')
    expect(leaderIdentityActions).toBe(2)
    expect(leaderMutations).toBe(0)
  })
})

function buildSessionMeta(sessionId: string, updatedAt: number): ChatSessionMeta {
  return {
    sessionId,
    userId: 'cloud-user',
    characterId: 'default',
    createdAt: updatedAt,
    updatedAt,
  }
}

// Insertion order matters for the delete-fallback regression: the bug picked
// the first surviving key of the index map, which is the oldest session.
function buildSeedIndex(activeSessionId: string) {
  const sessions = {
    'session-old': buildSessionMeta('session-old', 1),
    'session-mid': buildSessionMeta('session-mid', 2),
    'session-new': buildSessionMeta('session-new', 3),
  }
  return {
    index: {
      userId: 'cloud-user',
      characters: {
        default: {
          activeSessionId,
          sessions,
        },
      },
    },
    sessionMetas: { ...sessions },
    sessionMessages: {
      'session-old': [{ id: 'message-old', role: 'user' as const, content: 'Old' }],
      'session-mid': [{ id: 'message-mid', role: 'user' as const, content: 'Mid' }],
      'session-new': [{ id: 'message-new', role: 'user' as const, content: 'New' }],
    },
  }
}

describe('chat session selection stability', () => {
  async function createLeader(namespace: string) {
    const context = createSyncedContext(namespace, 'leader-only')
    await vi.waitFor(() => expect(context.runtime.isLeader()).toBe(true))
    setActivePinia(context.pinia)
    useTestAuthStore().userId = 'cloud-user'
    const chatStore = useChatSessionStore()
    return { context, chatStore }
  }

  // Mirrors the desktop chat window: a follower that owns no synchronized
  // writes and derives its window-local selection from the shared index.
  async function createInitializedFollower(context: ReturnType<typeof createSyncedContext>) {
    setActivePinia(context.pinia)
    const chatStore = useChatSessionStore()
    chatStore.setCloudSyncOwnership(false)
    await vi.waitFor(() => expect(useTestAuthStore().userId).toBe('cloud-user'))
    await chatStore.initialize()
    return chatStore
  }

  it('keeps the window on the active conversation when a background session is deleted', async () => {
    // ROOT CAUSE:
    //
    // `deleteSession` unconditionally rewrote the shared character index
    // pointer to the first surviving session, even when the deleted session
    // was not the one on screen. In a three-session index (old, mid, new) the
    // rewrite targeted `session-old` while the window showed `session-new`.
    // The `watch([activeCardId, index])` restore then re-derived the window
    // selection from that pointer and the view jumped back to the older
    // conversation. Observed live: the flip landed within 300ms of the
    // delete, and the `[chat-session] selection restored from index:` probe
    // logged the new -> old transition.
    const namespace = `chat-session:${crypto.randomUUID()}`
    const { chatStore: leaderChatStore } = await createLeader(namespace)
    leaderChatStore.$patch(buildSeedIndex('session-new'))

    const followerContext = createSyncedContext(namespace, 'follower-only')
    const followerChatStore = await createInitializedFollower(followerContext)
    await vi.waitFor(() => expect(followerChatStore.activeSessionId).toBe('session-new'))

    await followerChatStore.deleteSession('session-mid')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(followerChatStore.activeSessionId).toBe('session-new')
    expect(followerChatStore.index?.characters.default.activeSessionId).toBe('session-new')
    expect(leaderChatStore.index?.characters.default.activeSessionId).toBe('session-new')
  })

  it('does not re-derive a still-known selection from a stale index pointer', async () => {
    // ROOT CAUSE:
    //
    // Any index mutation re-ran the selection restore. A stale pointer
    // arriving through synchronization (a leader snapshot that missed the
    // latest local selection, as with `createSession(setActive: false)` plus
    // a turn-end `persistSession` in the leader) pulled the window back to
    // the pointer target. Selection belongs to the window, so a known
    // selection must survive pointer updates.
    const namespace = `chat-session:${crypto.randomUUID()}`
    const { chatStore: leaderChatStore } = await createLeader(namespace)
    leaderChatStore.$patch(buildSeedIndex('session-new'))

    const followerContext = createSyncedContext(namespace, 'follower-only')
    const followerChatStore = await createInitializedFollower(followerContext)
    await vi.waitFor(() => expect(followerChatStore.activeSessionId).toBe('session-new'))

    const staleSnapshot = buildSeedIndex('session-old')
    leaderChatStore.$patch({ index: staleSnapshot.index })
    await vi.waitFor(() => expect(followerChatStore.index?.characters.default.activeSessionId).toBe('session-old'))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(followerChatStore.activeSessionId).toBe('session-new')
  })

  it('still re-derives an empty selection from the index pointer', async () => {
    // Guards the known-selection gate against overcorrection: the restore
    // must stay alive for the boot race where the replicated index lands
    // while the window selection is still empty.
    const namespace = `chat-session:${crypto.randomUUID()}`
    const { chatStore: leaderChatStore } = await createLeader(namespace)
    leaderChatStore.$patch(buildSeedIndex('session-new'))

    const followerContext = createSyncedContext(namespace, 'follower-only')
    const followerChatStore = await createInitializedFollower(followerContext)
    await vi.waitFor(() => expect(followerChatStore.activeSessionId).toBe('session-new'))

    // Selection is window-local state, not part of the synchronized store.
    // Reset it through the selection store to replay the post-boot state in
    // which the window has not picked a conversation yet.
    const selectionStore = followerContext.pinia._s.get('chat-session-selection')
    if (!selectionStore)
      throw new Error('Expected the chat-session-selection store to exist.')
    selectionStore.activeSessionId = ''

    const reroutedSnapshot = buildSeedIndex('session-old')
    leaderChatStore.$patch({ index: reroutedSnapshot.index })
    await vi.waitFor(() => expect(followerChatStore.activeSessionId).toBe('session-old'))
  })

  it('falls back to the oldest surviving session when the active session is deleted', async () => {
    // Preservation test: deleting the session the window is displaying must
    // still move both the shared pointer and the local selection to a
    // surviving session.
    const namespace = `chat-session:${crypto.randomUUID()}`
    const { chatStore: leaderChatStore } = await createLeader(namespace)
    leaderChatStore.$patch(buildSeedIndex('session-new'))

    const followerContext = createSyncedContext(namespace, 'follower-only')
    const followerChatStore = await createInitializedFollower(followerContext)
    await vi.waitFor(() => expect(followerChatStore.activeSessionId).toBe('session-new'))

    await followerChatStore.deleteSession('session-new')
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(followerChatStore.activeSessionId).toBe('session-old')
    expect(followerChatStore.index?.characters.default.activeSessionId).toBe('session-old')
    expect(leaderChatStore.index?.characters.default.activeSessionId).toBe('session-old')
  })
})
