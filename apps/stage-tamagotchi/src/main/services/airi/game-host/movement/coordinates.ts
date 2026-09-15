/**
 * Coordinate contract shared by the movement planner and the walk executor.
 *
 * Planner nodes are integer cells (feet level). Walking targets the standing
 * point of a cell: block centers on X/Z, and the real collision top on Y when
 * the support block is known (`BlockInfo.height`, which already covers slabs,
 * fences, doors and carpets). Aiming at integer corners made the executor walk
 * diagonally toward the corner instead of the cell center (review R1).
 */
import type { Vec3 } from './types'

/** Integer cell of a world position. */
export function cellOf(pos: Vec3): Vec3 {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
}

/**
 * Standing point of a cell, optionally using the support block's collision top.
 *
 * @example
 * standPointOf({ x: 1, y: 64, z: -3 })
 * // => { x: 1.5, y: 64, z: -2.5 }
 */
export function standPointOf(cell: Vec3, supportHeight?: number): Vec3 {
  return { x: cell.x + 0.5, y: supportHeight ?? cell.y, z: cell.z + 0.5 }
}
