import type { JournalEvent } from './types'

import { describe, expect, it } from 'vitest'

import { createContextSectionUnit, createTaskMemoryUnit, createToolEvidenceIndexUnit, ProjectionRegistry } from './projection'

function header(sessionId = 's1'): JournalEvent {
  return { type: 'session/header', seq: 0, sessionId, createdAt: 1, delegationDepth: 0 }
}

describe('projection registry', () => {
  it('tracks asOfSeq and excludes units without changes', () => {
    const registry = new ProjectionRegistry()
    registry.register(createTaskMemoryUnit())
    registry.ingest(header('s1'))
    registry.ingest({ type: 'task/update', seq: 1, taskId: 'pr-1234', memory: { status: 'active' } })

    const snapshot = registry.snapshot()
    expect(snapshot.asOfSeq).toBe(1)
    const tasks = snapshot.values['task-memory/tasks'] as Record<string, { memory: Record<string, unknown>, updatedSeq: number }>
    expect(tasks['pr-1234']?.memory.status).toBe('active')
    expect(tasks['pr-1234']?.updatedSeq).toBe(1)
  })

  it('applies replace-self: the Nth task/update covers the N-1th', () => {
    const registry = new ProjectionRegistry()
    registry.register(createTaskMemoryUnit())
    registry.ingest(header('s1'))
    registry.ingest({ type: 'task/update', seq: 1, taskId: 'pr-1234', memory: { status: 'active', currentStep: 'lint' } })
    registry.ingest({ type: 'task/update', seq: 2, taskId: 'pr-1234', memory: { status: 'active', currentStep: 'test' } })

    const tasks = registry.snapshot().values['task-memory/tasks'] as Record<string, { memory: Record<string, unknown>, updatedSeq: number }>
    expect(tasks['pr-1234']?.memory).toEqual({ status: 'active', currentStep: 'test' })
    expect(Object.keys(tasks)).toHaveLength(1)
  })

  it('drops tasks marked done', () => {
    const registry = new ProjectionRegistry()
    registry.register(createTaskMemoryUnit({ doneTaskIds: new Set(['pr-done']) }))
    registry.ingest(header('s1'))
    registry.ingest({ type: 'task/update', seq: 1, taskId: 'pr-done', memory: { status: 'active' } })
    registry.ingest({ type: 'task/update', seq: 2, taskId: 'pr-done', memory: { status: 'blocked' } })

    const tasks = registry.snapshot().values['task-memory/tasks'] as Record<string, unknown>
    expect(tasks['pr-done']).toBeUndefined()
  })

  it('indexes tool results as the evidence list', () => {
    const registry = new ProjectionRegistry()
    registry.register(createToolEvidenceIndexUnit())
    registry.ingest(header('s1'))
    registry.ingest({ type: 'tool/result', seq: 1, toolName: 'edit', ok: true, summary: 'applied', provenance: 'builtin' })
    registry.ingest({ type: 'tool/result', seq: 2, toolName: 'bash', ok: false, summary: 'exit 1' })

    const index = registry.snapshot().values['tool/evidence-index'] as { seq: number, toolName: string, ok: boolean }[]
    expect(index).toEqual([
      { seq: 1, toolName: 'edit', ok: true, summary: 'applied', provenance: 'builtin' },
      { seq: 2, toolName: 'bash', ok: false, summary: 'exit 1' },
    ])
  })

  it('keeps the latest injected context per contextId', () => {
    const registry = new ProjectionRegistry()
    registry.register(createContextSectionUnit())
    registry.ingest(header('s1'))
    registry.ingest({ type: 'context/inject', seq: 1, contextId: 'mc', source: 'minecraft', text: 'hp: 12' })
    registry.ingest({ type: 'context/inject', seq: 2, contextId: 'mc', source: 'minecraft', text: 'hp: 3' })

    const sections = registry.snapshot().values['context/sections'] as Record<string, { text: string }>
    expect(sections.mc?.text).toBe('hp: 3')
  })

  it('fires change listeners per changed unit and disposes cleanly', () => {
    const registry = new ProjectionRegistry()
    const changes: number[] = []
    const off = registry.onChanged(snapshot => changes.push(snapshot.asOfSeq))
    registry.register(createToolEvidenceIndexUnit())

    // The header changes no unit and must not notify.
    registry.ingest(header('s1'))
    expect(changes).toEqual([])

    registry.ingest({ type: 'tool/result', seq: 1, toolName: 'read', ok: true, summary: 'ok' })
    expect(changes).toEqual([1])

    // A non-tool event changes nothing and must not notify.
    registry.ingest({ type: 'user/message', seq: 2, text: 'x', timestamp: 3 })
    expect(changes).toEqual([1])

    off()
    registry.ingest({ type: 'tool/result', seq: 3, toolName: 'read', ok: true, summary: 'ok' })
    expect(changes).toEqual([1])
  })

  it('rejects duplicate unit keys', () => {
    const registry = new ProjectionRegistry()
    registry.register(createTaskMemoryUnit())
    expect(() => registry.register(createTaskMemoryUnit())).toThrow(/duplicate unit key/)
  })
})
