import type { MemoryDreamIdea, MemoryDreamIdeaStatus, MemoryExtraction, MemoryFragment, MemoryMood, MemoryRepository, MemoryScoreWeights, MemorySourceContext, MemorySubscriptionEvent, ScoredMemoryFragment } from '@proj-airi/memory-core'

import { errorMessageFrom } from '@moeru/std'
import { emotionToMood, matchesMuscleMemory, memoryEventToExtraction, scoreMemoryFragment, selectIntrusiveMemory } from '@proj-airi/memory-core'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'

import { resolveMemoryWriteAccess } from '../../services/memory/write-access'

export interface MemoryTurnInput {
  sessionId: string
  userText: string
  assistantText: string
  sourceContext?: MemorySourceContext
}

export type MemoryTurnExtractor = (input: MemoryTurnInput & { mood: MemoryMood }) => Promise<MemoryExtraction[]>

export interface MemoryDreamAgentInput {
  fragments: MemoryFragment[]
  ideas: MemoryDreamIdea[]
}

export interface MemoryDreamProposal {
  content: string
  sourceId?: string
  excitement?: number
}

export type MemoryDreamAgent = (input: MemoryDreamAgentInput) => Promise<MemoryDreamProposal[]>

let dreamAgent: MemoryDreamAgent | undefined

/** Installs the optional model-backed dreaming callback without coupling memory to a provider. */
export function installMemoryDreamAgent(next: MemoryDreamAgent | undefined): void {
  dreamAgent = next
}

/** Shape of the main-process long-term store status (MAINTENANCE-PLAN P2.4). */
export interface MemoryHostStatusLike {
  status: 'unconfigured' | 'ready' | 'error'
  error?: string
}

/**
 * Renderer-side port to the long-term Postgres store owned by the Electron
 * main process. Embeddings are computed in the renderer (the embed worker is
 * browser-only) and shipped alongside the fragment.
 */
export interface MemoryHostPort {
  configure: (params: { connectionString?: string }) => Promise<MemoryHostStatusLike>
  getStatus: () => Promise<MemoryHostStatusLike>
  list: (params?: { memoryType?: string, reviewStatus?: string, limit?: number }) => Promise<Array<{ id: string, content: string, memoryType: string, category: string, importance: number, createdAt: number, lastAccessed: number, accessCount: number, reviewStatus?: string, sessionIds?: string[], score?: number }>>
  search: (params: { embedding: number[], limit?: number, weights?: { similarity?: number, timeRelevance?: number, arousal?: number, accessCount?: number, moodCongruence?: number } }) => Promise<Array<{ id: string, content: string, memoryType: string, category: string, importance: number, createdAt: number, lastAccessed: number, accessCount: number, reviewStatus?: string, sessionIds?: string[], score?: number }>>
  insert: (params: { content: string, memoryType: string, category: string, importance?: number, valence?: number, arousal?: number, halfLifeHours?: number, sessionId?: string, reviewStatus?: string, embedding?: number[], now?: number }) => Promise<{ id: string }>
}

let memoryHostPort: MemoryHostPort | undefined

/** Installs the Eventa-backed memory host client for this renderer process. */
export function installMemoryHostPort(next: MemoryHostPort): void {
  memoryHostPort = next
}

