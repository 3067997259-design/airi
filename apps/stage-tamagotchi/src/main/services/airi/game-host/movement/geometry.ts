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
