import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { createSyncedPiniaPlugin } from 'pinia-plugin-synced'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import SkillSourceReview from '../components/scenarios/chat/components/skill-source-review.vue'

import { beginRestoreGate, completeRestoreGate, releaseRestoreEffectHold } from '../services/restore-gate'
import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useLlmToolsetPromptsStore } from './ai/chat-llm/toolset-prompts'
import { contentHashOf, installSkillRuntime, OPENCODE_ADAPTER_SKELETON, useSkillsReviewStore } from './skills'

const contexts: ReturnType<typeof createPinia>[] = []
const runtimes: SyncedPiniaRuntime[] = []

afterEach(() => {
  completeRestoreGate()
  runtimes.splice(0).forEach(runtime => runtime.dispose())
  contexts.splice(0).forEach(disposePinia)
  localStorage.clear()
  installSkillRuntime(undefined)
})

describe('skill snapshot persistence', () => {
  it('requires source display before approval and shows a stale-source error', async () => {
    let source = 'export function run() { return "reviewed bytes" }'
    installSkillRuntime({
      readSource: async () => source,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const pinia = createPinia()
    contexts.push(pinia)
    setActivePinia(pinia)
    const store = useSkillsReviewStore()
    await store.submit({ ...OPENCODE_ADAPTER_SKELETON, toolId: 'review-panel', contentHash: contentHashOf(source) })
    const target = document.createElement('div')
    document.body.append(target)
    const app = createApp({ render: () => h(SkillSourceReview, { entry: store.queue[0]! }) })
    app.use(pinia)
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }))
    app.mount(target)
    try {
      const [view, approve] = target.querySelectorAll('button')
      expect(approve?.disabled).toBe(true)
      // A disabled approve button alone was a silent dead end (ACC-20260911
      // #19); the hint names the missing step.
      expect(target.textContent).toContain('settings.pages.modules.skills.sections.queue.approve-requires-source')
      view!.click()
      await vi.waitFor(() => expect(target.querySelector('pre')?.textContent).toBe(source))
      expect(approve?.disabled).toBe(false)
      expect(target.textContent).not.toContain('approve-requires-source')
      source = 'export function run() { return "different bytes" }'
      approve!.click()
      await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('source changed'))
      expect(store.queue[0]?.trust).toBe('probation')
      expect(approve?.disabled).toBe(true)
    }
    finally {
      app.unmount()
      target.remove()
    }
  })
  it('keeps restored skills inert until the profile is adopted', async () => {
    const first = createPinia()
    contexts.push(first)
    setActivePinia(first)
    const firstStore = useSkillsReviewStore()
    await firstStore.submit(OPENCODE_ADAPTER_SKELETON)
    await firstStore.approve(OPENCODE_ADAPTER_SKELETON.toolId, await firstStore.readForReview(OPENCODE_ADAPTER_SKELETON.toolId))

    beginRestoreGate()
    completeRestoreGate(true)
    const restored = createPinia()
    contexts.push(restored)
    setActivePinia(restored)
    const restoredStore = useSkillsReviewStore()

    await restoredStore.restore()
    expect(useLlmToolsStore().tools).toHaveLength(0)

    releaseRestoreEffectHold()
    await restoredStore.restore()
    expect(useLlmToolsStore().tools).toHaveLength(1)
  })

  it('keeps a damaged registry intact and refuses new submissions', async () => {
    localStorage.setItem('skills/review-queue', '{broken')
    const pinia = createPinia()
    contexts.push(pinia)
    setActivePinia(pinia)
    const store = useSkillsReviewStore()
    expect(store.persistenceError).toBeTruthy()
    expect((await store.submit(OPENCODE_ADAPTER_SKELETON)).accepted).toBe(false)
    expect(localStorage.getItem('skills/review-queue')).toBe('{broken')
  })

  it('rechecks restored artifacts and refuses changed source before sandbox execution', async () => {
    // ROOT CAUSE:
    // Persisted trust was enough to register a tool and the sandbox read the
    // current file. An edit therefore executed with an unrelated old review.
    let source = 'export function run(input) { return input }'
    const runProgram = vi.fn(async (_params: { program: string }) => ({ ok: true as const, value: 'checked', logs: [] }))
    installSkillRuntime({
      readSource: async () => source,
      runProgram,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const first = createPinia()
    contexts.push(first)
    setActivePinia(first)
    const firstStore = useSkillsReviewStore()
    await firstStore.submit({
      ...OPENCODE_ADAPTER_SKELETON,
      toolId: 'local-report',
      contentHash: contentHashOf(source),
      tool: {
        ...OPENCODE_ADAPTER_SKELETON.tool,
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    })
    await firstStore.approve('local-report', await firstStore.readForReview('local-report'))

    const restarted = createPinia()
    contexts.push(restarted)
    setActivePinia(restarted)
    const store = useSkillsReviewStore()
    expect(store.reviewedSkills).toHaveLength(0)
    await store.restore()
    await store.restore()
    const tools = useLlmToolsStore()
    expect(tools.tools).toHaveLength(1)
    const [tool] = tools.getToolsByNames('opencode_delegate')
    await tool!.execute({}, { messages: [], toolCallId: 'first' })
    expect(runProgram).toHaveBeenCalledTimes(1)
    expect(runProgram.mock.calls[0]?.[0].program).toContain(JSON.stringify(source))

    source = 'export function run() { throw new Error("changed") }'
    await tool!.execute({}, { messages: [], toolCallId: 'changed' })
    expect(runProgram).toHaveBeenCalledTimes(1)
    expect(store.queue[0]?.artifactError).toContain('changed')
    expect(tools.tools).toHaveLength(0)
  })

  it('tells the model which reviewed skills are unavailable and why', async () => {
    // ROOT CAUSE:
    //
    // A reviewed skill blocked by artifact verification was filtered out of
    // the tool list with no model-facing explanation. The model could only
    // report "not in the tool list" and fell back to unrelated discovery tools
    // (ACC-20260910 R05). The unavailable entry and its reason must reach the
    // toolset prompt, and the skill must stay uncallable.
    const source = 'export function run(input) { return input }'
    let workspaceRoot = 'original-workspace'
    installSkillRuntime({
      getWorkspaceRoot: async () => workspaceRoot,
      readSource: async () => source,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const pinia = createPinia()
    contexts.push(pinia)
    setActivePinia(pinia)
    const store = useSkillsReviewStore()
    await store.submit({
      ...OPENCODE_ADAPTER_SKELETON,
      toolId: 'blocked-skill',
      name: 'blocked_skill',
      contentHash: contentHashOf(source),
    })
    await store.approve('blocked-skill', await store.readForReview('blocked-skill'))

    // The profile is restored into a different workspace: verification refuses
    // to rebind the recorded artifact.
    workspaceRoot = 'restored-copy-workspace'
    await store.restore()

    expect(useLlmToolsStore().tools.filter(tool => tool.id === 'self-authored:blocked-skill')).toEqual([])
    const prompt = useLlmToolsetPromptsStore().renderFor('work')
    expect(prompt).toContain('blocked_skill')
    expect(prompt).toContain('blocked-skill')
    expect(prompt).toContain('different workspace')
    expect(prompt).toContain('Settings')
  })

  it('routes a follower decision once and does not echo a received snapshot', async () => {
    const namespace = `skill-review:${crypto.randomUUID()}`
    const leader = createPinia()
    const leaderRuntime = createSyncedPiniaPlugin({ namespace, leadership: 'leader-only' })
    leader.use(leaderRuntime.plugin)
    createApp({}).use(leader)
    const follower = createPinia()
    const followerRuntime = createSyncedPiniaPlugin({ namespace, leadership: 'follower-only' })
    follower.use(followerRuntime.plugin)
    createApp({}).use(follower)
    contexts.push(leader, follower)
    runtimes.push(leaderRuntime, followerRuntime)
    await vi.waitFor(() => expect(leaderRuntime.isLeader()).toBe(true))
    setActivePinia(leader)
    const leaderStore = useSkillsReviewStore()
    setActivePinia(follower)
    const followerStore = useSkillsReviewStore()
    await vi.waitFor(() => expect(followerRuntime.getLeaderId()).toBe(leaderRuntime.participantId))
    let decisions = 0
    let approvals = 0
    let reviews = 0
    leaderStore.$onAction(({ name }) => {
      if (name === 'submit')
        decisions++
      if (name === 'approve')
        approvals++
      if (name === 'readForReview')
        reviews++
    })
    await followerStore.submit(OPENCODE_ADAPTER_SKELETON)
    await vi.waitFor(() => expect(followerStore.queue).toHaveLength(1))
    expect(leaderStore.queue).toHaveLength(1)
    expect(decisions).toBe(1)
    expect(JSON.parse(localStorage.getItem('skills/review-queue')!)).toHaveLength(1)
    const viewed = await followerStore.readForReview(OPENCODE_ADAPTER_SKELETON.toolId)
    expect(viewed.source).toContain('opencode adapter skeleton')
    await followerStore.approve(OPENCODE_ADAPTER_SKELETON.toolId, viewed)
    await vi.waitFor(() => expect(followerStore.queue[0]?.trust).toBe('reviewed'))
    expect(leaderStore.queue[0]?.reviewedHash).toBe(viewed.contentHash)
    expect(reviews).toBe(1)
    expect(approvals).toBe(1)
  })

  it('does not persist a replicated review queue', async () => {
    // ROOT CAUSE:
    // A deep queue watcher wrote every received snapshot to localStorage.
    // Only explicit leader actions may persist decisions; snapshot consumers
    // must remain read-only at the persistence boundary.
    const leader = createPinia()
    const follower = createPinia()
    contexts.push(leader, follower)
    setActivePinia(leader)
    const leaderStore = useSkillsReviewStore()
    await leaderStore.submit(OPENCODE_ADAPTER_SKELETON)
    const snapshot = JSON.parse(JSON.stringify(leaderStore.$state))
    await nextTick()
    localStorage.clear()

    setActivePinia(follower)
    const followerStore = useSkillsReviewStore()
    followerStore.$patch(snapshot)
    await nextTick()

    expect(followerStore.queue).toHaveLength(1)
    expect(localStorage.getItem('skills/review-queue')).toBeNull()
  })
})
