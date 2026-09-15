/**
 * Signal diagnosis: trigger, transmission, execution, collection (RS-3 §4).
 *
 * Diagnosis walks the four stages and reports what the window showed, what it
 * did not show, and which candidate mechanisms could explain an abnormal stage.
 * It compares normal and abnormal columns, then proposes local observations or
 * small bounded operations that would tell the candidates apart.
 *
 * The report never contains the fixture's fault label or a repair answer: the
 * candidate ids are generic mechanisms (attenuation, gap, output), and the
 * discriminators are observations, not a prescribed fix.
 */
import type { ObservationWindow } from './observation'

import { summarizeColumns } from './observation'

export type DiagnosisStage = 'trigger' | 'transmission' | 'execution' | 'collection'

/** One stage's verdict. `unknown` means no complete read covered it. */
export interface StageFinding {
  stage: DiagnosisStage
  status: 'ok' | 'abnormal' | 'unknown'
  evidence: string[]
}

/** A mechanism that could explain an abnormal stage. */
export interface CandidateCause {
  id: string
  stage: DiagnosisStage
  description: string
  /** An observation or bounded operation that distinguishes this candidate. */
  discriminator: string
}

/** A next step that gathers real state instead of asserting a cause. */
export interface NextProbe {
  kind: 'local-observation' | 'bounded-operation'
  description: string
}

export interface DiagnosisReport {
  stages: StageFinding[]
  candidates: CandidateCause[]
  nextProbes: NextProbe[]
  /** True when a stage had no complete read; the run is not called normal. */
  inconclusive: boolean
}

export interface DiagnosisSpec {
  triggerColumns: string[]
  /** Line columns ordered from the trigger to the far end. */
  lineColumns: string[]
  pistons: string[]
  fromTick: number
  toTick: number
}

function stageStatusFromSummaries(summaries: ReturnType<typeof summarizeColumns>): StageFinding['status'] {
  if (summaries.some(summary => summary.everPowered))
    return 'ok'
  if (summaries.some(summary => summary.unobservedTicks > 0))
    return 'unknown'
  return 'abnormal'
}

/**
 * Compares each column to the first column observed powered.
 *
 * A column that never powers after a powered one is a divergence. Columns whose
 * reads are incomplete are reported as unknown rather than divergent.
 */
export function compareColumnsToReference(
  window: ObservationWindow,
  columns: readonly string[],
  fromTick: number,
  toTick: number,
): Array<{ column: string, reference: string, status: 'powered' | 'unpowered' | 'unknown' }> {
  const summaries = summarizeColumns(window, columns, fromTick, toTick)
  const reference = summaries.find(summary => summary.everPowered)?.column ?? columns[0] ?? ''
  return summaries.map((summary) => {
    const status = summary.everPowered
      ? 'powered' as const
      : summary.everObserved
        ? 'unpowered' as const
        : 'unknown' as const
    return { column: summary.column, reference, status }
  })
}

/**
 * Diagnoses a run from its observation window.
 *
 * @example
 * diagnose(window, { triggerColumns: ['left-observer'], lineColumns: ['line-0', 'line-1'], pistons: ['p1'], fromTick: 0, toTick: 100 })
 * // => { stages: [...], candidates: [{ id: 'signal_attenuation', ... }], nextProbes: [...] }
 */