/** Stores memory settings and provides a local DuckDB repository to stage. */
export const useMemoryStore = defineStore('memory', () => {
  const repository = shallowRef<MemoryRepository>()
  const databaseStatus = shallowRef<'idle' | 'ready' | 'error' | 'follower'>('idle')
  const databaseError = shallowRef<string>()
  const currentMood = shallowRef<MemoryMood>({ valence: 0, arousal: 0 })
  const writeAccess = shallowRef(resolveMemoryWriteAccess())

  const enabled = useLocalStorageManualReset('settings/memory/enabled', false, { listenToStorageChanges: false })
  const captureEnabled = useLocalStorageManualReset('settings/memory/capture-enabled', false, { listenToStorageChanges: false })
  const compactionEnabled = useLocalStorageManualReset('settings/memory/compaction-enabled', true, { listenToStorageChanges: false })
  const activeProvider = useLocalStorageManualReset('settings/memory/active-provider', '', { listenToStorageChanges: false })
  const activeModel = useLocalStorageManualReset('settings/memory/active-model', '', { listenToStorageChanges: false })
  const compactionThreshold = useLocalStorageManualReset('settings/memory/compaction-threshold', 0.7, { listenToStorageChanges: false })
  const contextLengthOverride = useLocalStorageManualReset('settings/memory/context-length-override', 0, { listenToStorageChanges: false })
  const compactionRecentTurnLimit = useLocalStorageManualReset('settings/memory/compaction-recent-turn-limit', 4, { listenToStorageChanges: false })
  const shortTermHalfLifeHours = useLocalStorageManualReset('settings/memory/short-term-half-life-hours', 24, { listenToStorageChanges: false })
  const longTermHalfLifeHours = useLocalStorageManualReset('settings/memory/long-term-half-life-hours', 4_320, { listenToStorageChanges: false })
  const promotionAccessCount = useLocalStorageManualReset('settings/memory/promotion-access-count', 3, { listenToStorageChanges: false })
  const promotionSessionCount = useLocalStorageManualReset('settings/memory/promotion-session-count', 2, { listenToStorageChanges: false })
  const weightSimilarity = useLocalStorageManualReset('settings/memory/weight-similarity', 1.2, { listenToStorageChanges: false })
  const weightTimeRelevance = useLocalStorageManualReset('settings/memory/weight-time-relevance', 0.2, { listenToStorageChanges: false })
  const weightArousal = useLocalStorageManualReset('settings/memory/weight-arousal', 0.3, { listenToStorageChanges: false })
  const weightAccessCount = useLocalStorageManualReset('settings/memory/weight-access-count', 0.15, { listenToStorageChanges: false })
  const weightMoodCongruence = useLocalStorageManualReset('settings/memory/weight-mood-congruence', 0.25, { listenToStorageChanges: false })
  const intrusionEnabled = useLocalStorageManualReset('settings/memory/intrusion-enabled', false, { listenToStorageChanges: false })
  const intrusionBaseRate = useLocalStorageManualReset('settings/memory/intrusion-base-rate', 0.02, { listenToStorageChanges: false })
  const intrusionCooldownMs = useLocalStorageManualReset('settings/memory/intrusion-cooldown-ms', 30_000, { listenToStorageChanges: false })
  const dreamingEnabled = useLocalStorageManualReset('settings/memory/dreaming-enabled', false, { listenToStorageChanges: false })
  const pgConnectionString = useLocalStorageManualReset('settings/memory/pg-connection-string', '', { listenToStorageChanges: false })
  const remoteStatus = shallowRef<'unconfigured' | 'ready' | 'error'>('unconfigured')
  const remoteError = shallowRef<string>()
  const dreamIdeas = shallowRef<MemoryDreamIdea[]>([])
  const dreaming = shallowRef(false)

  const configured = computed(() => enabled.value)

  async function initialize() {
    if (repository.value)
      return repository.value

    // Single-writer rule: the DuckDB OPFS store permits exactly one
    // synchronous access handle per file. Follower renderers must not open
    // the database read-write, or the leader's handle fails with
    // createSyncAccessHandle conflicts (MEMORY-DESIGN §1.4 fix).
    if (writeAccess.value === 'follower') {
      databaseStatus.value = 'follower'
      databaseError.value = undefined
      return undefined
    }

    try {
      // Keep the browser-only DuckDB worker out of Node consumers that only
      // need the memory settings or subscription boundary. The database is
      // loaded only when a memory operation is explicitly initialized.
      const [{ useDuckDb }, { createDuckDbMemoryRepository }] = await Promise.all([
        import('../../composables/use-duck-db'),
        import('../../services/memory/local-memory'),
      ])
      const database = useDuckDb()
      await database.getDb()
      if (!database.db.value)
        throw new Error('DuckDB did not return a database instance')

      repository.value = createDuckDbMemoryRepository(database.db.value)
      databaseStatus.value = 'ready'
      databaseError.value = undefined
      return repository.value
    }
    catch (error) {
      databaseStatus.value = 'error'
      databaseError.value = errorMessageFrom(error) ?? 'Unknown memory database error'
      return undefined
    }
  }

  function getScoreWeights(): MemoryScoreWeights {
    return {
      similarity: weightSimilarity.value,
      timeRelevance: weightTimeRelevance.value,
      arousal: weightArousal.value,
      accessCount: weightAccessCount.value,
      moodCongruence: weightMoodCongruence.value,
    }
  }

  async function retrieve(query: string, sessionId: string, options: { recordAccess?: boolean } = {}): Promise<ScoredMemoryFragment[]> {
    if (!enabled.value || !query.trim())
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []

    try {
      const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
      const embedding = await embedMemoryText(query)
      const results = await memoryRepository.search({
        embedding,
        mood: currentMood.value,
        weights: getScoreWeights(),
        limit: 3,
      })
      const reflexResults = [] as ScoredMemoryFragment[]
      // Rejected fragments are not facts and never get recalled.
      const muscleMemory = (await memoryRepository.list({ memoryType: 'muscle', limit: 100 }))
        .filter(fragment => fragment.reviewStatus !== 'rejected')
        .find(fragment => matchesMuscleMemory(fragment, query))
      if (muscleMemory) {
        reflexResults.push(scoreMemoryFragment({
          fragment: muscleMemory,
          similarity: 1,
          now: Date.now(),
          mood: currentMood.value,
          weights: getScoreWeights(),
        }))
      }

      if (intrusionEnabled.value) {
        const intrusiveMemory = selectIntrusiveMemory({
          fragments: (await memoryRepository.list({ limit: 10_000 })).filter(fragment => fragment.reviewStatus !== 'rejected'),
          now: Date.now(),
          baseRate: intrusionBaseRate.value,
          cooldownMs: intrusionCooldownMs.value,
        })
        if (intrusiveMemory && !reflexResults.some(result => result.id === intrusiveMemory.id)) {
          await memoryRepository.update(intrusiveMemory.id, { lastIntrudedAt: Date.now() })
          reflexResults.push(scoreMemoryFragment({
            fragment: intrusiveMemory,
            similarity: 0,
            now: Date.now(),
            mood: currentMood.value,
            weights: getScoreWeights(),
          }))
        }
      }
      const seen = new Set<string>()
      const returnedResults = [...reflexResults, ...results]
        .filter((result) => {
          if (seen.has(result.id))
            return false
          seen.add(result.id)
          return true
        })
        .slice(0, 3)
      if (options.recordAccess !== false) {
        await memoryRepository.recordAccess({
          memoryIds: returnedResults.map(result => result.id),
          sessionId,
        })
      }
      return returnedResults
    }
    catch (error) {
      databaseStatus.value = 'error'
      databaseError.value = errorMessageFrom(error) ?? 'Unknown memory retrieval error'
      return []
    }
  }

  async function captureTurn(input: MemoryTurnInput, extractor: MemoryTurnExtractor): Promise<MemoryFragment[]> {
    if (!captureEnabled.value)
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []

    try {
      const extractions = await extractor({ ...input, mood: currentMood.value })
      if (extractions.length === 0)
        return []

      return await persistExtractions(memoryRepository, extractions, input.sourceContext)
    }
    catch (error) {
      databaseStatus.value = 'error'
      databaseError.value = errorMessageFrom(error) ?? 'Unknown memory capture error'
      return []
    }
  }

  async function captureEvent(event: MemorySubscriptionEvent): Promise<MemoryFragment[]> {
    if (!captureEnabled.value)
      return []

    const extraction = memoryEventToExtraction(event)
    if (!extraction)
      return []

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []

    try {
      return await persistExtractions(memoryRepository, [extraction])
    }
    catch (error) {
      databaseStatus.value = 'error'
      databaseError.value = errorMessageFrom(error) ?? 'Unknown memory event capture error'
      return []
    }
  }

  async function list(memoryType?: MemoryFragment['memoryType']) {
    return (await initialize())?.list({ memoryType }) ?? []
  }

  async function update(id: string, patch: Parameters<MemoryRepository['update']>[1]) {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined

    if (patch.content === undefined)
      return memoryRepository.update(id, patch)

    const content = patch.content.trim()
    if (!content)
      throw new Error('Memory content must not be empty')

    const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    return memoryRepository.update(id, {
      ...patch,
      content,
      contentVector: await embedMemoryText(content),
    })
  }

  async function remove(id: string) {
    await (await initialize())?.remove(id)
  }

  /** Fragments waiting for the human confirmation gate (MEMORY-DESIGN §11.2). */
  async function listPending() {
    return (await initialize())?.list({ memoryType: 'short_term', reviewStatus: 'pending', limit: 100 }) ?? []
  }

  /** Approves or rejects a pending fragment (rejected ones never get recalled). */
  async function setReviewStatus(id: string, status: 'approved' | 'rejected') {
    return (await initialize())?.update(id, { reviewStatus: status })
  }

  /** Stores an approved tool trigger as a non-decaying muscle memory. */
  async function rememberMuscle(input: { content: string, triggerPattern: string }): Promise<MemoryFragment | undefined> {
    if (!enabled.value || !input.content.trim() || !input.triggerPattern.trim())
      return undefined

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined

    try {
      const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
      return await memoryRepository.insert({
        content: input.content.trim(),
        category: 'chat',
        memoryType: 'muscle',
        importance: 9,
        valence: 0,
        arousal: 0,
        tags: ['muscle', 'self-authored-tool'],
        triggerPattern: input.triggerPattern.trim(),
        reviewStatus: 'approved',
        embedding: await embedMemoryText(input.content),
      })
    }
    catch (error) {
      databaseStatus.value = 'error'
      databaseError.value = errorMessageFrom(error) ?? 'Unknown muscle memory error'
      return undefined
    }
  }

  async function refreshDreamIdeas(status?: MemoryDreamIdeaStatus): Promise<MemoryDreamIdea[]> {
    const memoryRepository = await initialize()
    if (!memoryRepository) {
      dreamIdeas.value = []
      return []
    }
    dreamIdeas.value = await memoryRepository.listDreamIdeas(status ? { status, limit: 100 } : { limit: 100 })
    return dreamIdeas.value
  }

  /** Runs one bounded dreaming pass; proposals stay ideas until a human changes their lifecycle. */
  async function dream(): Promise<MemoryDreamIdea[]> {
    if (!enabled.value || !dreamingEnabled.value || dreaming.value)
      return dreamIdeas.value

    const memoryRepository = await initialize()
    if (!memoryRepository)
      return []

    dreaming.value = true
    try {
      const [fragments, ideas] = await Promise.all([
        memoryRepository.list({ limit: 12 }),
        memoryRepository.listDreamIdeas({ limit: 100 }),
      ])
      const proposals = dreamAgent
        ? await dreamAgent({ fragments, ideas })
        : fragments.slice(0, 3).map(fragment => ({
            content: `Explore a practical follow-up to: ${fragment.content}`,
            sourceId: fragment.id,
            excitement: Math.min(10, fragment.importance + 2),
          }))
      const existing = new Set(ideas.map(idea => idea.content.trim().toLocaleLowerCase()))
      for (const proposal of proposals.slice(0, 3)) {
        const content = proposal.content.trim()
        if (!content || existing.has(content.toLocaleLowerCase()))
          continue
        const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
        await memoryRepository.addDreamIdea({
          content,
          sourceType: dreamAgent ? 'dream-agent' : 'dream-pass',
          sourceId: proposal.sourceId,
          excitement: proposal.excitement,
          embedding: await embedMemoryText(content),
        })
        existing.add(content.toLocaleLowerCase())
      }
      return await refreshDreamIdeas()
    }
    catch (error) {
      databaseStatus.value = 'error'
      databaseError.value = errorMessageFrom(error) ?? 'Unknown dreaming error'
      return dreamIdeas.value
    }
    finally {
      dreaming.value = false
    }
  }

  async function updateDreamIdea(id: string, patch: Parameters<MemoryRepository['updateDreamIdea']>[1]) {
    const memoryRepository = await initialize()
    if (!memoryRepository)
      return undefined
    const idea = await memoryRepository.updateDreamIdea(id, patch)
    await refreshDreamIdeas()
    return idea
  }

  function setMood(mood: MemoryMood) {
    currentMood.value = {
      valence: Math.max(-1, Math.min(1, mood.valence)),
      arousal: mood.arousal == null ? undefined : Math.max(0, Math.min(1, mood.arousal)),
    }
  }

  function setEmotion(emotion: { name: string, intensity: number }) {
    setMood(emotionToMood(emotion))
  }

  async function persistExtractions(memoryRepository: MemoryRepository, extractions: MemoryExtraction[], sourceContext?: MemorySourceContext): Promise<MemoryFragment[]> {
    const { embedMemoryText } = await import('../../services/memory/local-memory-embedding')
    const fragments: MemoryFragment[] = []
    for (const extraction of extractions) {
      const embedding = await embedMemoryText(extraction.content)
      fragments.push(await memoryRepository.insert({
        ...extraction,
        // MEMORY-DESIGN §11.2: fresh extractions wait for human approval
        // before they may be promoted to long-term memory.
        ...(extraction.reviewStatus === undefined ? { reviewStatus: 'pending' as const } : {}),
        ...(sourceContext ? { sourceContext } : {}),
        embedding,
        halfLifeHours: extraction.memoryType === 'short_term' ? shortTermHalfLifeHours.value : undefined,
      }))
    }
    const promotedIds = await memoryRepository.promoteEligible({
      minAccessCount: promotionAccessCount.value,
      minSessionCount: promotionSessionCount.value,
      halfLifeHours: longTermHalfLifeHours.value,
    })
    await mirrorPromotedToLongTermStore(memoryRepository, promotedIds, embedMemoryText)
    return fragments
  }

  /**
   * Mirrors fragments the local store just promoted into the long-term
   * Postgres store. Best-effort only: a failure or an unconfigured host
   * never turns a local promotion into an error, it just records the remote
   * status for the settings page.
   */
  async function mirrorPromotedToLongTermStore(
    memoryRepository: MemoryRepository,
    promotedIds: string[],
    embedMemoryText: (text: string) => Promise<number[]>,
  ): Promise<void> {
    if (promotedIds.length === 0 || !memoryHostPort || remoteStatus.value !== 'ready')
      return

    try {
      const promoted = new Set(promotedIds)
      const longTermFragments = await memoryRepository.list({ memoryType: 'long_term', limit: 1000 })
      for (const fragment of longTermFragments) {
        if (!promoted.has(fragment.id))
          continue
        await memoryHostPort.insert({
          content: fragment.content,
          memoryType: fragment.memoryType,
          category: fragment.category,
          importance: fragment.importance,
          valence: fragment.valence,
          arousal: fragment.arousal ?? undefined,
          sessionId: fragment.sessionIds.at(-1),
          reviewStatus: fragment.reviewStatus,
          embedding: await embedMemoryText(fragment.content),
        })
      }
    }
    catch (error) {
      remoteStatus.value = 'error'
      remoteError.value = errorMessageFrom(error) ?? 'Unknown long-term store error'
    }
  }

  /** Connects (or disconnects) the long-term Postgres store. */
  async function configureRemoteHost(connectionString: string): Promise<MemoryHostStatusLike> {
    if (!memoryHostPort) {
      remoteStatus.value = 'unconfigured'
      return { status: 'unconfigured', error: 'Memory host bridge is not installed in this window' }
    }

    pgConnectionString.value = connectionString
    const result = await memoryHostPort.configure({ connectionString: connectionString.trim() || undefined })
    remoteStatus.value = result.status
    remoteError.value = result.error
    return result
  }

  async function refreshRemoteHostStatus(): Promise<MemoryHostStatusLike> {
    if (!memoryHostPort) {
      remoteStatus.value = 'unconfigured'
      return { status: 'unconfigured' }
    }
    const result = await memoryHostPort.getStatus()
    remoteStatus.value = result.status
    remoteError.value = result.error
    return result
  }

  function resetState() {
    enabled.reset()
    captureEnabled.reset()
    compactionEnabled.reset()
    activeProvider.reset()
    activeModel.reset()
    compactionThreshold.reset()
    contextLengthOverride.reset()
    compactionRecentTurnLimit.reset()
    shortTermHalfLifeHours.reset()
    longTermHalfLifeHours.reset()
    promotionAccessCount.reset()
    promotionSessionCount.reset()
    weightSimilarity.reset()
    weightTimeRelevance.reset()
    weightArousal.reset()
    weightAccessCount.reset()
    weightMoodCongruence.reset()
    intrusionEnabled.reset()
    intrusionBaseRate.reset()
    intrusionCooldownMs.reset()
    dreamingEnabled.reset()
    pgConnectionString.reset()
    remoteStatus.value = 'unconfigured'
    remoteError.value = undefined
    dreamIdeas.value = []
    dreaming.value = false
    currentMood.value = { valence: 0, arousal: 0 }
  }

  return {
    enabled,
    captureEnabled,
    compactionEnabled,
    activeProvider,
    activeModel,
    compactionThreshold,
    contextLengthOverride,
    compactionRecentTurnLimit,
    shortTermHalfLifeHours,
    longTermHalfLifeHours,
    promotionAccessCount,
    promotionSessionCount,
    weightSimilarity,
    weightTimeRelevance,
    weightArousal,
    weightAccessCount,
    weightMoodCongruence,
    intrusionEnabled,
    intrusionBaseRate,
    intrusionCooldownMs,
    dreamingEnabled,
    pgConnectionString,
    remoteStatus,
    remoteError,
    configureRemoteHost,
    refreshRemoteHostStatus,
    dreamIdeas,
    dreaming,
    configured,
    databaseStatus,
    databaseError,
    currentMood,
    writeAccess,
    initialize,
    getScoreWeights,
    retrieve,
    captureTurn,
    captureEvent,
    list,
    update,
    remove,
    listPending,
    setReviewStatus,
    rememberMuscle,
    refreshDreamIdeas,
    dream,
    updateDreamIdea,
    setMood,
    setEmotion,
    resetState,
  }
}, {
  synced: {
    state: true,
  },
})
