import { describe, expect, it } from 'vitest'

import { createSlashTriggerProvider } from './slash-trigger-provider'

describe('createSlashTriggerProvider', () => {
  it('places built-in commands before reviewed skills', async () => {
    const provider = createSlashTriggerProvider(
      () => [{ toolId: 'plan-helper', name: 'plan_helper', description: 'A reviewed skill.' }],
      key => key,
    )

    const sections = await provider.getSections('plan')

    expect(sections.map(section => section.id)).toEqual(['commands', 'skills'])
    expect(sections[0]?.items[0]).toEqual(expect.objectContaining({ label: '/plan', replacement: '/plan ', badge: 'stage.command.badge' }))
    expect(sections[1]?.items[0]).toEqual(expect.objectContaining({ label: 'plan_helper', replacement: '/plan_helper ' }))
  })
})
