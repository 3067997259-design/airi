import type { Vec3 } from './geometry'
/**
 * Construction ordering (RS-2 §3).
 *
 * The order follows support, reach distance and later manipulation space: the
 * foundation goes down first, components are installed while their paths stay
 * open, the water stage is separated so an unfinished channel cannot run, and
 * the outer enclosure closes last. Redstone wiring is placed after the
 * enclosure so an incomplete machine cannot trigger early.
 *
 * A step's support is only a dependency when the support is itself projected:
 * terrain the plot already provides is assumed present. This keeps
 * {@link nextExecutableSteps} honest for a resume without a world read.
 */
import type { ProjectionBlock, ProjectionPlan } from './projection'

import { vecKey } from './geometry'

/** Ordered construction stages. Wiring is last so the machine cannot run early. */
export type ConstructionStageId = 'foundation' | 'components' | 'water' | 'enclosure' | 'wiring'

/** Stage order and the boundary reason each one protects. */
export const CONSTRUCTION_STAGES: ReadonlyArray<{ id: ConstructionStageId, order: number, boundary: string }> = [
  { id: 'foundation', order: 0, boundary: 'support for everything above' },
  { id: 'components', order: 1, boundary: 'installed while the inside is still reachable' },
  { id: 'water', order: 2, boundary: 'after the channel walls, before any wiring' },
  { id: 'enclosure', order: 3, boundary: 'the outer layer closes the inside last' },
  { id: 'wiring', order: 4, boundary: 'placed last so an unfinished machine cannot trigger' },
]

const WIRING_BLOCKS = new Set([
  'minecraft:redstone_wire',
  'minecraft:repeater',
  'minecraft:comparator',
  'minecraft:redstone_torch',
  'minecraft:redstone_wall_torch',
  'minecraft:observer',
  'minecraft:lever',
  'minecraft:stone_button',
  'minecraft:oak_button',
  'minecraft:redstone_block',
  'minecraft:tripwire',
  'minecraft:tripwire_hook',
])

const FLUID_BLOCKS = new Set(['minecraft:water', 'minecraft:flowing_water', 'minecraft:lava', 'minecraft:flowing_lava'])

const COMPONENT_BLOCKS = new Set([
  'minecraft:piston',
  'minecraft:sticky_piston',
  'minecraft:dispenser',
  'minecraft:dropper',
  'minecraft:hopper',
  'minecraft:chest',
  'minecraft:trapped_chest',
  'minecraft:barrel',
  'minecraft:furnace',
  'minecraft:blast_furnace',
  'minecraft:smoker',
  'minecraft:crafting_table',
  'minecraft:redstone_lamp',
])

/** One ordered construction step. */
export interface ConstructionStep {
  position: Vec3
  blockId: string
  properties?: Record<string, string>
  stage: ConstructionStageId
  /** Global order index within the plan. */
  order: number
  /** Why the step sits in this stage. */
  reason: string
  /** Projected block directly below, when one exists; it must be placed first. */
  requiresSupport?: Vec3
}

export interface ConstructionStage {
  id: ConstructionStageId
  boundary: string
  steps: ConstructionStep[]
}

export interface ConstructionPlan {
  stages: ConstructionStage[]
  /** All steps in execution order. */
  order: ConstructionStep[]
  totalSteps: number
}

export interface ConstructionOptions {
  /** Worker position used to prefer nearer blocks inside a stage. */
  reachFrom?: Vec3
  /** World positions of the outer enclosure, when the blueprint marks them. */
  outerLayer?: Vec3[]
}

function stageOf(block: ProjectionBlock, outerLayer: ReadonlySet<string>): ConstructionStageId {
  if (outerLayer.has(vecKey(block)))
    return 'enclosure'
  if (WIRING_BLOCKS.has(block.blockId))
    return 'wiring'
  if (FLUID_BLOCKS.has(block.blockId))
    return 'water'
  if (COMPONENT_BLOCKS.has(block.blockId))
    return 'components'
  return 'foundation'
}

function boundaryOf(id: ConstructionStageId): string {
  return CONSTRUCTION_STAGES.find(stage => stage.id === id)?.boundary ?? ''
}

/**
 * Plans the construction order for a projection.
 *
 * Within a stage, lower blocks come first (support before the block resting on
 * it) and nearer blocks come first. Across stages, the fixed stage order keeps
 * water and wiring from running an unfinished machine.
 */
export function planConstruction(plan: ProjectionPlan, options: ConstructionOptions = {}): ConstructionPlan {
  const outerLayer = new Set((options.outerLayer ?? []).map(vecKey))
  const projected = new Set(plan.blocks.map(vecKey))
  const reachFrom = options.reachFrom ?? plan.anchor
  const stageRank = new Map(CONSTRUCTION_STAGES.map(stage => [stage.id, stage.order]))

  const decorated = plan.blocks.map((block) => {
    const stage = stageOf(block, outerLayer)
    const below = { x: block.x, y: block.y - 1, z: block.z }
    const distance = Math.hypot(block.x - reachFrom.x, block.y - reachFrom.y, block.z - reachFrom.z)
    return {
      block,
      stage,
      distance,
      requiresSupport: projected.has(vecKey(below)) ? below : undefined,
    }
  })

  decorated.sort((left, right) => {
    const stageDelta = (stageRank.get(left.stage) ?? 0) - (stageRank.get(right.stage) ?? 0)
    if (stageDelta !== 0)
      return stageDelta
    if (left.block.y !== right.block.y)
      return left.block.y - right.block.y
    if (left.distance !== right.distance)
      return left.distance - right.distance
    if (left.block.x !== right.block.x)
      return left.block.x - right.block.x
    return left.block.z - right.block.z
  })

  const steps: ConstructionStep[] = decorated.map((entry, index) => ({
    position: { x: entry.block.x, y: entry.block.y, z: entry.block.z },
    blockId: entry.block.blockId,
    ...(entry.block.properties ? { properties: entry.block.properties } : {}),
    stage: entry.stage,
    order: index,
    reason: boundaryOf(entry.stage),
    ...(entry.requiresSupport ? { requiresSupport: entry.requiresSupport } : {}),
  }))

  const stages: ConstructionStage[] = CONSTRUCTION_STAGES.map(stage => ({
    id: stage.id,
    boundary: stage.boundary,
    steps: steps.filter(step => step.stage === stage.id),
  })).filter(stage => stage.steps.length > 0)

  return { stages, order: steps, totalSteps: steps.length }
}

/**
 * Next steps that may run now, in order.
 *
 * A step whose projected support is still missing is skipped; a fluid has no
 * projected support requirement because it is placed after its walls by stage
 * order. `placed` holds world cell keys of verified blocks.
 */
export function nextExecutableSteps(plan: ConstructionPlan, placed: ReadonlySet<string>, limit = 1): ConstructionStep[] {
  const executable: ConstructionStep[] = []
  for (const step of plan.order) {
    if (executable.length >= limit)
      break
    if (placed.has(vecKey(step.position)))
      continue
    if (step.requiresSupport && !placed.has(vecKey(step.requiresSupport)))
      continue
    executable.push(step)
  }
  return executable
}
