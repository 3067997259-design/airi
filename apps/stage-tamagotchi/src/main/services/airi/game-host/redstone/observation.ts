/**
 * Functional observation for the sugarcane machine (RS-3 §4).
 *
 * A functional run is read from bounded server-side batches: the trigger, the
 * signal along the line, every piston, the drop transport and the chest delta.
 * Every batch carries its world, dimension, sampling source and completeness. A
 * batch that was not read, was truncated or failed is unknown; a missed read is
 * never reported as "signal zero".
 *
 * The module is pure. It assembles a window from batches, reads one column at a
 * tick, evaluates the functional acceptance and separates artificial test input
 * (hand-planted cane) from natural growth.
 */
import type { ObservationCompleteness } from '../movement/observation'
import type { Vec3 } from './geometry'

import { DimensionMismatchError } from '../movement/observation'

/** Where the sample in a batch came from. A source is not a freshness proof. */
export type SamplingSource = 'client-loaded-world' | 'server-region-recorder' | 'server-events'

/** One signal read on a named column at one tick. */
export interface SignalSample {
  tick: number
  /** Column identity, e.g. `left-observer` or `line-7`. */
  column: string
  position: Vec3
  /** `true` powered, `false` unpowered; missing means the read had no value. */
  powered?: boolean
  source: SamplingSource
  completeness: ObservationCompleteness
}

/** One piston action. */
export interface PistonEvent {
  tick: number
  piston: string
  action: 'extend' | 'retract'
  position: Vec3
  source: SamplingSource
  completeness: ObservationCompleteness
}

/** One drop position seen while it travelled along the water. */
export interface DropTransportSample {
  tick: number
  position: Vec3
  itemId?: string
  source: SamplingSource
  completeness: ObservationCompleteness
}

/** One chest population change. */
export interface ChestDelta {
  tick: number
  chest: string
  itemId: string
  before: number
  after: number
  source: SamplingSource
  completeness: ObservationCompleteness
}

/** One bounded read of the server recorder. */
export interface ObservationBatch {
  worldId: string
  dimension: string
  source: SamplingSource
  fromTick: number
  toTick: number
  completeness: ObservationCompleteness
  missingReason?: string
  signalSamples: SignalSample[]
  pistonEvents: PistonEvent[]
  dropSamples: DropTransportSample[]
  chestDeltas: ChestDelta[]
}

/** A run's observation, assembled from ordered batches. */
export interface ObservationWindow {
  worldId: string
  dimension: string
  batches: ObservationBatch[]
}

/** Raised when a batch belongs to another dimension than the run. */
export function assertBatchDimension(requested: string, batch: ObservationBatch): void {
  if (requested && batch.dimension !== requested)
    throw new DimensionMismatchError(requested, batch.dimension)
}

/**
 * Assembles a window, rejecting a batch from another world or dimension.
 *
 * A batch is kept even when incomplete: completeness travels on the batch so a
 * caller can tell "read nothing" from "read and found zero".
 */
export function buildObservationWindow(
  identity: { worldId: string, dimension: string },
  batches: readonly ObservationBatch[],
): ObservationWindow {
  for (const batch of batches) {
    assertBatchDimension(identity.dimension, batch)
    if (identity.worldId && batch.worldId !== identity.worldId)
      throw new Error(`Observation batch world mismatch: requested ${identity.worldId}, received ${batch.worldId}.`)
  }
  const sorted = [...batches].sort((left, right) => left.fromTick - right.fromTick || left.toTick - right.toTick)
  return { worldId: identity.worldId, dimension: identity.dimension, batches: sorted }
}

/** Result of reading one column at one tick. `observed` false is not zero. */
export interface SignalReading {
  observed: boolean
  powered?: boolean
  tick?: number
  source?: SamplingSource
  missingReason?: string
}

function batchCovering(window: ObservationWindow, tick: number): ObservationBatch | undefined {
  for (let index = window.batches.length - 1; index >= 0; index--) {
    const batch = window.batches[index]
    if (batch.fromTick <= tick && tick <= batch.toTick)
      return batch
  }
  return undefined
}

