export type MemoryType = 'working' | 'short_term' | 'long_term' | 'muscle'

/** Input role used by an embedding provider. Stored memory content is a document. */
export type MemoryEmbeddingInputType = 'query' | 'document'

/** Lifecycle of one stored vector in its embedding space. */
export type MemoryEmbeddingStatus = 'active' | 'stale'

/** Metadata that identifies one vector space and the text role used to create it. */
export interface MemoryEmbeddingMetadata {
  embeddingProvider: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingInputType: MemoryEmbeddingInputType
  embeddingSourceFingerprint: string
  embeddedAt: number
  embeddingStatus: MemoryEmbeddingStatus
}

/** Query-side metadata used to reject vectors from another provider or model. */
export type MemoryEmbeddingQueryMetadata = Omit<MemoryEmbeddingMetadata, 'embeddingInputType' | 'embeddedAt' | 'embeddingStatus'> & {
  embeddingInputType: 'query'
}

export type MemoryCategory = 'chat' | 'relationships' | 'people' | 'life' | (string & {})

/** Durable ownership scope for facts that can enter a character's behavior prompt. */
export interface MemoryScope {
  /** Authenticated user or the local profile identifier. */
  userId: string
  /** Active character-card identifier. */
  characterId: string
}

/** Returns true when two memory records belong to the same user and character. */
export function isSameMemoryScope(left: MemoryScope | undefined, right: MemoryScope | undefined): boolean {
  return !!left
    && !!right
    && left.userId === right.userId
    && left.characterId === right.characterId
}

/**
 * Human confirmation gate (MEMORY-DESIGN §11.2): fresh extractions land as
 * `pending`; only `approved` fragments may be promoted to long-term.
 * `undefined` means the record predates the gate (treated as approved).
 */
export type MemoryReviewStatus = 'pending' | 'approved' | 'rejected'

/** Lifecycle of a factual claim after review. */
export type MemoryFactStatus = 'active' | 'superseded' | 'disputed'

/** Lifecycle state for a bounded idea produced by the dreaming pass. */
export type MemoryDreamIdeaStatus = 'new' | 'developing' | 'implemented' | 'abandoned'

/** A short-term idea that must remain separate from factual memory. */
export interface MemoryDreamIdea {
  /** Missing ownership excludes archived ideas from character prompts. */
  scope?: MemoryScope
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
  /** External event id that produced the fragment when the source is not a chat turn. */
  sourceEventId?: string
  /** Source kind used to explain why the event was retained. */
  sourceType?: string
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
  /** Claim lifecycle; legacy rows without this field are treated as active. */
  factStatus?: MemoryFactStatus
  /** Previous claim replaced by this reviewed revision, when present. */
  supersedesId?: string | null
  /** Shared key for claims that cannot currently be reconciled. */
  conflictGroup?: string | null
  /** Stable local id used for idempotent long-term mirroring. */
  originId?: string | null
  /** Ownership scope. Missing scope marks a legacy row that is not prompt-safe. */
  scope?: MemoryScope
  /** Provider metadata for the content vector. Missing values identify legacy rows. */
  embeddingProvider?: string
  embeddingModel?: string
  embeddingDimensions?: number
  embeddingInputType?: MemoryEmbeddingInputType
  embeddingSourceFingerprint?: string
  embeddedAt?: number
  embeddingStatus?: MemoryEmbeddingStatus
  contentVector?: number[]
  sourceContext?: MemorySourceContext
}

/**
 * Structured memory data produced by an integration or a future extractor model.
 *
 * Ordinary extraction only produces facts: `memoryType` is locked to
 * `short_term` so a chat-turn extractor can neither persist a `muscle` reflex
 * nor claim `long_term` directly (MEMORY-SEMANTICS-CORRECTION §2.1). Muscle
 * writes go through the explicit muscle entry point, and promotion to
 * `long_term` stays owned by the promotion pass.
 */
