/**
 * Collision geometry shared by the shape-driven movers (CD-G2, Step 2).
 *
 * Kept in a module with no mover dependencies so the corridor sweep, the jump
 * planner and future shape checks can all use the same player box and block
 * box derivation without importing each other.
 */
import type { BlockInfo, Vec3 } from './types'

/** Player collision footprint, matching the vanilla standing box. */
export const PLAYER_HALF_WIDTH = 0.3
export const PLAYER_HEIGHT = 1.8

export interface Aabb {
  min: Vec3
  max: Vec3
}

/** World-space collision boxes of one block, derived when the source sent none. */
export function collisionBoxesOf(block: BlockInfo): Aabb[] {
  if (block.collision)
    return block.collision.map(box => worldBox(block, box))
  if (block.physical)
    return [worldBox(block, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 })]
  // Slabs, stairs and carpets are not full cubes but still collide. The derived
  // box is the lower part up to the classified top; the exact shape of a top
  // slab or stair step needs the source's collision data.
  if (block.safe && block.height > block.y + 0.01) {
    const maxY = Math.min(Math.max(block.height - block.y, 0), 1)
    return [worldBox(block, { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY, maxZ: 1 })]
  }
  return []
}

function worldBox(block: BlockInfo, box: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }): Aabb {
  return {
    min: { x: block.x + box.minX, y: block.y + box.minY, z: block.z + box.minZ },
    max: { x: block.x + box.maxX, y: block.y + box.maxY, z: block.z + box.maxZ },
  }
}

/** Player AABB for a foot position. */
export function playerBox(foot: Vec3): Aabb {
  return {
    min: { x: foot.x - PLAYER_HALF_WIDTH, y: foot.y, z: foot.z - PLAYER_HALF_WIDTH },
    max: { x: foot.x + PLAYER_HALF_WIDTH, y: foot.y + PLAYER_HEIGHT, z: foot.z + PLAYER_HALF_WIDTH },
  }
}

export function overlapsXZ(a: Aabb, b: Aabb): boolean {
  return a.min.x < b.max.x - 1e-6 && a.max.x > b.min.x + 1e-6
    && a.min.z < b.max.z - 1e-6 && a.max.z > b.min.z + 1e-6
}

/** True when the two boxes overlap on all three axes. */
export function overlaps3(a: Aabb, b: Aabb): boolean {
  return overlapsXZ(a, b)
    && a.min.y < b.max.y - 1e-6 && a.max.y > b.min.y + 1e-6
}
