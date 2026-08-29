import { describe, expect, it } from 'vitest'

import { canProveMutation, resolveEvidenceAuthority } from './provenance'

describe('evidence provenance', () => {
  it('maps tool_result by producer to the four-tier table', () => {
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'builtin').precedence).toBe(40)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'reviewed_self_authored').precedence).toBe(42)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'remote_agent').precedence).toBe(45)
    expect(resolveEvidenceAuthority({ source: 'tool_result' }, 'unreviewed_self_authored').precedence).toBe(47)
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
