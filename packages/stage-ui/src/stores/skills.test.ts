import type { ToolExecuteOptions } from '@xsai/shared-chat'

import type { ReviewQueueEntry } from './skills'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLlmToolsStore } from './ai/chat-llm/tools'
import { useJournalStore } from './journal'
import { contentHashOf, installSkillRuntime, MAX_PROBATION_TOOLS, OPENCODE_ADAPTER_SKELETON, useSkillsReviewStore } from './skills'

function entry(toolId: string): Omit<ReviewQueueEntry, 'trust' | 'review' | 'quarantine'> {
  return { ...OPENCODE_ADAPTER_SKELETON, toolId, contentHash: contentHashOf('export function run(input) { return input }') }
}

describe('skills review store', async () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installSkillRuntime({
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
      readSource: async () => 'export function run(input) { return input }',
    })
  })

  it('submits a drafted tool into probation', async () => {
    const store = useSkillsReviewStore()
    const outcome = await store.submit(entry('adapter-a'))
    expect(outcome.accepted).toBe(true)
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0]?.trust).toBe('probation')
  })

  it('k02 rejects an approval after the displayed source changes', async () => {
    let source = 'export function run(input) { return input }'
    installSkillRuntime({
      readSource: async () => source,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const store = useSkillsReviewStore()
    await store.submit(entry('adapter-a'))
    const viewed = await store.readForReview('adapter-a')
    expect(viewed.source).toBe(source)
    source = 'export function run() { return "changed" }'
    await expect(store.approve('adapter-a', viewed)).rejects.toThrow('source changed')
    expect(store.queue[0]?.trust).toBe('probation')
    expect(useLlmToolsStore().tools).toHaveLength(0)
    await store.applyContentChange('adapter-a', source)
    await expect(store.approve('adapter-a', viewed)).rejects.toThrow('entry changed')
  })

  it('k02 rejects changed self-test bytes after review', async () => {
    let selftest = 'return true'
    installSkillRuntime({
      readSource: async () => 'export function run(input) { return input }',
      readSelftest: async () => selftest,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const store = useSkillsReviewStore()
    await store.submit({ ...entry('adapter-a'), selftest: { contentHash: contentHashOf(selftest), logs: ['passed'], traceCount: 1 } })
    const viewed = await store.readForReview('adapter-a')
    expect(viewed.selftest?.logs).toEqual(['passed'])
    selftest = 'return false'
    await expect(store.approve('adapter-a', viewed)).rejects.toThrow('self-test changed')
    expect(store.queue[0]?.trust).toBe('probation')
  })

  it('requeues the current changed source for a fresh review', async () => {
    let source = 'export function run(input) { return input }'
    installSkillRuntime({
      readSource: async () => source,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const store = useSkillsReviewStore()
    await store.submit({ ...entry('re-review'), contentHash: contentHashOf(source) })
    await store.approve('re-review', await store.readForReview('re-review'))

    source = 'export function run(input) { return String(input).toUpperCase() }'
    await store.requeueChangedSourceForReview('re-review')

    expect(store.queue[0]?.trust).toBe('probation')
    expect(store.queue[0]?.contentHash).toBe(contentHashOf(source))
    expect(store.queue[0]?.reviewedHash).toBeUndefined()
    expect(store.queue[0]?.artifactError).toBeUndefined()
    const viewed = await store.readForReview('re-review')
    expect(viewed.source).toBe(source)
    await store.approve('re-review', viewed)
    expect(store.queue[0]?.trust).toBe('reviewed')
    expect(store.queue[0]?.reviewedHash).toBe(contentHashOf(source))
  })

  it('rejects duplicates and capped probation counts', async () => {
    const store = useSkillsReviewStore()
    await store.submit(entry('adapter-a'))
    expect((await store.submit(entry('adapter-a'))).accepted).toBe(false)

    for (let i = 1; i < MAX_PROBATION_TOOLS; i++)
      await store.submit(entry(`adapter-${i}`))

    const extra = await store.submit(entry('adapter-over'))
    expect(extra).toEqual({ accepted: false, reason: `probation capped at ${MAX_PROBATION_TOOLS}; graduate or reject first` })
  })

  it('graduates to reviewed with a bound review record', async () => {
    const store = useSkillsReviewStore()
    await store.submit(entry('adapter-a'))
    await store.approve('adapter-a', await store.readForReview('adapter-a'), 'you', 'read the 40 lines')
    expect(store.queue[0]?.trust).toBe('reviewed')
    expect(store.queue[0]?.review?.reviewer).toBe('you')
  })

  it('returns to probation when content changes and voids the review', async () => {
    const store = useSkillsReviewStore()
    await store.submit(entry('adapter-a'))
    await store.approve('adapter-a', await store.readForReview('adapter-a'))
    const before = store.queue[0]?.contentHash

    await store.applyContentChange('adapter-a', 'export const v = 2')
    expect(store.queue[0]?.trust).toBe('probation')
    expect(store.queue[0]?.review).toBeUndefined()
    expect(store.queue[0]?.contentHash).not.toBe(before)
  })

  it('quarantines on compatibility mismatch and clears after fix', async () => {
    const store = useSkillsReviewStore()
    await store.submit(entry('adapter-a'))
    await store.quarantine('adapter-a')
    expect(store.queue[0]?.quarantine?.reason).toBe('compatibility_mismatch')
    expect(store.queue[0]?.trust).toBe('probation')

    await store.clearQuarantine('adapter-a')
    expect(store.queue[0]?.quarantine).toBeUndefined()
  })

  it('removes rejected tools from the queue', async () => {
    const store = useSkillsReviewStore()
    await store.submit(entry('adapter-a'))
    await store.reject('adapter-a')
    expect(store.queue).toHaveLength(0)
  })

  it('uses the canonical content hash for every honest diff', async () => {
    expect(contentHashOf('const x = 1')).not.toBe(contentHashOf('const x = 2'))
    expect(contentHashOf('const x = 1')).toHaveLength(16)
  })

  it('rejects reviewed skill input before the sandbox can silently transform it', async () => {
    // ROOT CAUSE:
    //
    // A reviewed tool exposed its JSON Schema to the model, but the execution
    // boundary passed every runtime value directly to the authored source.
    // A source that filtered invalid array elements could therefore report a
    // partial success instead of an input-contract failure.
    //
    // We validate the reviewed schema before sandbox execution and keep the
    // source unreachable when the invocation does not satisfy that schema.
    const source = 'export function run(input) { return input.items }'
    const runProgram = vi.fn(async (_params: { program: string }) => ({ ok: true as const, value: 'checked', logs: [] }))
    installSkillRuntime({
      readSource: async () => source,
      runProgram,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const store = useSkillsReviewStore()
    const submission = entry('typed-input')
    await store.submit({
      ...submission,
      contentHash: contentHashOf(source),
      tool: {
        ...submission.tool,
        parameters: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['items'],
          additionalProperties: false,
        },
      },
    })
    await store.approve('typed-input', await store.readForReview('typed-input'))

    const result = await store.executeReviewedSkill('typed-input', { items: ['a', 3, null] })

    expect(result).toContain('input.items[1] must be a string')
    expect(runProgram).not.toHaveBeenCalled()
    expect(await store.executeReviewedSkill('typed-input', { items: ['a', 'b'] })).toBe('checked')
    expect(runProgram).toHaveBeenCalledTimes(1)
  })

  it('enforces uniqueItems before the sandbox can accept duplicates', async () => {
    // ROOT CAUSE:
    //
    // `validateToolInputSchema` accepted `uniqueItems` without checking it, and
    // `validateToolInput` never applied it, so a schema the model could read was
    // stricter than the execution boundary. We now enforce the keyword and
    // reject every keyword the validator cannot enforce.
    const source = 'export function run(input) { return input.items }'
    const runProgram = vi.fn(async (_params: { program: string }) => ({ ok: true as const, value: 'checked', logs: [] }))
    installSkillRuntime({
      readSource: async () => source,
      runProgram,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const store = useSkillsReviewStore()
    const submission = entry('unique-items')
    await store.submit({
      ...submission,
      contentHash: contentHashOf(source),
      tool: {
        ...submission.tool,
        parameters: {
          type: 'object',
          properties: { items: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
          required: ['items'],
        },
      },
    })
    await store.approve('unique-items', await store.readForReview('unique-items'))

    expect(await store.executeReviewedSkill('unique-items', { items: ['a', 'a'] })).toContain('uniqueItems is required')
    expect(runProgram).not.toHaveBeenCalled()
    expect(await store.executeReviewedSkill('unique-items', { items: ['a', 'b'] })).toBe('checked')
    expect(runProgram).toHaveBeenCalledTimes(1)
  })

  it('rejects null input instead of coercing it to an empty object', async () => {
    // ROOT CAUSE:
    //
    // `executeSkill` called `validateToolInput(schema, input ?? {})`, so an
    // explicit null satisfied an object schema with no required fields even
    // though the tool promised to reject non-object input.
    const source = 'export function run(input) { return Object.keys(input).length }'
    const runProgram = vi.fn(async (_params: { program: string }) => ({ ok: true as const, value: 'checked', logs: [] }))
    installSkillRuntime({
      readSource: async () => source,
      runProgram,
      runCommand: async () => ({ tier: 'read-only', status: 'ok', stdout: '', stderr: '' }),
    })
    const store = useSkillsReviewStore()
    const submission = entry('null-input')
    await store.submit({
      ...submission,
      contentHash: contentHashOf(source),
      tool: { ...submission.tool, parameters: { type: 'object', properties: {}, additionalProperties: false } },
    })
    await store.approve('null-input', await store.readForReview('null-input'))

    expect(await store.executeReviewedSkill('null-input', null)).toContain('input must be an object')
    expect(runProgram).not.toHaveBeenCalled()
    expect(await store.executeReviewedSkill('null-input', {})).toBe('checked')
    expect(runProgram).toHaveBeenCalledTimes(1)
  })

  it('rejects a submission whose schema declares an unenforced keyword', async () => {
    const store = useSkillsReviewStore()
    const submission = entry('unenforced-schema')
    const outcome = await store.submit({
      ...submission,
      tool: {
        ...submission.tool,
        parameters: { type: 'object', properties: { name: { type: 'string', format: 'email' } } },
      },
    })

    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain('format is not enforced')
    expect(store.queue).toHaveLength(0)
  })

  it('loads the first review subject into the catalog', async () => {
    const store = useSkillsReviewStore()
    expect(store.catalog).toEqual([OPENCODE_ADAPTER_SKELETON])
  })

  it('registers only reviewed skills and activates them from their trigger', async () => {
    const store = useSkillsReviewStore()
    const tools = useLlmToolsStore()
    await store.submit(OPENCODE_ADAPTER_SKELETON)

    expect(tools.tools).toHaveLength(0)

    await store.approve(OPENCODE_ADAPTER_SKELETON.toolId, await store.readForReview(OPENCODE_ADAPTER_SKELETON.toolId))

    expect(store.prepareForPrompt('Please use opencode for this task')).toEqual(['opencode_delegate'])
    expect(tools.tools.map(tool => tool.function.name)).toEqual(['opencode_delegate'])
  })

  // The chat input shelf inserts the skill's canonical name as a /name token.
  // Activation must key off that name (and toolId) so the shelf insertion is
  // reliable even when the author's keyword list omits it.
  it('activates a reviewed skill from its name token and projects shelf entries', async () => {
    const store = useSkillsReviewStore()
    await store.submit({ ...entry('flip-text'), name: 'flip_text' })
    await store.approve('flip-text', await store.readForReview('flip-text'))

    expect(store.prepareForPrompt('use /flip_text on this draft')).toEqual(['opencode_delegate'])
    expect(store.reviewedSkills).toEqual([
      { toolId: 'flip-text', name: 'flip_text', description: OPENCODE_ADAPTER_SKELETON.description },
    ])
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
    await store.submit(OPENCODE_ADAPTER_SKELETON)
    await store.approve(OPENCODE_ADAPTER_SKELETON.toolId, await store.readForReview(OPENCODE_ADAPTER_SKELETON.toolId))
    const [tool] = tools.getToolsByNames('opencode_delegate')

    const options: ToolExecuteOptions = { messages: [], toolCallId: 'test-call' }
    await tool?.execute({ task: 'delegate this' }, options)

    expect(store.queue[0]?.quarantine?.reason).toBe('compatibility_mismatch')
    expect(tools.tools).toHaveLength(0)
  })

  it('moves failed reviewed calls into a bounded revision batch', async () => {
    const store = useSkillsReviewStore()
    const journal = useJournalStore()
    await store.submit(OPENCODE_ADAPTER_SKELETON)
    await store.approve(OPENCODE_ADAPTER_SKELETON.toolId, await store.readForReview(OPENCODE_ADAPTER_SKELETON.toolId))
    journal.appendActive({
      type: 'tool/result',
      toolName: 'opencode_delegate',
      ok: false,
      summary: 'opencode returned a non-zero exit code',
    })

    const batch = await store.dreamRevisionBatch()

    expect(batch[0]?.toolId).toBe(OPENCODE_ADAPTER_SKELETON.toolId)
    expect(store.queue[0]?.trust).toBe('probation')
    expect(store.queue[0]?.revision?.reason).toContain('non-zero')
  })
})
