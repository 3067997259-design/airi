import type { BlueprintAccessPoint, BlueprintRecord } from './blueprint'
/**
 * Plot siting: bounds, diggable depth, rotation and centering (RS-1 §3).
 *
 * Siting is a pure decision. It first checks the plot and its diggable depth,
 * then computes the rotated full-structure bounding box (subregion offsets
 * included, so a blueprint origin that is not the structure's lower-left corner
 * still gives the true footprint). The structure is centered on the plot; when
 * an odd/even mismatch prevents exact centering the nearest legal integer cell
 * is chosen and the deviation is recorded.
 *
 * A plot that cannot hold the blueprint yields a concrete conflict. The
 * blueprint is never truncated to fit.
 */
import type { Bounds, Face, Orientation, Vec3 } from './geometry'

import { blueprintBlocks, transformBlueprintBlocks } from './blueprint'
import { ALL_FACES, ALL_ORIENTATIONS, boundsContain, boundsOfPoints, FACE_STEPS, rotateFace, rotateVec3, translateBounds, vecKey } from './geometry'

/** The site a blueprint must fit into. */
export interface PlotSpec {
  /** Inclusive plot box; the placement must stay inside it. */
  bounds: Bounds
  /** Y the structure's lowest block occupies when `digDepth` is zero. */
  floorY: number
  /** How far below `floorY` the plot may be dug for water/basics. */
  diggableDepth: number
}

/** What an orientation must satisfy to be legal. */
export interface SitingRequirements {
  /**
   * Orientations to try, in preference order. Defaults to all four yaws.
   * The first legal one wins.
   */
  orientations?: Orientation[]
  /**
   * Clear space in blocks required on a side of the structure, inside the plot.
   * The side is named in the blueprint's own frame before rotation.
   */
  maintenance?: Partial<Record<Face, number>>
}

/** One access point resolved to a world position and a standing cell. */
export interface SitingAccessPlacement {
  name: string
  kind: BlueprintAccessPoint['kind']
  position: Vec3
  standPoint: Vec3
}

export type SitingConflictKind
  = | 'empty_blueprint'
    | 'footprint_out_of_bounds'
    | 'insufficient_diggable_depth'
    | 'maintenance_space_missing'
    | 'access_unreachable'
    | 'no_orientation'

/** A concrete reason one orientation (or the whole plot) was rejected. */
export interface SitingConflict {
  kind: SitingConflictKind
  detail: string
  orientation?: Orientation
}

/** A legal placement of the blueprint. */
export interface SitingPlacement {
  orientation: Orientation
  /** World position the blueprint relative origin maps to. */
  anchor: Vec3
  /** World bounding box of the whole structure. */
  bounds: Bounds
  /**
   * Structure center minus plot center, per axis. Zero means exact centering;
   * `x: 0.5` means the structure is half a block east of the plot center.
   */
  deviation: Vec3
  /** Layers dug below `floorY`; equals the blueprint dig depth. */
  digDepth: number
  access: SitingAccessPlacement[]
}

export type SitingResult
  = | { ok: true, placement: SitingPlacement }
    | { ok: false, conflicts: SitingConflict[] }

function orientationLabel(orientation: Orientation): string {
  return `${orientation}deg`
}

/**
 * Checks the clear-space margin required on each side.
 *
 * Returns a conflict when the margin leaves the plot, so a structure pushed
 * against the plot edge is rejected instead of being reported as centered.
 */
function maintenanceConflict(bounds: Bounds, plot: Bounds, maintenance: Partial<Record<Face, number>> | undefined): SitingConflict | undefined {
  if (!maintenance)
    return undefined
  for (const face of ALL_FACES) {
    const margin = maintenance[face]
    if (!margin || margin <= 0)
      continue
    const step = FACE_STEPS[face]
    const required: Bounds = {
      min: { x: bounds.min.x + step.x * margin, y: bounds.min.y + step.y * margin, z: bounds.min.z + step.z * margin },
      max: { x: bounds.max.x + step.x * margin, y: bounds.max.y + step.y * margin, z: bounds.max.z + step.z * margin },
    }
    if (required.min.x < plot.min.x || required.max.x > plot.max.x
      || required.min.z < plot.min.z || required.max.z > plot.max.z
      || required.min.y < plot.min.y || required.max.y > plot.max.y) {
      return { kind: 'maintenance_space_missing', detail: `no ${margin}-block maintenance space on the ${face} side` }
    }
  }
  return undefined
}

/**
 * Resolves access points and checks each standing cell is inside the plot and
 * not filled by the structure itself.
 */