/**
 * Reads one column at one tick.
 *
 * Returns `observed: false` when no batch covered the tick, the covering batch
 * was incomplete, or the sample carried no value. It never returns
 * `powered: false` for a read that did not happen.
 */
export function readSignalAt(window: ObservationWindow, column: string, tick: number): SignalReading {
  const batch = batchCovering(window, tick)
  if (!batch)
    return { observed: false, missingReason: 'tick_not_sampled' }
  if (batch.completeness !== 'complete')
    return { observed: false, source: batch.source, missingReason: batch.missingReason ?? `batch_${batch.completeness}` }
  const samples = batch.signalSamples
    .filter(sample => sample.column === column && sample.tick <= tick)
    .sort((left, right) => right.tick - left.tick)
  const sample = samples[0]
  if (!sample)
    return { observed: false, source: batch.source, missingReason: 'column_not_sampled' }
  if (sample.completeness !== 'complete' || sample.powered === undefined)
    return { observed: false, source: sample.source, tick: sample.tick, missingReason: 'sample_incomplete' }
  return { observed: true, powered: sample.powered, tick: sample.tick, source: sample.source }
}

/** Per-column signal summary over the window. */
export interface ColumnSummary {
  column: string
  /** Ticks a complete read saw the column powered. */
  poweredTicks: number
  /** Ticks a complete read saw the column unpowered. */
  unpoweredTicks: number
  /** Ticks the column was not read; never counted as unpowered. */
  unobservedTicks: number
  /** True when at least one complete read returned a power value at all. */
  everObserved: boolean
  /** True when at least one complete read saw the column powered. */
  everPowered: boolean
}

/** Summarizes columns by complete reads only. */
export function summarizeColumns(window: ObservationWindow, columns: readonly string[], fromTick: number, toTick: number): ColumnSummary[] {
  return columns.map((column) => {
    let poweredTicks = 0
    let unpoweredTicks = 0
    let unobservedTicks = 0
    for (let tick = fromTick; tick <= toTick; tick++) {
      const reading = readSignalAt(window, column, tick)
      if (!reading.observed) {
        unobservedTicks += 1
        continue
      }
      if (reading.powered)
        poweredTicks += 1
      else
        unpoweredTicks += 1
    }
    return { column, poweredTicks, unpoweredTicks, unobservedTicks, everObserved: poweredTicks + unpoweredTicks > 0, everPowered: poweredTicks > 0 }
  })
}

/** Growth input a cane sample represents; artificial input is not natural growth. */
export type GrowthInput = 'manual-planting' | 'natural-growth'

/** One sugarcane height observation. */
export interface SugarcaneHeightSample {
  tick: number
  position: Vec3
  height: number
  input: GrowthInput
  source: SamplingSource
  completeness: ObservationCompleteness
}

/** Splits artificial test input from natural growth. */
export function separateGrowthInputs(samples: readonly SugarcaneHeightSample[]): { artificial: SugarcaneHeightSample[], natural: SugarcaneHeightSample[] } {
  const artificial: SugarcaneHeightSample[] = []
  const natural: SugarcaneHeightSample[] = []
  for (const sample of samples) {
    if (sample.input === 'manual-planting')
      artificial.push(sample)
    else
      natural.push(sample)
  }
  return { artificial, natural }
}

/** Functional expectations for the sugarcane machine. */
export interface FunctionalExpectation {
  /** Signal columns that must be observed powered at least once. */
  triggerColumns: string[]
  /** Pistons that must be observed extending. */
  pistons: string[]
  /** Item the chest must gain. */
  itemId: string
  /** Minimum chest increase across the window. */
  minChestDelta: number
  /** Tick range the acceptance covers. */
  fromTick: number
  toTick: number
  /** Root positions that must still hold cane after the harvest. */
  roots?: Vec3[]
}

/** What the fresh site read reported at each root position. */
export interface RootObservation {
  position: Vec3
  blockId: string
  expectedBlockId: string
}

