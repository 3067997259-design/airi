import type { Vec3 } from './geometry'
/**
 * Static configuration vs runtime state (RS-2 §3).
 *
 * A blueprint fixes a structure's design: a repeater's delay, an observer's
 * facing, a piston's direction, a hopper's output. Those are configuration. The
 * world also reports live facts: a repeater is `powered`, a piston is
 * `extended`, an observer is `triggered`. A blueprint's momentary runtime value
 * must never be required forever, so verification compares configuration
 * strictly and records runtime state as an observation only.
 *
 * The classification is a first engineering split. Blocks whose property
 * semantics differ can be adjusted here without touching the verification.
 */
import type { ProjectionBlock } from './projection'

import { vecKey } from './geometry'

/** One block state as a blueprint or a fresh world read reports it. */
export interface BlockStateView {
  blockId: string
  properties?: Record<string, string>
}

/**
 * Properties that describe the design and must match the blueprint.
 *
 * A mismatch here is a build error, not a world state that happens to differ.
 */
export const STATIC_PROPERTIES: ReadonlySet<string> = new Set([
  'facing',
  'axis',
  'delay',
  'rotation',
  'half',
  'shape',
  'hinge',
  'part',
  'attachment',
  'orientation',
  'mode',
  'conditional',
  'in_wall',
  'east',
  'north',
  'south',
  'west',
  'up',
  'down',
])

/**
 * Properties that change as the structure runs. They are observed, never
 * required: a powered repeater and an unpowered one are the same build.
 */
export const RUNTIME_PROPERTIES: ReadonlySet<string> = new Set([
  'powered',
  'extended',
  'triggered',
  'locked',
  'enabled',
  'open',
  'waterlogged',
  'signal_fire',
  'disarmed',
  'lit',
  'occupied',
  'power',
  'eye',
])

/** One property difference between the design and the world. */
export interface PropertyMismatch {
  property: string
  expected?: string
  observed?: string
}

/** Static comparison result for one block. */
export interface StaticComparison {
  matches: boolean
  /** Static properties that differ or are absent in the observation. */
  mismatches: PropertyMismatch[]
}

/**
 * Compares design configuration only.
 *
 * Properties absent from the observation are reported as mismatches for static
 * keys: an unreadable configuration is not a match.
 */
export function compareStaticConfiguration(expected: BlockStateView, observed: BlockStateView): StaticComparison {
  const mismatches: PropertyMismatch[] = []
  if (expected.blockId !== observed.blockId) {
    mismatches.push({ property: 'blockId', expected: expected.blockId, observed: observed.blockId })
  }
  for (const [property, value] of Object.entries(expected.properties ?? {})) {
    if (!STATIC_PROPERTIES.has(property))
      continue
    const actual = observed.properties?.[property]
    if (actual !== value)
      mismatches.push({ property, expected: value, ...(actual !== undefined ? { observed: actual } : {}) })
  }
  return { matches: mismatches.length === 0, mismatches }
}

/**
 * Reads runtime facts without treating them as failures.
 *
 * @example
 * compareRuntimeState({ blockId: 'minecraft:repeater', properties: { powered: 'false' } }, { blockId: 'minecraft:repeater', properties: { powered: 'true' } })
 * // => { facts: [{ property: 'powered', observed: 'true' }] }
 */
export function compareRuntimeState(observed: BlockStateView): { facts: PropertyMismatch[] } {
  const facts: PropertyMismatch[] = []
  for (const [property, value] of Object.entries(observed.properties ?? {})) {
    if (RUNTIME_PROPERTIES.has(property))
      facts.push({ property, observed: value })
  }
  return { facts: facts.sort((left, right) => left.property < right.property ? -1 : 1) }
}

export type StructuralMismatchKind = 'missing' | 'wrong_block' | 'wrong_configuration'

/** One structural problem at a position. */
export interface StructuralMismatch {
  position: Vec3
  kind: StructuralMismatchKind
  detail: string
  mismatches?: PropertyMismatch[]
}

/** Result of checking a projection against a fresh world read. */
export interface StructuralVerification {
  matches: boolean
  checked: number
  mismatches: StructuralMismatch[]
  /** Runtime properties seen at the matching positions; never a failure. */
  runtimeFacts: Array<{ position: Vec3, property: string, value: string }>
}

/**
 * Verifies every projected block against observed world state.
 *
 * Static configuration (facing, repeater delay, observer/piston facing, hopper
 * output) is checked strictly. Runtime state (powered, extended) is collected
 * separately so a running machine still verifies structurally.
 */
export function verifyStructure(
  expectedBlocks: readonly ProjectionBlock[],
  observed: ReadonlyMap<string, BlockStateView>,
): StructuralVerification {
  const mismatches: StructuralMismatch[] = []
  const runtimeFacts: StructuralVerification['runtimeFacts'] = []
  for (const block of expectedBlocks) {
    const position = { x: block.x, y: block.y, z: block.z }
    const state = observed.get(vecKey(position))
    if (!state) {
      mismatches.push({ position, kind: 'missing', detail: `${block.blockId} was not observed at ${vecKey(position)}` })
      continue
    }
    const comparison = compareStaticConfiguration(
      { blockId: block.blockId, ...(block.properties ? { properties: block.properties } : {}) },
      state,
    )
    if (!comparison.matches) {
      mismatches.push({
        position,
        kind: state.blockId === block.blockId ? 'wrong_configuration' : 'wrong_block',
        detail: state.blockId === block.blockId
          ? `configuration differs at ${vecKey(position)}`
          : `expected ${block.blockId}, observed ${state.blockId}`,
        mismatches: comparison.mismatches,
      })
    }
    for (const fact of compareRuntimeState(state).facts) {
      runtimeFacts.push({ position, property: fact.property, ...(fact.observed !== undefined ? { value: fact.observed } : { value: '' }) })
    }
  }
  return {
    matches: mismatches.length === 0,
    checked: expectedBlocks.length,
    mismatches,
    runtimeFacts,
  }
}
