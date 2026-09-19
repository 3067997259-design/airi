/**
 * Pure geometry and timing helpers shared by the movement movers (MC-3).
 *
 * Kept in one module so the movers never import each other's internals and a
 * runtime import cycle cannot form between the dispatcher and its movers.
 */
import type { Vec3 } from './types'

export function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** Minecraft yaw for a direction vector: 0 = south, -90 = east. */
export function yawTo(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), to.z - from.z) * 180 / Math.PI
}

/**
 * Point `distance` blocks from `from` along a Minecraft yaw.
 *
 * The inverse of {@link yawTo}, for callers that hold a heading instead of a
 * target. Keep the sign pair here rather than in each mover: a flipped sine aims
 * the flight at the mirror image of the heading and still looks plausible.
 */
export function pointAtYaw(from: Vec3, yaw: number, distance: number): Vec3 {
  const radians = yaw * Math.PI / 180
  return { x: from.x - Math.sin(radians) * distance, y: from.y, z: from.z + Math.cos(radians) * distance }
}

export function angleDelta(a: number, b: number): number {
  let delta = (b - a) % 360
  if (delta > 180)
    delta -= 360
  if (delta < -180)
    delta += 360
  return delta
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
