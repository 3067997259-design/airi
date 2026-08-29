import { describe, expect, it } from 'vitest'

import { matchesMuscleMemory, selectIntrusiveMemory } from './reflex'

const trauma = {
  id: 'trauma',
  content: 'A traumatic memory',
  memoryType: 'long_term' as const,
  category: 'life',
  importance: 10,
  emotionalImpact: -10,
  createdAt: 0,
  lastAccessed: 0,
  accessCount: 1,
  valence: -0.9,
  arousal: 0.95,
  halfLifeHours: 4_320,
  sessionIds: [],
  lastIntrudedAt: null,
}

describe('memory reflexes', () => {
  it('selects a rare intrusive memory without semantic input', () => {
    expect(selectIntrusiveMemory({
      fragments: [trauma],
      now: 100_000,
      random: () => 0,
    })).toBe(trauma)
  })

  it('keeps intrusive memory on cooldown', () => {
    expect(selectIntrusiveMemory({
      fragments: [{ ...trauma, lastIntrudedAt: 90_000 }],
      now: 100_000,
      random: () => 0,
    })).toBeUndefined()
  })

  it('matches muscle memory patterns', () => {
    expect(matchesMuscleMemory({ ...trauma, memoryType: 'muscle', triggerPattern: 'tea|coffee' }, 'Make tea')).toBe(true)
    expect(matchesMuscleMemory({ ...trauma, memoryType: 'muscle', triggerPattern: '[' }, 'Make tea')).toBe(false)
  })
})
