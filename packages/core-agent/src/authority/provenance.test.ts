import { describe, expect, it } from 'vitest'

import { canProveMutation, resolveEvidenceAuthority } from './provenance'

describe('evidence provenance', () => {
  it('maps tool_result by producer to the four-tier table', () => {
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'builtin').precedence).toBe(40)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'reviewed_self_authored').precedence).toBe(42)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'remote_agent').precedence).toBe(45)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'unreviewed_self_authored').precedence).toBe(47)
  })

  it('maps the game and plugin buckets added by EP-0', () => {
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'game_checked').precedence).toBe(41)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'game').precedence).toBe(44)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'untrusted_plugin').precedence).toBe(46)
  })

  it('resolves every declared author instead of falling through to undefined', () => {
    const authors = ['builtin', 'reviewed_self_authored', 'unreviewed_self_authored', 'remote_agent', 'untrusted_plugin', 'game', 'game_checked'] as const
    for (const author of authors)
      expect(resolveEvidenceAuthority({ source: 'tool_result' }, author).source).toBeTruthy()
  })

  it('requires a producer for tool_result evidence', () => {
    expect(() => resolveEvidenceAuthority({ source: 'tool_result' })).toThrow(/requires a producer/)
  })

  it('maps non-tool sources without a producer', () => {
    expect(resolveEvidenceAuthority({ source: 'verification_gate' }).precedence).toBe(30)
    expect(resolveEvidenceAuthority({ source: 'human_approval' }).precedence).toBe(20)
    expect(resolveEvidenceAuthority({ source: 'runtime_trace' }).precedence).toBe(60)
  })

  it('only builtin and reviewed self-authored evidence can prove mutations', () => {
    expect(canProveMutation({ source: 'tool_result' }, 'builtin')).toBe(true)
    expect(canProveMutation({ source: 'tool_result' }, 'reviewed_self_authored')).toBe(true)
    expect(canProveMutation({ source: 'tool_result' }, 'remote_agent')).toBe(false)
    expect(canProveMutation({ source: 'tool_result' }, 'unreviewed_self_authored')).toBe(false)
    expect(canProveMutation({ source: 'verification_gate' })).toBe(false)
    expect(canProveMutation({ source: 'human_approval' })).toBe(false)
    expect(canProveMutation({ source: 'runtime_trace' })).toBe(false)
  })
})
