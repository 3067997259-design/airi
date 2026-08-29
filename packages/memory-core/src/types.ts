export type MemoryType = 'working' | 'short_term' | 'long_term' | 'muscle'

export type MemoryCategory = 'chat' | 'relationships' | 'people' | 'life' | (string & {})

/**
 * Human confirmation gate (MEMORY-DESIGN §11.2): fresh extractions land as
 * `pending`; only `approved` fragments may be promoted to long-term.
 * `undefined` means the record predates the gate (treated as approved).
 */
export type MemoryReviewStatus = 'pending' | 'approved' | 'rejected'

/** Lifecycle state for a bounded idea produced by the dreaming pass. */
export type MemoryDreamIdeaStatus = 'new' | 'developing' | 'implemented' | 'abandoned'

/** A short-term idea that must remain separate from factual memory. */
export interface MemoryDreamIdea {
  id: string
  content: string
  sourceType: string
  sourceId?: string | null
  status: MemoryDreamIdeaStatus
  excitement: number
  createdAt: number
  updatedAt: number
  contentVector?: number[]
}

/** Source turn context stored with a memory fragment for later neighbor recall. */
export interface MemorySourceContext {
  /** Session that produced the fragment. */
  sessionId: string
  /** User message that anchors the fragment when one exists. */
  messageId?: string
  /** Bounded conversation messages around the source turn. */
  neighbors: string[]
}

/** A memory fragment with the data required by scoring and lifecycle rules. */
export interface MemoryFragment {
  id: string
  content: string
  memoryType: MemoryType
  category: MemoryCategory
  importance: number
  emotionalImpact: number
  createdAt: number
  lastAccessed: number
  accessCount: number
  valence: number
  arousal: number
  halfLifeHours: number
  sessionIds: string[]
  triggerPattern?: string | null
  lastIntrudedAt?: number | null
  reviewStatus?: MemoryReviewStatus
  contentVector?: number[]
  sourceContext?: MemorySourceContext
}

/** Structured memory data produced by an integration or a future extractor model. */
export interface MemoryExtraction {
  content: string
  category: MemoryCategory
  memoryType: Exclude<MemoryType, 'working' | 'long_term'>
  importance: number
  valence: number
  arousal: number
  tags: string[]
  halfLifeHours?: number
  sessionId?: string
  episodic?: {
    eventType: string
    participants: string[]
    location?: string
  }
  triggerPattern?: string
  reviewStatus?: MemoryReviewStatus
  sourceContext?: MemorySourceContext
}

/** Stable event types that the memory layer is allowed to retain. */
export type MemorySubscriptionEventType = 'task:done' | 'event:reaction' | 'reaction'

/** Event envelope accepted by the memory subscription filter. */
export interface MemorySubscriptionEvent {
  type: string
  data?: unknown
  sessionId?: string
}

/** Current affect used by mood-congruent retrieval. */
export interface MemoryMood {
  valence: number
  arousal?: number
}

/** Adjustable coefficients for the five-term memory ranking formula. */
export interface MemoryScoreWeights {
  similarity: number
  timeRelevance: number
  arousal: number
  accessCount: number
  moodCongruence: number
}

/** Default exploratory weights from MEMORY-DESIGN.md. */
export const DEFAULT_MEMORY_SCORE_WEIGHTS: Readonly<MemoryScoreWeights> = Object.freeze({
  similarity: 1.2,
  timeRelevance: 0.2,
  arousal: 0.3,
  accessCount: 0.15,
  moodCongruence: 0.25,
})

/** Default half-life values in hours for persisted memory layers. */
export const DEFAULT_MEMORY_HALF_LIFE_HOURS: Readonly<Record<Exclude<MemoryType, 'working'>, number>> = Object.freeze({
  short_term: 24,
  long_term: 4_320,
  muscle: 1e9,
})

/** Result of applying the memory score to one candidate. */
export interface ScoredMemoryFragment extends MemoryFragment {
  similarity: number
  timeRelevance: number
  moodCongruence: number
  score: number
}

/** A storage-neutral memory repository contract for Postgres and browser fallbacks. */
export interface MemoryRepository {
  search: (input: {
    embedding: number[]
    now?: number
    mood?: MemoryMood
    limit?: number
    similarityThreshold?: number
    weights?: Partial<MemoryScoreWeights>
  }) => Promise<ScoredMemoryFragment[]>
  insert: (input: MemoryExtraction & { embedding?: number[], now?: number }) => Promise<MemoryFragment>
  recordAccess: (input: { memoryIds: string[], sessionId?: string, now?: number }) => Promise<void>
  promoteEligible: (input?: { minAccessCount?: number, minSessionCount?: number, halfLifeHours?: number }) => Promise<string[]>
  list: (input?: { memoryType?: MemoryType, reviewStatus?: MemoryReviewStatus, limit?: number }) => Promise<MemoryFragment[]>
  update: (id: string, patch: Partial<Pick<MemoryFragment, 'content' | 'category' | 'importance' | 'valence' | 'arousal' | 'triggerPattern' | 'lastIntrudedAt' | 'reviewStatus' | 'contentVector'>>) => Promise<MemoryFragment | undefined>
  remove: (id: string) => Promise<void>
  addDreamIdea: (input: { content: string, sourceType?: string, sourceId?: string, excitement?: number, embedding?: number[], now?: number }) => Promise<MemoryDreamIdea>
  listDreamIdeas: (input?: { status?: MemoryDreamIdeaStatus, limit?: number }) => Promise<MemoryDreamIdea[]>
  updateDreamIdea: (id: string, patch: Partial<Pick<MemoryDreamIdea, 'content' | 'status' | 'excitement' | 'contentVector'>>) => Promise<MemoryDreamIdea | undefined>
}
