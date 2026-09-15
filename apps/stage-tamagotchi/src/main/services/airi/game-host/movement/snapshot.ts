/**
 * Snapshot of the world region a movement plan needs (MC-3 Phase 1)。
 *
 * The gate is a plain map so planning stays a pure function; the main host
 * fills it from `world.getBlocks` (increment 2) and the planner reports the
 * first position it needed but could not read (`no_chunk`).
 */
import type { BlockInfo, BlockSource, CollisionBox } from './types'

import { classifyBlock } from './block-view'

export interface SnapshotEntry {
  x: number
  y: number
  z: number
  id: string
  properties?: Record<string, string>
  hardness?: number
  /** Exact collision boxes from the source, when the region read sent them. */
  collision?: CollisionBox[]
}

export interface WorldSnapshot extends BlockSource {
  entries: Map<string, BlockInfo>
  has: (x: number, y: number, z: number) => boolean
}

function keyOf(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** Builds a read-only block source from one region read. */
export function createSnapshot(entries: SnapshotEntry[]): WorldSnapshot {
  const map = new Map<string, BlockInfo>()
  for (const entry of entries) {
    // Frozen: search candidates must not write hypothetical placements back
    // into the shared view (review R2). Assumed states stay local.
    map.set(keyOf(entry.x, entry.y, entry.z), Object.freeze(classifyBlock(entry)))
  }

  return {
    entries: map,
    has: (x, y, z) => map.has(keyOf(x, y, z)),
    getBlock: (x, y, z) => map.get(keyOf(x, y, z)),
  }
}

/** Inclusive cuboid helper for tests and region reads. */
export function snapshotBounds(from: { x: number, y: number, z: number }, to: { x: number, y: number, z: number }): { min: { x: number, y: number, z: number }, max: { x: number, y: number, z: number } } {
  return {
    min: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) },
    max: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) },
  }
}