export interface MemoryExtraction {
  content: string
  category: MemoryCategory
  memoryType: 'short_term'
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
  /**
   * Not used by ordinary fact extraction; the repository input reuses this
   * contract and only an explicit muscle write supplies a trigger pattern.
   */
  triggerPattern?: string
  reviewStatus?: MemoryReviewStatus
  factStatus?: MemoryFactStatus
  supersedesId?: string
  conflictGroup?: string
  /** Stable local id used for idempotent long-term mirroring. */
  originId?: string
  /** Scope supplied by the owning runtime, never inferred from model text. */
  scope?: MemoryScope
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

/** Default exploratory weights from docs/fork/MEMORY-DESIGN.md. */
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

/**
 * Default minimum cosine similarity for semantic recall.
 *
 * Recalibrated after the embedding backend moved to Voyage (with `input_type`
 * set) on 2026-09-05: a short related Chinese query scores ~0.54, a full
 * paraphrased turn ~0.12, and unrelated questions 0.10 — the related/noise
 * margin is now wide, so 0.5 locks out noise while keeping short recall.
 * Long paraphrased turn recall is a known gap; treat those as background and
 * rely on short, direct questions. Revisit in MEMORY-SEMANTICS-CORRECTION §9.1.
 */
export const DEFAULT_MEMORY_SIMILARITY_THRESHOLD = 0.5

/** Result of applying the memory score to one candidate. */
export interface ScoredMemoryFragment extends MemoryFragment {
  similarity: number
  timeRelevance: number
  moodCongruence: number
  score: number
  /** Similarity from the original query when dual retrieval is enabled. */
  originalSimilarity?: number
  /** Similarity from the normalized query when dual retrieval is enabled. */
  normalizedSimilarity?: number
  /** Query path that produced the merged candidate. */
  retrievalQuery?: 'original' | 'normalized' | 'both'
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
    embeddingMetadata?: MemoryEmbeddingQueryMetadata
    scope?: MemoryScope
  }) => Promise<ScoredMemoryFragment[]>
  /**
   * Stores a fragment. `long_term` is allowed here because the promotion
   * mirror legitimately replays already-promoted facts into the remote store;
   * the write path policy lives in {@link MemoryExtraction}, whose `memoryType`
   * forbids the extractor from emitting `long_term` directly.
   */
  insert: (input: Omit<MemoryExtraction, 'memoryType'> & { memoryType: Exclude<MemoryType, 'working'>, embedding?: number[], embeddingMetadata?: MemoryEmbeddingMetadata, now?: number }) => Promise<MemoryFragment>
  recordAccess: (input: { memoryIds: string[], sessionId?: string, now?: number }) => Promise<void>
  promoteEligible: (input?: { minAccessCount?: number, minSessionCount?: number, halfLifeHours?: number, scope?: MemoryScope }) => Promise<string[]>
  /**
   * Lists fragments ordered by last access.
   *
   * `shareable` pushes the social-candidate eligibility rules (actionable fact
   * plus a usable source context) into the query. Without it, a caller that
   * filtered a top-N page in memory could never see an eligible fact outside
   * that page (ACC-20260911 #12).
   */
  list: (input?: { memoryType?: MemoryType, reviewStatus?: MemoryReviewStatus, limit?: number, scope?: MemoryScope, shareable?: boolean }) => Promise<MemoryFragment[]>
  /**
   * Patches a fragment in place. `memoryType` and `halfLifeHours` exist for
   * the manual muscle-to-fact migration, which preserves the original id and
   * access history; ordinary capture never retypes a fragment.
   */
  update: (id: string, patch: Partial<Pick<MemoryFragment, 'content' | 'category' | 'importance' | 'valence' | 'arousal' | 'triggerPattern' | 'lastIntrudedAt' | 'reviewStatus' | 'factStatus' | 'supersedesId' | 'conflictGroup' | 'contentVector' | 'memoryType' | 'halfLifeHours' | 'embeddingProvider' | 'embeddingModel' | 'embeddingDimensions' | 'embeddingInputType' | 'embeddingSourceFingerprint' | 'embeddedAt' | 'embeddingStatus'>> & { embeddingMetadata?: MemoryEmbeddingMetadata | null }) => Promise<MemoryFragment | undefined>
  remove: (id: string) => Promise<void>
  addDreamIdea: (input: { content: string, sourceType?: string, sourceId?: string, excitement?: number, embedding?: number[], now?: number, scope?: MemoryScope }) => Promise<MemoryDreamIdea>
  listDreamIdeas: (input?: { status?: MemoryDreamIdeaStatus, limit?: number, scope?: MemoryScope }) => Promise<MemoryDreamIdea[]>
  updateDreamIdea: (id: string, patch: Partial<Pick<MemoryDreamIdea, 'content' | 'status' | 'excitement' | 'contentVector'>>) => Promise<MemoryDreamIdea | undefined>
}
