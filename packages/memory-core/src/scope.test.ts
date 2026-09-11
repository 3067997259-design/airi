import { describe, expect, it } from 'vitest'

import { isSameMemoryScope } from './types'

describe('isSameMemoryScope', () => {
  it('requires both the user and character to match', () => {
    const scope = { userId: 'user-1', characterId: 'character-a' }

    expect(isSameMemoryScope(scope, { ...scope })).toBe(true)
    expect(isSameMemoryScope(scope, { userId: 'user-2', characterId: 'character-a' })).toBe(false)
    expect(isSameMemoryScope(scope, { userId: 'user-1', characterId: 'character-b' })).toBe(false)
    expect(isSameMemoryScope(scope, undefined)).toBe(false)
  })
})
