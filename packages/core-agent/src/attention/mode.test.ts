import { describe, expect, it } from 'vitest'

import { buildAttentionModeSection, resolveAttentionMode } from './mode'

describe('attention mode', () => {
  it('uses casual mode without an active task', () => {
    expect(resolveAttentionMode([{ status: 'blocked' }, { status: 'done' }])).toBe('casual')
    expect(buildAttentionModeSection('casual')).toContain('No task requires active attention.')
  })

  it('uses focused mode for an active task', () => {
    expect(resolveAttentionMode([{ status: 'done' }, { status: 'active' }])).toBe('focused')
    expect(buildAttentionModeSection('focused')).toContain('prioritize correct task progress')
  })

  it('keeps casual mode when focused mode is disabled', () => {
    expect(resolveAttentionMode([{ status: 'active' }], false)).toBe('casual')
  })
})
