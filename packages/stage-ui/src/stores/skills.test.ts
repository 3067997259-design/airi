import type { ToolExecuteOptions } from '@xsai/shared-chat'

import type { ReviewQueueEntry } from './skills'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useJournalStore } from './journal'
import { contentHashOf, installSkillRuntime, MAX_PROBATION_TOOLS, OPENCODE_ADAPTER_SKELETON, useSkillsReviewStore } from './skills'

function entry(toolId: string): Omit<ReviewQueueEntry, 'trust' | 'review' | 'quarantine'> {
  return { ...OPENCODE_ADAPTER_SKELETON, toolId }
}

describe('skills review store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installSkillRuntime(undefined)
  })

  it('submits a drafted tool into probation', () => {
    const store = useSkillsReviewStore()
    const outcome = store.submit(entry('adapter-a'))
    expect(outcome.accepted).toBe(true)
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0]?.trust).toBe('probation')
  })

  it('rejects duplicates and capped probation counts', () => {
    const store = useSkillsReviewStore()
    store.submit(entry('adapter-a'))
    expect(store.submit(entry('adapter-a')).accepted).toBe(false)

    for (let i = 1; i < MAX_PROBATION_TOOLS; i++)
      store.submit(entry(`adapter-${i}`))

    const extra = store.submit(entry('adapter-over'))
    expect(extra).toEqual({ accepted: false, reason: `probation capped at ${MAX_PROBATION_TOOLS}; graduate or reject first` })
  })

  it('graduates to reviewed with a bound review record', () => {
    const store = useSkillsReviewStore()
    store.submit(entry('adapter-a'))
    store.approve('adapter-a', 'you', 'read the 40 lines')
    expect(store.queue[0]?.trust).toBe('reviewed')
    expect(store.queue[0]?.review?.reviewer).toBe('you')
  })

  it('returns to probation when content changes and voids the review', () => {
    const store = useSkillsReviewStore()
    store.submit(entry('adapter-a'))
    store.approve('adapter-a')
    const before = store.queue[0]?.contentHash

    store.applyContentChange('adapter-a', 'export const v = 2')
    expect(store.queue[0]?.trust).toBe('probation')
    expect(store.queue[0]?.review).toBeUndefined()
    expect(store.queue[0]?.contentHash).not.toBe(before)
  })

  it('quarantines on compatibility mismatch and clears after fix', () => {
    const store = useSkillsReviewStore()
    store.submit(entry('adapter-a'))
    store.quarantine('adapter-a')
    expect(store.queue[0]?.quarantine?.reason).toBe('compatibility_mismatch')
    expect(store.queue[0]?.trust).toBe('probation')

    store.clearQuarantine('adapter-a')
    expect(store.queue[0]?.quarantine).toBeUndefined()
  })

  it('removes rejected tools from the queue', () => {
    const store = useSkillsReviewStore()
    store.submit(entry('adapter-a'))
    store.reject('adapter-a')
    expect(store.queue).toHaveLength(0)
  })

  it('uses the canonical content hash for every honest diff', () => {
    expect(contentHashOf('const x = 1')).not.toBe(contentHashOf('const x = 2'))
    expect(contentHashOf('const x = 1')).toHaveLength(16)
  })

  it('loads the first review subject into the catalog', () => {
    const store = useSkillsReviewStore()
    expect(store.catalog).toEqual([OPENCODE_ADAPTER_SKELETON])
  })

  it('registers only reviewed skills and activates them from their trigger', () => {
    const store = useSkillsReviewStore()
    const tools = useLlmToolsStore()
    store.submit(OPENCODE_ADAPTER_SKELETON)

    expect(tools.tools).toHaveLength(0)

    store.approve(OPENCODE_ADAPTER_SKELETON.toolId)

    expect(store.prepareForPrompt('Please use opencode for this task')).toEqual(['opencode_delegate'])
    expect(tools.tools.map(tool => tool.function.name)).toEqual(['opencode_delegate'])
  })

  it('quarantines an activated skill when its compatibility probe fails', async () => {
    installSkillRuntime({
      runCommand: async () => ({
        tier: 'high',
        status: 'ok',
        stdout: 'different-cli 1.0.0',
        stderr: '',
      }),
    })
    const store = useSkillsReviewStore()
    const tools = useLlmToolsStore()
    store.submit(OPENCODE_ADAPTER_SKELETON)
    store.approve(OPENCODE_ADAPTER_SKELETON.toolId)
    const [tool] = tools.getToolsByNames('opencode_delegate')

    const options: ToolExecuteOptions = { messages: [], toolCallId: 'test-call' }
    await tool?.execute({ task: 'delegate this' }, options)

    expect(store.queue[0]?.quarantine?.reason).toBe('compatibility_mismatch')
    expect(tools.tools).toHaveLength(0)
  })

  it('moves failed reviewed calls into a bounded revision batch', () => {
    const store = useSkillsReviewStore()
    const journal = useJournalStore()
    store.submit(OPENCODE_ADAPTER_SKELETON)
    store.approve(OPENCODE_ADAPTER_SKELETON.toolId)
    journal.appendActive({
      type: 'tool/result',
      toolName: 'opencode_delegate',
      ok: false,
      summary: 'opencode returned a non-zero exit code',
    })

    const batch = store.dreamRevisionBatch()

    expect(batch[0]?.toolId).toBe(OPENCODE_ADAPTER_SKELETON.toolId)
    expect(store.queue[0]?.trust).toBe('probation')
    expect(store.queue[0]?.revision?.reason).toContain('non-zero')
  })
})