export function diagnose(window: ObservationWindow, spec: DiagnosisSpec): DiagnosisReport {
  const candidates: CandidateCause[] = []
  const stages: StageFinding[] = []
  let inconclusive = false

  const triggerSummaries = summarizeColumns(window, spec.triggerColumns, spec.fromTick, spec.toTick)
  const triggerStatus = stageStatusFromSummaries(triggerSummaries)
  if (triggerStatus === 'unknown')
    inconclusive = true
  stages.push({
    stage: 'trigger',
    status: triggerStatus,
    evidence: triggerSummaries.map(summary => `${summary.column}: ${summary.poweredTicks} powered, ${summary.unobservedTicks} unobserved`),
  })

  const lineSummaries = summarizeColumns(window, spec.lineColumns, spec.fromTick, spec.toTick)
  const divergence = compareColumnsToReference(window, spec.lineColumns, spec.fromTick, spec.toTick).find(entry => entry.status === 'unpowered')
  let transmissionStatus: StageFinding['status']
  if (triggerStatus === 'abnormal') {
    transmissionStatus = 'unknown'
  }
  else if (lineSummaries.length === 0) {
    transmissionStatus = 'ok'
  }
  else if (divergence) {
    transmissionStatus = 'abnormal'
  }
  else if (lineSummaries.some(summary => !summary.everObserved)) {
    transmissionStatus = 'unknown'
    inconclusive = true
  }
  else {
    transmissionStatus = 'ok'
  }
  stages.push({
    stage: 'transmission',
    status: transmissionStatus,
    evidence: divergence ? [`${divergence.column} never powered after ${divergence.reference}`] : ['all line columns behaved alike'],
  })
  if (transmissionStatus === 'abnormal') {
    candidates.push(
      { id: 'signal_attenuation', stage: 'transmission', description: 'the line loses power before its far end', discriminator: 'read the line columns next to the unpowered one' },
      { id: 'power_source_gap', stage: 'transmission', description: 'a wire or component is missing or not connected', discriminator: 'inspect the block between the last powered and first unpowered column' },
      { id: 'wrong_power_source', stage: 'transmission', description: 'the line is fed from a source that cannot sustain it', discriminator: 'count the sources feeding the line and their output' },
    )
  }

  const pistonEvents = window.batches.flatMap(batch => batch.pistonEvents)
  const pistonCovered = window.batches.some(batch => batch.completeness === 'complete' && batch.fromTick <= spec.toTick && batch.toTick >= spec.fromTick)
  const pistonExtended = (piston: string) => pistonEvents.some(event => event.piston === piston && event.action === 'extend' && event.completeness === 'complete')
  const missingPistons = spec.pistons.filter(piston => !pistonExtended(piston))
  let executionStatus: StageFinding['status']
  if (missingPistons.length === 0) {
    executionStatus = 'ok'
  }
  else if (!pistonCovered) {
    executionStatus = 'unknown'
    inconclusive = true
  }
  else {
    executionStatus = 'abnormal'
  }
  stages.push({
    stage: 'execution',
    status: executionStatus,
    evidence: missingPistons.length === 0 ? ['all pistons extended'] : [`no extend observed: ${missingPistons.join(', ')}`],
  })
  if (executionStatus === 'abnormal' && missingPistons.length > 0) {
    candidates.push(
      { id: 'piston_unpowered', stage: 'execution', description: 'the piston never received a signal', discriminator: 'read the piston and the block feeding it' },
      { id: 'piston_facing_wrong', stage: 'execution', description: 'the piston is wired but points the wrong way', discriminator: 'observe the piston facing and its extension direction' },
    )
  }

  const chestGain = window.batches.reduce((total, batch) => {
    if (batch.completeness !== 'complete')
      return total
    return total + batch.chestDeltas.reduce((sum, delta) => sum + Math.max(0, delta.after - delta.before), 0)
  }, 0)
  const chestIncomplete = window.batches.some(batch => batch.completeness !== 'complete')
  let collectionStatus: StageFinding['status']
  if (chestGain > 0) {
    collectionStatus = 'ok'
  }
  else if (chestIncomplete) {
    collectionStatus = 'unknown'
    inconclusive = true
  }
  else {
    collectionStatus = 'abnormal'
  }
  stages.push({
    stage: 'collection',
    status: collectionStatus,
    evidence: [`chest delta ${chestGain} over complete batches`],
  })
  if (collectionStatus === 'abnormal') {
    candidates.push(
      { id: 'drop_transport', stage: 'collection', description: 'drops never reached the hopper', discriminator: 'read drop positions along the water path' },
      { id: 'hopper_output', stage: 'collection', description: 'the hopper does not feed the chest', discriminator: 'observe the hopper facing and its enabled state' },
      { id: 'chest_full', stage: 'collection', description: 'the chest has no room for the drop', discriminator: 'read the chest slot counts' },
    )
  }

  const nextProbes: NextProbe[] = candidates.map(candidate => ({
    kind: candidate.id === 'signal_attenuation' || candidate.id === 'power_source_gap' || candidate.id === 'wrong_power_source' ? 'local-observation' : 'bounded-operation',
    description: candidate.discriminator,
  }))

  return { stages, candidates, nextProbes, inconclusive }
}
