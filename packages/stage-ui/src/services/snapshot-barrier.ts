import type { PiniaPluginContext } from 'pinia'

const OWNERS = new Set(['chat', 'chat-session', 'runtime-journal', 'runtime-plans', 'memory', 'skills-review', 'airi-card', 'long-goal-scheduler', 'life-mode'])
const SNAPSHOT_ACTIONS = new Set(['flushNow', 'exportSessions', 'exportSnapshot'])

/**
 * Tracks domain actions from store creation until disposal. A snapshot starts
 * only at an idle boundary and refuses new domain actions while it captures
 * data. Background IO that does not use an action needs its owner's own lock.
 */
export class SnapshotBarrier {
  private active = false
  private pending = new Set<symbol>()

  /** Installs action tracking before the renderer creates business stores. */
  plugin = ({ store }: PiniaPluginContext): void => {
    if (!OWNERS.has(store.$id))
      return
    store.$onAction(({ name, after, onError }) => {
      if (SNAPSHOT_ACTIONS.has(name))
        return
      if (this.active)
        throw new Error('A data snapshot is in progress. Try again after it completes.')
      const action = Symbol(name)
      this.pending.add(action)
      const settled = () => {
        this.pending.delete(action)
      }
      after(settled)
      onError(settled)
    }, true)
  }

  /** Refuses busy owners instead of exporting a partially completed action. */
  async capture<T>(capture: () => Promise<T>): Promise<T> {
    if (this.active || this.pending.size > 0)
      throw new Error('Data owners are busy. Wait for current work to finish before exporting.')
    this.active = true
    try {
      return await capture()
    }
    finally {
      this.active = false
    }
  }
}

/** One barrier per renderer; only the leader is allowed to capture a profile. */
export const profileSnapshotBarrier = new SnapshotBarrier()
