import { describe, expect, it } from 'vitest'

import { discoverGameCapabilities } from './capabilities'

describe('discoverGameCapabilities', () => {
  it('announces a capability only when its backing tool is present', () => {
    const capabilities = discoverGameCapabilities(['get_self', 'get_blocks_region'])
    expect(capabilities['collision-snapshot']).toEqual({ available: true, tools: ['get_blocks_region'] })
    expect(capabilities['control-session'].available).toBe(false)
    expect(capabilities['control-session'].limit).toContain('tool_unavailable')
  })

  it('returns a typed limit for every capability with no backing tool', () => {
    const capabilities = discoverGameCapabilities([])
    for (const status of Object.values(capabilities)) {
      expect(status.available).toBe(false)
      expect(status.limit).toContain('tool_unavailable')
      expect(status.tools).toEqual([])
    }
    // Ballistic profiles are a later batch, so they are honestly unavailable now.
    expect(capabilities['ballistic-profiles'].available).toBe(false)
  })

  it('matches any one tool of a capability group', () => {
    const capabilities = discoverGameCapabilities(['query_entities', 'set_movement', 'stop_movement', 'get_block'])
    expect(capabilities['target-observation'].tools).toEqual(['query_entities'])
    expect(capabilities['control-session'].tools).toEqual(['set_movement', 'stop_movement'])
    expect(capabilities['break-evidence'].tools).toEqual(['get_block'])
  })
})
