import type { Vec3 } from './geometry'
/**
 * Construction progress, pause and resume (RS-2 §3).
 *
 * Progress stores verified steps, temporary supports and pending steps. Pausing
 * releases the input session and keeps the record; resuming reads the site and
 * continues from what is actually there, so a pause/resume never repeats a
 * verified step.
 *
 * Projection identity and the control session are separate fields. The
 * projection belongs to one task; the control session is the input lease of one
 * run. {@link assertProjectionOwnership} rejects work on a projection this task
 * does not own.
 */
import type { BlockStateView } from './state'

import { vecKey } from './geometry'

/** One temporary support placed to reach a step, cleared when no longer needed. */
export interface TemporarySupport {
  position: Vec3
  blockId: string
  /** Projection step the support exists for. */
  forStep: Vec3
}

/** Persisted construction progress for one projection. */
export interface ConstructionProgress {
  projectionId: string
  /** Task that owns the projection. */
  taskId: string
  blueprintContentDigest: string
  /** Verified steps by world cell key. */
  completed: Record<string, { blockId: string, at: number }>
  temporarySupports: TemporarySupport[]
  /** Cells still to build, in plan order. */
  pending: Vec3[]
  /** Input session of the last run; cleared on pause (CD-0 ownership). */
  lastControlSessionId?: string
  pausedAt?: number
}

/** Raised when progress is used for a projection this task does not own. */
export class ProjectionOwnershipError extends Error {
  constructor(projectionId: string, ownedProjectionId: string) {
    super(`Projection ${projectionId} is not owned by this task (it owns ${ownedProjectionId}).`)
    this.name = 'ProjectionOwnershipError'
  }
}

/**
 * Rejects a projection the task does not own.
 *
 * Only this task's projection is managed; another task's projection is never
 * moved, paused or resumed.
 */
export function assertProjectionOwnership(progress: ConstructionProgress, projectionId: string): void {
  if (progress.projectionId !== projectionId)
    throw new ProjectionOwnershipError(projectionId, progress.projectionId)
}

export function createProgress(input: {
  projectionId: string
  taskId: string
  blueprintContentDigest: string
  pending?: Vec3[]
}): ConstructionProgress {
  return {
    projectionId: input.projectionId,
    taskId: input.taskId,
    blueprintContentDigest: input.blueprintContentDigest,
    completed: {},
    temporarySupports: [],
    pending: input.pending ?? [],
  }
}

/** Records one verified step and removes it from the pending list. */
export function recordVerifiedStep(progress: ConstructionProgress, step: { position: Vec3, blockId: string }, at: number): ConstructionProgress {
  const key = vecKey(step.position)
  return {
    ...progress,
    completed: { ...progress.completed, [key]: { blockId: step.blockId, at } },
    pending: progress.pending.filter(position => vecKey(position) !== key),
  }
}

/** Records a temporary support that must be cleared when the step is done. */
export function registerTemporarySupport(progress: ConstructionProgress, support: TemporarySupport): ConstructionProgress {
  const key = vecKey(support.position)
  const without = progress.temporarySupports.filter(existing => vecKey(existing.position) !== key)
  return { ...progress, temporarySupports: [...without, support] }
}

/** Binds the input session of a run. Separate from the projection identity. */
export function armControlSession(progress: ConstructionProgress, controlSessionId: string): ConstructionProgress {
  return { ...progress, lastControlSessionId: controlSessionId }
}

/**
 * Pauses a run: the input session is released and the record is kept.
 *
 * The projection identity stays; only the control session is cleared.
 */
export function pauseProgress(progress: ConstructionProgress, at: number): ConstructionProgress {
  const paused: ConstructionProgress = { ...progress, pausedAt: at }
  delete paused.lastControlSessionId
  return paused
}

/** What a fresh site read found, used to resume without repeating work. */
export interface SiteDiff {
  observed: ReadonlyMap<string, BlockStateView>
  /** Temporary support cells the worker found still present. */
  temporarySupports?: Vec3[]
}

export interface ResumeReport {
  progress: ConstructionProgress
  /** Verified steps still matching the site. */
  retained: string[]
  /** Steps removed from `completed` because the site no longer matches. */
  dropped: string[]
  /** Recorded temporary supports the site no longer shows. */
  missingSupports: Vec3[]
}

/**
 * Resumes from a site read.
 *
 * A completed step is retained only when the block id at its cell still
 * matches; otherwise it returns to the pending list. Temporary supports the
 * site no longer shows are reported so a caller can re-place them. The paused
 * marker and the stale control session are cleared; the caller arms the new one.
 */
export function resumeProgress(progress: ConstructionProgress, site: SiteDiff): ResumeReport {
  const retained: string[] = []
  const dropped: string[] = []
  const stillCompleted: ConstructionProgress['completed'] = {}
  const recoveredPending = [...progress.pending]
  for (const [key, entry] of Object.entries(progress.completed)) {
    const observed = site.observed.get(key)
    if (observed && observed.blockId === entry.blockId) {
      retained.push(key)
      stillCompleted[key] = entry
    }
    else {
      dropped.push(key)
      const [x, y, z] = key.split(',').map(Number)
      recoveredPending.push({ x, y, z })
    }
  }

  const presentSupports = new Set((site.temporarySupports ?? []).map(vecKey))
  const missingSupports: Vec3[] = []
  const keptSupports = progress.temporarySupports.filter((support) => {
    if (presentSupports.has(vecKey(support.position)))
      return true
    missingSupports.push(support.position)
    return false
  })

  const resumed: ConstructionProgress = {
    ...progress,
    completed: stillCompleted,
    temporarySupports: keptSupports,
    pending: [...recoveredPending].sort((left, right) => left.y - right.y || left.x - right.x || left.z - right.z),
  }
  delete resumed.pausedAt
  delete resumed.lastControlSessionId
  return { progress: resumed, retained, dropped, missingSupports }
}