export interface FunctionalAcceptance {
  met: boolean
  checks: Array<{ check: string, met: boolean, reason?: string }>
  /** Items that could not be finished inside the observation budget. */
  unfinished: string[]
  chestDelta: number
}

/**
 * Evaluates the functional acceptance.
 *
 * An incomplete read makes its check unmet with reason `observation_incomplete`
 * and marks the item unfinished; it never counts as a pass. A complete read that
 * saw no signal, no piston or no chest gain is a real failure.
 */
export function evaluateFunctionalAcceptance(
  window: ObservationWindow,
  expectation: FunctionalExpectation,
  rootObservations: readonly RootObservation[] = [],
): FunctionalAcceptance {
  const checks: FunctionalAcceptance['checks'] = []
  const unfinished: string[] = []

  const summaries = summarizeColumns(window, expectation.triggerColumns, expectation.fromTick, expectation.toTick)
  for (const summary of summaries) {
    if (summary.everPowered) {
      checks.push({ check: `trigger:${summary.column}`, met: true })
    }
    else if (!summary.everObserved) {
      // No complete read ever returned a value: the column is unknown, not zero.
      checks.push({ check: `trigger:${summary.column}`, met: false, reason: 'observation_incomplete' })
      unfinished.push(`trigger:${summary.column}`)
    }
    else {
      checks.push({ check: `trigger:${summary.column}`, met: false, reason: 'signal_zero' })
    }
  }

  const pistonEvents = window.batches.flatMap(batch => batch.pistonEvents.map(event => ({ event, batch })))
  for (const piston of expectation.pistons) {
    const extendsObserved = pistonEvents.some(entry => entry.event.piston === piston && entry.event.action === 'extend' && entry.event.completeness === 'complete')
    const pistonCovered = window.batches.some(batch => batch.completeness === 'complete' && batch.fromTick <= expectation.toTick && batch.toTick >= expectation.fromTick)
    if (extendsObserved) {
      checks.push({ check: `piston:${piston}`, met: true })
    }
    else if (!pistonCovered) {
      checks.push({ check: `piston:${piston}`, met: false, reason: 'observation_incomplete' })
      unfinished.push(`piston:${piston}`)
    }
    else {
      checks.push({ check: `piston:${piston}`, met: false, reason: 'no_extend_observed' })
    }
  }

  const chestDelta = window.batches.reduce((total, batch) => {
    if (batch.completeness !== 'complete')
      return total
    return total + batch.chestDeltas.reduce((sum, delta) => sum + Math.max(0, delta.after - delta.before), 0)
  }, 0)
  const chestObserved = window.batches.some(batch => batch.completeness === 'complete'
    && batch.fromTick <= expectation.toTick && batch.toTick >= expectation.fromTick)
  if (chestDelta >= expectation.minChestDelta) {
    checks.push({ check: 'chest:gain', met: true })
  }
  else if (!chestObserved) {
    // No complete batch covered the run: the chest was never actually read.
    checks.push({ check: 'chest:gain', met: false, reason: 'observation_incomplete' })
    unfinished.push('chest:gain')
  }
  else {
    checks.push({ check: 'chest:gain', met: false, reason: 'chest_did_not_gain' })
  }

  for (const root of expectation.roots ?? []) {
    const observation = rootObservations.find(entry => entry.position.x === root.x && entry.position.y === root.y && entry.position.z === root.z)
    if (!observation) {
      checks.push({ check: `root:${root.x},${root.y},${root.z}`, met: false, reason: 'observation_incomplete' })
      unfinished.push(`root:${root.x},${root.y},${root.z}`)
      continue
    }
    const kept = observation.blockId === observation.expectedBlockId
    checks.push({ check: `root:${root.x},${root.y},${root.z}`, met: kept, ...(kept ? {} : { reason: 'root_removed' }) })
  }

  return {
    met: checks.every(check => check.met) && unfinished.length === 0,
    checks,
    unfinished,
    chestDelta,
  }
}
