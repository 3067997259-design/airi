/**
 * Region reads for the movement planner (MC-3 Phase 1)。
 *
 * `get_blocks_region` caps one call, so the cuboid is split along X into
 * slabs that stay under the cap. Rows outside the build limits are clamped.
 */
import type { MovementControlPort } from './port'
import type { SnapshotEntry } from './snapshot'
import type { Vec3 } from './types'

/** Under the MCP-side 32768 default cap. */
export const MAX_REGION_BLOCKS = 30_000

const MIN_Y = -64
const MAX_Y = 320

export interface RegionBounds {
  min: Vec3
  max: Vec3
}

/**
 * Normalizes and inflates the bounds around a start/goal set.
 *
 * `goal` may be a single cell or a region goal; the bounds then cover every
 * goal cell. `lowerMargin` must cover the planner's deepest drop plus the
 * support block it reads below the landing node. Live MC-4c kept the old
 * margin at 4 while the planner (maxDropDown = 4) probed the support block at
 * -5, so the leg failed with a missing block that was outside the read region.
 * The horizontal default is 16 cells, the scale a mob uses to follow a target;
 * the caller grows it stepwise when a detour lies outside the base window.
 */
export function movementRegionBounds(start: Vec3, goal: Vec3 | Vec3[], margin = 16, lowerMargin = 5): RegionBounds {
  const goals = Array.isArray(goal) ? goal : [goal]
  let minX = start.x
  let maxX = start.x
  let minY = start.y
  let maxY = start.y
  let minZ = start.z
  let maxZ = start.z
  for (const cell of goals) {
    minX = Math.min(minX, cell.x)
    maxX = Math.max(maxX, cell.x)
    minY = Math.min(minY, cell.y)
    maxY = Math.max(maxY, cell.y)
    minZ = Math.min(minZ, cell.z)
    maxZ = Math.max(maxZ, cell.z)
  }
  return {
    min: {
      x: minX - margin,
      y: Math.max(MIN_Y, minY - lowerMargin),
      z: minZ - margin,
    },
    max: {
      x: maxX + margin,
      y: Math.min(MAX_Y, maxY + 6),
      z: maxZ + margin,
    },
  }
}

/**
 * Reads every block in the bounds, chunking along X when needed.
 *
 * Missing entries are meaningful (the planner reports `no_chunk`), so the
 * caller must treat a short result as an incomplete region. `exactShapes` is
 * true only when every chunk of the read reported exact collision shapes, so a
 * partial answer never opens the corridor follower.
 */
export async function readMovementRegion(port: MovementControlPort, bounds: RegionBounds): Promise<{ entries: SnapshotEntry[], exactShapes: boolean }> {
  const sizeY = bounds.max.y - bounds.min.y + 1
  const sizeZ = bounds.max.z - bounds.min.z + 1
  const perColumn = Math.max(1, sizeY * sizeZ)
  const stepX = Math.max(1, Math.floor(MAX_REGION_BLOCKS / perColumn))

  const detailed = port.getBlocksRegionDetailed
  const entries: SnapshotEntry[] = []
  let exactShapes = detailed !== undefined
  for (let x = bounds.min.x; x <= bounds.max.x; x += stepX) {
    const from = { x, y: bounds.min.y, z: bounds.min.z }
    const to = { x: Math.min(bounds.max.x, x + stepX - 1), y: bounds.max.y, z: bounds.max.z }
    if (detailed) {
      const chunk = await detailed.call(port, from, to)
      entries.push(...chunk.entries)
      if (!chunk.exactShapes)
        exactShapes = false
    }
    else {
      entries.push(...await port.getBlocksRegion(from, to))
    }
  }
  return { entries, exactShapes }
}
