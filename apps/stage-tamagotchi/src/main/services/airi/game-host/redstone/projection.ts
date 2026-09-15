import type { BlueprintMaterialRequirement, BlueprintRecord } from './blueprint'
/**
 * Projection data for survival construction (RS-1 §2, §3).
 *
 * A projection is exactly the placement data a player build needs: world block
 * states, the material list and the resolved anchor/orientation. Entity pasting
 * (Litematica's direct structure generation) is deliberately not modeled here;
 * the survival build only ever places blocks. {@link buildProjectionPlan} emits
 * `mode: 'projection'` and {@link assertPlacementOnly} makes that contract
 * checkable by callers.
 */
import type { Bounds, Orientation, Vec3 } from './geometry'
import type { SitingPlacement } from './siting'

import { materialRequirementsOf, transformBlueprintBlocks } from './blueprint'

/** Identity of one projection; independent of the control session that builds it. */
export interface ProjectionIdentity {
  /** Id of this projection, minted by the owning task. */
  projectionId: string
  /** Task that owns the projection; only this task manages it. */
  taskId: string
  /** Content digest of the source blueprint. */
  blueprintContentDigest: string
  /** Blueprint version the projection was built from. */
  blueprintVersion: number
}

/** One world block the projection places. */
export interface ProjectionBlock {
  x: number
  y: number
  z: number
  blockId: string
  properties?: Record<string, string>
}

/**
 * Placement data for one projection.
 *
 * `mode` is the compile-time guard against treating this as an entity paste;
 * consumers must branch on it instead of assuming blocks are the only data.
 */
export interface ProjectionPlan {
  identity: ProjectionIdentity
  mode: 'projection'
  orientation: Orientation
  anchor: Vec3
  bounds: Bounds
  blocks: ProjectionBlock[]
  materials: BlueprintMaterialRequirement[]
}

/**
 * Builds a projection from a sited blueprint.
 *
 * The output is placement data only: no entity list, no template NBT. The
 * caller is responsible for the survival construction order in `construction.ts`.
 */
export function buildProjectionPlan(input: {
  identity: ProjectionIdentity
  blueprint: BlueprintRecord
  placement: SitingPlacement
}): ProjectionPlan {
  const rotated = transformBlueprintBlocks(input.blueprint, input.placement.orientation)
  const blocks: ProjectionBlock[] = rotated.map(block => ({
    x: block.x + input.placement.anchor.x,
    y: block.y + input.placement.anchor.y,
    z: block.z + input.placement.anchor.z,
    blockId: block.blockId,
    ...(block.properties ? { properties: block.properties } : {}),
  }))
  return {
    identity: input.identity,
    mode: 'projection',
    orientation: input.placement.orientation,
    anchor: input.placement.anchor,
    bounds: input.placement.bounds,
    blocks,
    materials: materialRequirementsOf(input.blueprint),
  }
}

/** Throws when a plan is not placement-only data. */
export function assertPlacementOnly(plan: ProjectionPlan): void {
  if (plan.mode !== 'projection')
    throw new Error(`projection ${plan.identity?.projectionId ?? 'unknown'} is not placement-only data`)
}
