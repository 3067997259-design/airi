/**
 * Shared pure geometry for redstone construction (RS-1..RS-4).
 *
 * Blueprint blocks are stored as offsets from the blueprint's relative origin,
 * so the origin is not necessarily the structure's lower-left corner. Siting
 * rotates those offsets around the origin, and construction/projection reuse the
 * same transform. Keeping one definition here stops the modules from drifting
 * into different rotation conventions.
 */

/** A block position, in any frame (blueprint-relative or world). */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Block faces; the six neighbours a placement can click or stand against. */
export type Face = 'up' | 'down' | 'north' | 'south' | 'east' | 'west'

/**
 * Yaw rotations a blueprint can be placed at, in degrees.
 *
 * The rotation is applied around the Y axis. The formula is documented on
 * {@link rotateVec3} because a mirrored placement is deliberately out of scope.
 */
export type Orientation = 0 | 90 | 180 | 270

/** Inclusive integer bounds of an axis-aligned box. */
export interface Bounds {
  min: Vec3
  max: Vec3
}

/** Unit step from a block to the neighbour on each face. */
export const FACE_STEPS: Record<Face, Vec3> = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
}

export const ALL_FACES: readonly Face[] = ['north', 'south', 'east', 'west', 'up', 'down']

export const ALL_ORIENTATIONS: readonly Orientation[] = [0, 90, 180, 270]

const OPPOSITE_FACE: Record<Face, Face> = {
  up: 'down',
  down: 'up',
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
}

/** The face that looks back at the given one. */
export function oppositeFace(face: Face): Face {
  return OPPOSITE_FACE[face]
}

/**
 * Rotates a blueprint-relative offset around the blueprint origin.
 *
 * A 90 degree step follows the right-handed +Y rotation, so `(x, z) -> (z, -x)`.
 * The relative origin maps to itself, which is why the origin does not have to
 * sit at the structure's lower-left corner.
 *
 * @example
 * rotateVec3({ x: 0, y: 0, z: -1 }, 90)
 * // => { x: -1, y: 0, z: 0 }
 */
export function rotateVec3(vector: Vec3, orientation: Orientation): Vec3 {
  switch (orientation) {
    case 0:
      return { x: vector.x, y: vector.y, z: vector.z }
    case 90:
      return { x: vector.z, y: vector.y, z: -vector.x }
    case 180:
      return { x: -vector.x, y: vector.y, z: -vector.z }
    case 270:
      return { x: -vector.z, y: vector.y, z: vector.x }
  }
}

/**
 * Rotates a face with the same transform as {@link rotateVec3}.
 *
 * Used for directional block properties (`facing`) so a rotated projection keeps
 * its observers, repeaters and pistons pointing at the right neighbour.
 *
 * @example
 * rotateFace('north', 90)
 * // => 'west'
 */
export function rotateFace(face: Face, orientation: Orientation): Face {
  const step = rotateVec3(FACE_STEPS[face], orientation)
  return faceOfStep(step) ?? face
}

/** Maps a unit face step back to its face name; undefined when it is not axis-aligned. */
export function faceOfStep(step: Vec3): Face | undefined {
  for (const face of ALL_FACES) {
    const candidate = FACE_STEPS[face]
    if (candidate.x === step.x && candidate.y === step.y && candidate.z === step.z)
      return face
  }
  return undefined
}

/** Axis a directional property refers to (`axis=x|y|z`), rotated like a face. */
export function rotateAxis(axis: string, orientation: Orientation): string {
  const step = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'z' ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }
  const rotated = rotateVec3(step, orientation)
  if (rotated.x !== 0)
    return 'x'
  if (rotated.z !== 0)
    return 'z'
  return 'y'
}

/** The rotation that undoes an orientation. */
export function inverseOrientation(orientation: Orientation): Orientation {
  switch (orientation) {
    case 90:
      return 270
    case 270:
      return 90
    default:
      return orientation
  }
}

/** Sums two vectors. */
export function addVec3(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z }
}

/** Subtracts `right` from `left`. */
export function subtractVec3(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z }
}

export function isSameVec3(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}

/** Inclusive minimum/maximum bounds of a non-empty point list. */
export function boundsOfPoints(points: readonly Vec3[]): Bounds | undefined {
  if (points.length === 0)
    return undefined
  const min: Vec3 = { x: points[0].x, y: points[0].y, z: points[0].z }
  const max: Vec3 = { x: points[0].x, y: points[0].y, z: points[0].z }
  for (const point of points) {
    min.x = Math.min(min.x, point.x)
    min.y = Math.min(min.y, point.y)
    min.z = Math.min(min.z, point.z)
    max.x = Math.max(max.x, point.x)
    max.y = Math.max(max.y, point.y)
    max.z = Math.max(max.z, point.z)
  }
  return { min, max }
}

/** Smallest box containing both inputs. */
export function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    min: { x: Math.min(left.min.x, right.min.x), y: Math.min(left.min.y, right.min.y), z: Math.min(left.min.z, right.min.z) },
    max: { x: Math.max(left.max.x, right.max.x), y: Math.max(left.max.y, right.max.y), z: Math.max(left.max.z, right.max.z) },
  }
}

/** Inclusive size of a box: a single cell is `1,1,1`. */
export function boundsSize(bounds: Bounds): Vec3 {
  return {
    x: bounds.max.x - bounds.min.x + 1,
    y: bounds.max.y - bounds.min.y + 1,
    z: bounds.max.z - bounds.min.z + 1,
  }
}

/** Translates a box by an offset. */
export function translateBounds(bounds: Bounds, offset: Vec3): Bounds {
  return { min: addVec3(bounds.min, offset), max: addVec3(bounds.max, offset) }
}

/** True when the point lies inside the inclusive box. */
export function boundsContain(bounds: Bounds, point: Vec3): boolean {
  return point.x >= bounds.min.x && point.x <= bounds.max.x
    && point.y >= bounds.min.y && point.y <= bounds.max.y
    && point.z >= bounds.min.z && point.z <= bounds.max.z
}

/**
 * True when `inner` fits inside `outer`, axis by axis, inclusive.
 *
 * Used by siting to reject a footprint that leaves the plot instead of silently
 * truncating the blueprint.
 */
export function boundsWithin(inner: Bounds, outer: Bounds): boolean {
  return inner.min.x >= outer.min.x && inner.max.x <= outer.max.x
    && inner.min.y >= outer.min.y && inner.max.y <= outer.max.y
    && inner.min.z >= outer.min.z && inner.max.z <= outer.max.z
}

/** Stable map key for one integer block position. */
export function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** Stable map key for a {@link Vec3}. */
export function vecKey(vector: Vec3): string {
  return cellKey(vector.x, vector.y, vector.z)
}
