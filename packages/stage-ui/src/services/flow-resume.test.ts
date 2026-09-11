import { describe, expect, it } from 'vitest'

import { verifyFlowResumeEnvironment } from './flow-resume'

const expected = {
  providerId: 'provider-a',
  model: 'model-a',
  workspaceRoot: 'D:/workspace',
  toolNames: ['read', 'write', 'plan_update'],
}

const current = {
  activeProviderId: 'provider-a',
  activeModel: 'model-a',
  providerConfigured: true,
  workspaceRoot: 'D:/workspace',
  tools: [
    { name: 'read', available: true },
    { name: 'write', available: true },
  ],
}

describe('flow resume environment verification', () => {
  it('accepts the same provider, model, workspace, and host tools', () => {
    expect(verifyFlowResumeEnvironment(expected, current)).toEqual({ ok: true })
  })

  it('blocks a configured provider when the active provider changed', () => {
    expect(verifyFlowResumeEnvironment(expected, { ...current, activeProviderId: 'provider-b' })).toEqual({
      ok: false,
      reason: 'active provider changed from "provider-a" to "provider-b"',
    })
  })

  it('blocks model and workspace changes', () => {
    expect(verifyFlowResumeEnvironment(expected, { ...current, activeModel: 'model-b' })).toEqual({
      ok: false,
      reason: 'active model changed from "model-a" to "model-b"',
    })
    expect(verifyFlowResumeEnvironment(expected, { ...current, workspaceRoot: 'D:/other' })).toEqual({
      ok: false,
      reason: 'workspace changed from "D:/workspace" to "D:/other"',
    })
  })

  it('blocks missing host status and unavailable tools', () => {
    expect(verifyFlowResumeEnvironment(expected, { ...current, tools: undefined })).toEqual({
      ok: false,
      reason: 'coding tool status is unavailable',
    })
    expect(verifyFlowResumeEnvironment(expected, {
      ...current,
      tools: [{ name: 'read', available: true }, { name: 'write', available: false }],
    })).toEqual({
      ok: false,
      reason: 'coding tools unavailable: write',
    })
  })

  it('does not require coding-host status for renderer-only tools', () => {
    expect(verifyFlowResumeEnvironment({ ...expected, toolNames: ['plan_update'] }, {
      ...current,
      tools: undefined,
    })).toEqual({ ok: true })
  })
})
