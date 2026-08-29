/**
 * Projection registry (CODING-HARNESS-DESIGN §4.4).
 *
 * Domain code registers pure projection units; committed journal events
 * drive them; `snapshot()` returns one consistent view with `asOfSeq`.
 * Shape follows dsh's `dsh-session-projection` (register / onChanged /
 * snapshot) so the two stay comparable.
 *
 * All state derives from the journal: nothing here ever mutates an event.
 */
import type { JournalEvent } from './types'

export interface ProjectionUnit<State> {
  key: string
  stateVersion: number
  /**
   * Pure fold over committed events; `previous` is the last computed state
   * and may be undefined until the unit first sees a relevant event. Return
   * `previous` itself on no-change so the registry can distinguish real
   * changes from no-ops.
   */
  compute: (events: JournalEvent[], previous: State | undefined) => State | undefined
}

export interface ProjectionSnapshot {
  asOfSeq: number
  values: Record<string, unknown>
}

export interface ToolEvidenceEntry {
  seq: number
  toolName: string
  ok: boolean
  summary: string
  provenance?: string
}

export type ProjectionChangeListener = (snapshot: ProjectionSnapshot) => void

export class ProjectionRegistry {
  private readonly units = new Map<string, ProjectionUnit<unknown>>()
  private readonly listeners = new Set<ProjectionChangeListener>()
  private readonly lastStates = new Map<string, unknown>()
  private lastSeq = -1

  /** Registers a unit; returns a disposer that removes it (fiber-style). */
  register<State>(unit: ProjectionUnit<State>): () => void {
    if (this.units.has(unit.key))
      throw new Error(`projection: duplicate unit key "${unit.key}"`)
    this.units.set(unit.key, unit as ProjectionUnit<unknown>)
    return () => {
      this.units.delete(unit.key)
      this.lastStates.delete(unit.key)
    }
  }

  onChanged(listener: ProjectionChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Drives every registered unit over one committed event. */
  ingest(event: JournalEvent): void {
    this.lastSeq = event.seq
    for (const [key, unit] of this.units) {
      const previous = this.lastStates.get(key)
      const next = unit.compute([event], previous)
      if (next !== previous) {
        this.lastStates.set(key, next)
        this.notify()
      }
    }
  }

  /** Consistent snapshot: all values reflect the same last committed seq. */
  snapshot(): ProjectionSnapshot {
    const values: Record<string, unknown> = {}
    for (const key of this.units.keys())
      values[key] = this.lastStates.get(key)
    return { asOfSeq: this.lastSeq, values }
  }

  private notify(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners)
      listener(snapshot)
  }
}

/**
 * Unit evaluating the replace-self semantics of `task/update`: the latest
 * snapshot per taskId wins (ATTENTION-DESIGN task lane). A task disappears
 * from the view when it is done.
 */
export function createTaskMemoryUnit(options: { doneTaskIds?: Set<string> } = {}): ProjectionUnit<Record<string, { memory: Record<string, unknown>, updatedSeq: number }>> {
  return {
    key: 'task-memory/tasks',
    stateVersion: 1,
    compute(events, previous) {
      // No-change path returns the previous reference itself so the registry
      // can tell real changes from no-ops (default-param copies would
      // misfire notifications on every event).
      if (!events.some(event => event.type === 'task/update'))
        return previous
      const next = { ...previous }
      for (const event of events) {
        if (event.type !== 'task/update')
          continue
        if (options.doneTaskIds?.has(event.taskId)) {
          delete next[event.taskId]
          continue
        }
        next[event.taskId] = { memory: event.memory, updatedSeq: event.seq }
      }
      return next
    },
  }
}

/** Unit indexing `tool/result` events — evidenceReFs are this index. */
export function createToolEvidenceIndexUnit(): ProjectionUnit<ToolEvidenceEntry[]> {
  return {
    key: 'tool/evidence-index',
    stateVersion: 1,
    compute(events, previous) {
      const appended = events
        .filter((event): event is Extract<JournalEvent, { type: 'tool/result' }> => event.type === 'tool/result')
        .map((event) => {
          return {
            seq: event.seq,
            toolName: event.toolName,
            ok: event.ok,
            summary: event.summary,
            ...(event.provenance ? { provenance: event.provenance } : {}),
          }
        })
      if (appended.length === 0)
        return previous
      return [...(previous ?? []), ...appended]
    },
  }
}

/** Unit keeping the latest injected context per contextId (replace-self). */
export function createContextSectionUnit(): ProjectionUnit<Record<string, { source: string, text: string, updatedSeq: number }>> {
  return {
    key: 'context/sections',
    stateVersion: 1,
    compute(events, previous) {
      if (!events.some(event => event.type === 'context/inject'))
        return previous
      const next = { ...previous }
      for (const event of events) {
        if (event.type !== 'context/inject')
          continue
        next[event.contextId] = { source: event.source, text: event.text, updatedSeq: event.seq }
      }
      return next
    },
  }
}
