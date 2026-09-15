/**
 * Coarse route splitting for long terrain moves (review R5).
 *
 * The planner reads a local cuboid around start and goal. A far goal grows that
 * cuboid past the region read cap, so `splitRoute` cuts the straight horizontal
 * line into waypoints no farther than `maxHop` apart and the executor walks the
 * goal one local leg at a time. The final hop to the real goal is left to the
 * caller.
 */
import type { Vec3 } from './types'

/** Horizontal distance above which a move is split into local legs. */
export const LONG_ROUTE_MIN_DISTANCE = 32
/** Longest horizontal hop of one split leg. */
export const LONG_ROUTE_MAX_HOP = 16

/**
 * Intermediate waypoints of the straight line from `start` to `goal`.
 *
 * Returns an empty list when the horizontal distance is at most `maxHop`; the
 * caller then walks to `goal` directly. Otherwise every returned waypoint is at
 * most `maxHop` horizontally from the previous one, and the remaining distance
 * from the last waypoint to `goal` is also at most `maxHop`. The Y value
 * follows horizontal progress.
 *
 * @example
 * splitRoute({ x: 0, y: 64, z: 0 }, { x: 40, y: 64, z: 0 }, 16)
 * // => [{ x: 16, y: 64, z: 0 }, { x: 32, y: 64, z: 0 }]
 */
export function splitRoute(start: Vec3, goal: Vec3, maxHop: number): Vec3[] {
  const dx = goal.x - start.x
  const dz = goal.z - start.z
  const horizontal = Math.hypot(dx, dz)
  if (horizontal <= maxHop)
    return []

  const ux = dx / horizontal
  const uz = dz / horizontal
  const dy = goal.y - start.y
  const waypoints: Vec3[] = []
  for (let traveled = maxHop; traveled < horizontal; traveled += maxHop) {
    const fraction = traveled / horizontal
    waypoints.push({
      x: Math.round(start.x + ux * traveled),
      y: Math.round(start.y + dy * fraction),
      z: Math.round(start.z + uz * traveled),
    })
  }
  return waypoints
}