function resolveAccess(
  accessPoints: readonly BlueprintAccessPoint[],
  anchor: Vec3,
  orientation: Orientation,
  occupied: ReadonlySet<string>,
  plot: Bounds,
): { access: SitingAccessPlacement[] } | { conflict: SitingConflict } {
  const access: SitingAccessPlacement[] = []
  for (const point of accessPoints) {
    const local = rotateVec3({ x: point.x, y: point.y, z: point.z }, orientation)
    const position = { x: anchor.x + local.x, y: anchor.y + local.y, z: anchor.z + local.z }
    const outward = rotateFace(point.outward, orientation)
    const step = FACE_STEPS[outward]
    const standPoint = { x: position.x + step.x, y: position.y + step.y, z: position.z + step.z }
    if (!boundsContain(plot, standPoint) || !boundsContain(plot, { x: standPoint.x, y: standPoint.y + 1, z: standPoint.z }))
      return { conflict: { kind: 'access_unreachable', detail: `access "${point.name}" has no standing cell inside the plot` } }
    if (occupied.has(vecKey(standPoint)) || occupied.has(vecKey({ x: standPoint.x, y: standPoint.y + 1, z: standPoint.z })))
      return { conflict: { kind: 'access_unreachable', detail: `access "${point.name}" standing cell is filled by the structure` } }
    access.push({ name: point.name, kind: point.kind, position, standPoint })
  }
  return { access }
}

/**
 * Chooses the first legal orientation and centers the structure on the plot.
 *
 * @example
 * planSiting(blueprint, { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 5, z: 15 } }, floorY: 1, diggableDepth: 0 })
 * // => { ok: true, placement: { orientation: 0, anchor: { x: 7, y: 1, z: 7 }, ... } }
 */
export function planSiting(
  blueprint: BlueprintRecord,
  plot: PlotSpec,
  requirements: SitingRequirements = {},
): SitingResult {
  if (blueprintBlocks(blueprint).length === 0)
    return { ok: false, conflicts: [{ kind: 'empty_blueprint', detail: 'the blueprint has no blocks' }] }

  const conflicts: SitingConflict[] = []
  if (blueprint.digDepth > plot.diggableDepth) {
    conflicts.push({
      kind: 'insufficient_diggable_depth',
      detail: `the blueprint needs ${blueprint.digDepth} dug layers but the plot allows ${plot.diggableDepth}`,
    })
  }

  const orientations = requirements.orientations ?? ALL_ORIENTATIONS
  if (orientations.length === 0) {
    return { ok: false, conflicts: [...conflicts, { kind: 'no_orientation', detail: 'no orientation candidates were offered' }] }
  }

  const plotCenterX = (plot.bounds.min.x + plot.bounds.max.x) / 2
  const plotCenterZ = (plot.bounds.min.z + plot.bounds.max.z) / 2

  for (const orientation of orientations) {
    const rotated = transformBlueprintBlocks(blueprint, orientation)
    const relBounds = boundsOfPoints(rotated.map(block => ({ x: block.x, y: block.y, z: block.z })))
    if (!relBounds) {
      conflicts.push({ kind: 'empty_blueprint', detail: `orientation ${orientationLabel(orientation)} has no blocks`, orientation })
      continue
    }
    if (blueprint.digDepth > plot.diggableDepth) {
      // The plot-level conflict already covers this; skip the candidate.
      continue
    }

    const lowestY = plot.floorY - blueprint.digDepth
    const anchorY = lowestY - relBounds.min.y
    const centerX = (relBounds.min.x + relBounds.max.x) / 2
    const centerZ = (relBounds.min.z + relBounds.max.z) / 2
    const anchorX = Math.round(plotCenterX - centerX)
    const anchorZ = Math.round(plotCenterZ - centerZ)
    const anchor: Vec3 = { x: anchorX, y: anchorY, z: anchorZ }
    const deviation: Vec3 = {
      x: anchorX + centerX - plotCenterX,
      y: 0,
      z: anchorZ + centerZ - plotCenterZ,
    }

    const worldBounds = translateBounds(relBounds, anchor)
    if (worldBounds.min.x < plot.bounds.min.x || worldBounds.max.x > plot.bounds.max.x
      || worldBounds.min.z < plot.bounds.min.z || worldBounds.max.z > plot.bounds.max.z) {
      conflicts.push({ kind: 'footprint_out_of_bounds', detail: `orientation ${orientationLabel(orientation)} does not fit the plot horizontally: ${JSON.stringify(worldBounds)}`, orientation })
      continue
    }
    if (worldBounds.min.y < plot.bounds.min.y || worldBounds.max.y > plot.bounds.max.y) {
      conflicts.push({ kind: 'insufficient_diggable_depth', detail: `orientation ${orientationLabel(orientation)} does not fit the plot vertically: ${JSON.stringify(worldBounds)}`, orientation })
      continue
    }

    const maintenance = maintenanceConflict(worldBounds, plot.bounds, requirements.maintenance)
    if (maintenance) {
      conflicts.push({ ...maintenance, orientation })
      continue
    }

    const occupied = new Set(rotated.map(block => vecKey({ x: anchor.x + block.x, y: anchor.y + block.y, z: anchor.z + block.z })))
    const accessResult = resolveAccess(blueprint.accessPoints, anchor, orientation, occupied, plot.bounds)
    if ('conflict' in accessResult) {
      conflicts.push({ ...accessResult.conflict, orientation })
      continue
    }

    return {
      ok: true,
      placement: {
        orientation,
        anchor,
        bounds: worldBounds,
        deviation,
        digDepth: blueprint.digDepth,
        access: accessResult.access,
      },
    }
  }

  return { ok: false, conflicts }
}
