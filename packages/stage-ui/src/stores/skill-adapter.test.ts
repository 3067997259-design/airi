import { describe, expect, it } from 'vitest'

import { DEFAULT_SKILL_ADAPTER_ID, skillAdapterRegistrationFor, skillAdapterToolId, skillAdapterToolRegistration } from './skill-adapter'

const skill = {
  toolId: 'flip-text',
  toolName: 'flip_text',
  description: 'Flip text.',
  parameters: { type: 'object', properties: {} },
  contentHash: 'hash-a',
}

describe('skill adapter contract', () => {
  it('binds the registration to the reviewed skill and its hash', () => {
    expect(skillAdapterRegistrationFor(skill)).toEqual({
      ownerKind: 'plugin',
      ownerId: DEFAULT_SKILL_ADAPTER_ID,
      execution: { kind: 'coding_sandbox', chain: ['plugin:skill-adapter', 'skill:flip-text'] },
      approvedContentHash: 'hash-a',
      tools: [{
        toolName: 'flip_text',
        skillToolId: 'flip-text',
        description: 'Flip text.',
        inputSchema: { type: 'object', properties: {} },
      }],
    })
  })

  it('derives a registration id distinct from the direct skill id', () => {
    expect(skillAdapterToolId('flip-text')).toBe('plugin:skill-adapter:flip-text')
    expect(skillAdapterToolId('flip-text')).not.toBe('self-authored:flip-text')
  })

  it('projects one adapter tool into the tool-store record', () => {
    const registration = skillAdapterRegistrationFor(skill)
    expect(skillAdapterToolRegistration(registration, registration.tools[0]!)).toEqual({
      toolId: 'plugin:skill-adapter:flip-text',
      toolName: 'flip_text',
      ownerKind: 'plugin',
      ownerId: 'skill-adapter',
      execution: { kind: 'coding_sandbox', chain: ['plugin:skill-adapter', 'skill:flip-text'] },
      approvedContentHash: 'hash-a',
    })
  })
})
