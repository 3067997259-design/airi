import { describe, expect, it } from 'vitest'

import { parseMemorySourceContext } from './source-context'

describe('parseMemorySourceContext', () => {
  it('accepts a source turn and bounds persisted neighbors', () => {
    const neighbors = Array.from({ length: 6 }, (_, index) => `neighbor-${index}`)

    expect(parseMemorySourceContext({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors,
    })).toEqual({
      sessionId: 'session-1',
      messageId: 'message-1',
      neighbors: ['neighbor-0', 'neighbor-1', 'neighbor-2', 'neighbor-3'],
    })
  })

  it('rejects malformed persisted source context', () => {
    expect(parseMemorySourceContext({ sessionId: 'session-1', neighbors: 'not-an-array' })).toBeUndefined()
    expect(parseMemorySourceContext(undefined)).toBeUndefined()
  })
})
