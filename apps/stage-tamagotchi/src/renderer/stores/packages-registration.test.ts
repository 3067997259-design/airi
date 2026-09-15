import type { ActivePackageSummary } from '@proj-airi/stage-ui/stores/modules/packages'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/ai/chat-llm/tools'
import { installPackageRuntimePort, usePackagesStore } from '@proj-airi/stage-ui/stores/modules/packages'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const leader = vi.hoisted(() => ({ value: true }))

vi.mock('../window-context', () => ({
  isSyncedLeaderWindow: () => leader.value,
}))

vi.mock('@proj-airi/stage-ui/stores/skills', () => ({
  useSkillsReviewStore: () => ({ executeReviewedSkill: vi.fn(async () => 'ok') }),
}))

function packageFixture(overrides: Partial<ActivePackageSummary> = {}): ActivePackageSummary {
  return {
    packageId: 'demo-pack',
    version: '1.0.0',
    digest: 'digest-1',
    tools: [{
      name: 'demo_tool',
      description: 'Demo tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      skill: { toolId: 'skill-a', contentHash: 'hash-a' },
    }],
    ...overrides,
  }
}

describe('usePackageToolsRegistrationStore', () => {
  let active: ActivePackageSummary[]

  beforeEach(() => {
    setActivePinia(createPinia())
    leader.value = true
    active = []
    installPackageRuntimePort({
      list: async () => [],
      active: async () => active,
      pickArchive: async () => ({}),
      pickDirectory: async () => ({}),
      importPackage: async () => ({ packageId: '', version: '', entries: [] }),
      trial: async () => { throw new Error('not used') },
      approve: async () => { throw new Error('not used') },
      activate: async () => { throw new Error('not used') },
      deactivate: async () => [],
      rollback: async () => { throw new Error('not used') },
      uninstall: async () => [],
    })
  })

  it('registers an active package as a plugin tool bound to its reviewed skill', async () => {
    const { usePackageToolsRegistrationStore } = await import('./packages-registration')
    const llmToolsStore = useLlmToolsStore()
    const packagesStore = usePackagesStore()
    usePackageToolsRegistrationStore()

    active = [packageFixture()]
    await packagesStore.refresh()

    await vi.waitFor(() => expect(llmToolsStore.tools).toHaveLength(1))
    expect(llmToolsStore.tools[0]?.id).toBe('plugin:demo-pack@1.0.0:demo_tool')
    expect(llmToolsStore.registrations[0]).toMatchObject({
      toolId: 'plugin:demo-pack@1.0.0:demo_tool',
      toolName: 'demo_tool',
      ownerKind: 'plugin',
      ownerId: 'demo-pack@1.0.0',
      execution: {
        kind: 'coding_sandbox',
        chain: ['plugin:demo-pack@digest-1', 'skill:skill-a@hash-a'],
      },
      approvedContentHash: 'digest-1',
    })
  })

  it('replaces the package tools when the same version is re-approved with a new digest', async () => {
    const { usePackageToolsRegistrationStore } = await import('./packages-registration')
    const llmToolsStore = useLlmToolsStore()
    const packagesStore = usePackagesStore()
    usePackageToolsRegistrationStore()

    active = [packageFixture()]
    await packagesStore.refresh()
    await vi.waitFor(() => expect(llmToolsStore.registrations).toHaveLength(1))

    active = [packageFixture({ digest: 'digest-2' })]
    await packagesStore.refresh()

    await vi.waitFor(() => expect(llmToolsStore.registrations[0]?.approvedContentHash).toBe('digest-2'))
    expect(llmToolsStore.registrations).toHaveLength(1)
    expect(llmToolsStore.registrations[0]?.execution.chain).toEqual(['plugin:demo-pack@digest-2', 'skill:skill-a@hash-a'])
  })

  it('removes the package tools when activation is withdrawn', async () => {
    const { usePackageToolsRegistrationStore } = await import('./packages-registration')
    const llmToolsStore = useLlmToolsStore()
    const packagesStore = usePackagesStore()
    usePackageToolsRegistrationStore()

    active = [packageFixture()]
    await packagesStore.refresh()
    await vi.waitFor(() => expect(llmToolsStore.tools).toHaveLength(1))

    active = []
    await packagesStore.refresh()

    await vi.waitFor(() => expect(llmToolsStore.tools).toHaveLength(0))
    expect(llmToolsStore.registrations).toHaveLength(0)
  })

  it('does not register anything in a follower window', async () => {
    const { usePackageToolsRegistrationStore } = await import('./packages-registration')
    const llmToolsStore = useLlmToolsStore()
    const packagesStore = usePackagesStore()
    usePackageToolsRegistrationStore()

    leader.value = false
    active = [packageFixture()]
    await packagesStore.refresh()
    await Promise.resolve()

    expect(llmToolsStore.tools).toHaveLength(0)
  })
})
