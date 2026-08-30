import type { SkillSubmitDeps } from './skill-submit'

import { useSkillsReviewStore } from '@proj-airi/stage-ui/stores/skills'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { executeSkillSubmit } from './skill-submit'

const CLEAN_SOURCE = `export function run(input) {
  const text = String(input.text ?? '')
  return text.trim().toLocaleUpperCase()
}`

const NETWORK_SOURCE = `export async function run(input) {
  return await fetch('https://api.example.com/x', { method: 'POST' })
}`

function deps(overrides: Partial<SkillSubmitDeps> = {}): SkillSubmitDeps & { written: Array<{ path: string, content: string }> } {
  const written: Array<{ path: string, content: string }> = []
  return {
    written,
    writeFile: async (params) => {
      written.push(params)
      return { ok: true }
    },
    runProgram: async () => ({ ok: true, logs: [], traces: [] }),
    ...overrides,
  }
}

describe('executeSkillSubmit', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('submits a clean tool to probation and persists source + meta to the workspace', async () => {
    const d = deps()
    const output = await executeSkillSubmit({
      toolId: 'upper-text',
      name: 'upper_text',
      description: 'Uppercases the given text.',
      source: CLEAN_SOURCE,
    }, d)

    expect(output).toContain('submitted to probation')
    expect(output).toContain('Risk tier: low')
    expect(output).toContain('skills/upper-text/')
    expect(output).toContain('NOT callable')

    const paths = d.written.map(item => item.path)
    expect(paths).toContain('skills/upper-text/source.mjs')
    expect(paths).toContain('skills/upper-text/meta.json')

    const store = useSkillsReviewStore()
    expect(store.queue).toHaveLength(1)
    expect(store.queue[0]?.trust).toBe('probation')
    expect(store.queue[0]?.toolId).toBe('upper-text')
  })

  it('rejects a declaration that contradicts the static analysis, before any write', async () => {
    const d = deps()
    const output = await executeSkillSubmit({
      toolId: 'net-tool',
      name: 'net_tool',
      description: 'Posts data to a remote endpoint.',
      // Declares nothing, but the source performs network egress.
      source: NETWORK_SOURCE,
    }, d)

    expect(output).toContain('skill_submit rejected')
    expect(output).toContain('networkEgress: found by static analysis but not declared')
    expect(d.written).toHaveLength(0)
    expect(useSkillsReviewStore().queue).toHaveLength(0)
  })

  it('accepts a truthful declaration and classifies the risk tier', async () => {
    const d = deps()
    const output = await executeSkillSubmit({
      toolId: 'net-tool',
      name: 'net_tool',
      description: 'Posts data to a remote endpoint.',
      source: NETWORK_SOURCE,
      declaration: { networkEgress: true },
    }, d)

    expect(output).toContain('Risk tier: high')
    const meta = d.written.find(item => item.path === 'skills/net-tool/meta.json')
    expect(meta?.content).toContain('"networkEgress": true')
    expect(meta?.content).toContain('"riskLevel": "high"')
  })

  it('rejects the submission when the sandbox self-test fails and returns the trace', async () => {
    const failed = deps({
      runProgram: async () => ({
        ok: false,
        failure: {
          kind: 'runtime',
          message: 'ReferenceError: x is not defined',
          logs: ['running selftest'],
          traces: [{ toolName: 'read', args: ['skills/x/source.mjs'], ok: true, resultSummary: 'source' }],
        },
      }),
    })
    const output = await executeSkillSubmit({
      toolId: 'bad-tool',
      name: 'bad_tool',
      description: 'A tool whose self-test cannot pass.',
      source: CLEAN_SOURCE,
      selftest: 'const src = await bridge("read", ["skills/bad-tool/source.mjs"]); throw new Error("boom")',
    }, failed)

    expect(output).toContain('self-test failed')
    expect(output).toContain('ReferenceError: x is not defined')
    expect(useSkillsReviewStore().queue).toHaveLength(0)
    // The source artifact stays on disk for inspection; no meta, no queue entry.
    expect(failed.written.some(item => item.path === 'skills/bad-tool/source.mjs')).toBe(true)
    expect(failed.written.some(item => item.path === 'skills/bad-tool/meta.json')).toBe(false)
  })

  it('records self-test evidence when the sandbox run passes', async () => {
    const d = deps({
      runProgram: async () => ({ ok: true, logs: ['selftest ran'], traces: [{ toolName: 'read', args: [], ok: true, resultSummary: 'loaded' }] }),
    })
    const output = await executeSkillSubmit({
      toolId: 'ok-tool',
      name: 'ok_tool',
      description: 'A tool that proves itself.',
      source: CLEAN_SOURCE,
      selftest: 'bridge("read", ["skills/ok-tool/source.mjs"])',
    }, d)

    expect(output).toContain('Self-test passed in the sandbox (1 bridge call(s))')
    const meta = d.written.find(item => item.path === 'skills/ok-tool/meta.json')
    expect(meta?.content).toContain('"selftestEvidence"')
    expect(useSkillsReviewStore().queue[0]?.toolId).toBe('ok-tool')
  })

  it('rejects a duplicate toolId already waiting in the queue', async () => {
    const d = deps()
    await executeSkillSubmit({
      toolId: 'twice',
      name: 'twice_tool',
      description: 'Submitted once already.',
      source: CLEAN_SOURCE,
    }, d)

    const second = await executeSkillSubmit({
      toolId: 'twice',
      name: 'twice_tool',
      description: 'Submitted once already.',
      source: CLEAN_SOURCE,
    }, deps())

    expect(second).toContain('already in the review queue')
  })

  it('fails cleanly when the source cannot be persisted', async () => {
    const d = deps({
      writeFile: async () => {
        throw new Error('disk full')
      },
    })
    const output = await executeSkillSubmit({
      toolId: 'no-disk',
      name: 'no_disk',
      description: 'Cannot be written anywhere.',
      source: CLEAN_SOURCE,
    }, d)

    expect(output).toContain('could not persist the source')
    expect(useSkillsReviewStore().queue).toHaveLength(0)
  })

  it('submits with activation keywords and prompt content when provided', async () => {
    const d = deps()
    const output = await executeSkillSubmit({
      toolId: 'clip',
      name: 'clipboard_last_copy',
      description: 'Recalls the most recent clipboard content.',
      source: CLEAN_SOURCE,
      activationKeywords: ['clipboard'],
      activationPatterns: ['\\bclipboard\\b'],
      promptContent: 'Use this when the user asks what they last copied.',
    }, d)

    expect(output).toContain('submitted to probation')
    const entry = useSkillsReviewStore().queue[0]
    expect(entry?.activation).toEqual({ keywords: ['clipboard'], patterns: ['\\bclipboard\\b'] })
    expect(entry?.prompt.content).toBe('Use this when the user asks what they last copied.')
  })
})
