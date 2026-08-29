export { calculateMemoryDecay, calculateMemoryTimeRelevance } from './decay'
export { emotionToMood } from './emotion'
export { memoryEventToExtraction } from './events'
export { promoteMemory, shouldPromoteMemory } from './promotion'
export {
  calculateIntrusionProbability,
  DEFAULT_INTRUSION_BASE_RATE,
  DEFAULT_INTRUSION_COOLDOWN_MS,
  isIntrusiveMemoryCandidate,
  matchesMuscleMemory,
  selectIntrusiveMemory,
} from './reflex'
export { calculateMemoryScore, scoreMemoryFragment } from './score'
export { parseMemorySourceContext } from './source-context'
export {
  DEFAULT_MEMORY_HALF_LIFE_HOURS,
  DEFAULT_MEMORY_SCORE_WEIGHTS,
} from './types'
export type {
  MemoryCategory,
  MemoryDreamIdea,
  MemoryDreamIdeaStatus,
  MemoryExtraction,
  MemoryFragment,
  MemoryMood,
  MemoryRepository,
  MemoryReviewStatus,
  MemoryScoreWeights,
  MemorySourceContext,
  MemorySubscriptionEvent,
  MemorySubscriptionEventType,
  MemoryType,
  ScoredMemoryFragment,
} from './types'
