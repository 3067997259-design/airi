/**
 * E-01 residual computation (elytra-navigation design §9, checklist B1 E-01).
 *
 * Replays a recorded unobstructed glide through {@link simulateFlight} with the
 * recorded constant inputs and reports the predicted-vs-actual position error
 * at the audit tick marks (10/20/40). The recorded samples are wall-clock MCP
 * reads, so each tick mark maps to the nearest recorded sample by elapsed
 * time; the mapping error travels in the result as `sampleJitterMs`.
 */
import type { FlightProfile } from './profile'

import { simulateFlight } from './simulation'

/** One wall-clock record from a live glide capture. */
export interface GlideRecordingSample {
  /** Wall-clock ms (capture-clock, only differences are meaningful). */
  at: number
  position: { x: number, y: number, z: number }
  motion: { x: number, y: number, z: number }
  yaw: number
  pitch: number
}

/** The constant inputs an unobstructed calibration glide flew with. */
export interface GlideInputs {
  yaw: number
  pitch: number
  /** Rockets fired during the capture; a calibration glide uses none. */
  rockets?: number
}

export interface ResidualPoint {
  tick: number
  predicted: { x: number, y: number, z: number }
  actual: { x: number, y: number, z: number }
  /** Euclidean position error in blocks. */
  errorBlocks: number
  /** Distance between the tick mark and the recorded sample actually used, in ms. */
  sampleJitterMs: number
}

export interface ResidualReport {
  points: ResidualPoint[]
  /** Miss when the recording is too short for a mark or the glide ended early. */
  notes: string[]
}

const MS_PER_TICK = 50
/** Tick marks the E-01 audit reports (design §9). */
export const RESIDUAL_TICK_MARKS = [10, 20, 40] as const

/**
 * Collapses a live capture to one sample per game tick.
 *
 * The bridge answers repeated `get_self` calls from the same client tick, so a
 * fast poll returns byte-identical runs: one capture held 1148 identical pairs
 * out of 1748 samples. Those repeats are not new information, and treating them
 * as distinct samples is what made a tick mark land several ticks away from the
 * tick it named — the pitch -3 run 3 audit reported 0.76 blocks of error at tick
 * 20 purely because the mapping picked a sample 5 ticks off (a jitter sweep
 * printed 3.94 blocks at 256 ms of offset and exactly 0 at 4 ms).
 *
 * Removing the repeats turns the recording into the tick series the model is
 * actually comparable against, with no clock conversion at all.
 *
 * @example
 * dedupeGlideRecording([{ at: 0, position: P, motion: V, yaw: 0, pitch: 0 }, { at: 10, position: P, motion: V, yaw: 0, pitch: 0 }])
 * // => [{ at: 0, position: P, motion: V, yaw: 0, pitch: 0 }]
 */
export function dedupeGlideRecording(recording: GlideRecordingSample[]): GlideRecordingSample[] {
  const distinct: GlideRecordingSample[] = []
  for (const sample of recording) {
    const previous = distinct[distinct.length - 1]
    const sameState = previous
      && previous.position.x === sample.position.x
      && previous.position.y === sample.position.y
      && previous.position.z === sample.position.z
      && previous.motion.x === sample.motion.x
      && previous.motion.y === sample.motion.y
      && previous.motion.z === sample.motion.z
    if (!sameState)
      distinct.push(sample)
  }
  return distinct
}

/**
 * Drops the launch transient so the audit starts from a settled glide.
 *
 * The recording starts at the elytra deploy, while the bot still carries the
 * sprint jump's velocity: a live capture's first sample read `motion.y = -0.59`
 * where a settled glide is about `-0.13`. The model assumes the input has been
 * constant, so starting inside that transient charges the residual for a state
 * the model was never given. `tick` is how many settled ticks to discard.
 *
 * @example
 * startGlideAudit(recording, 20).length
 * // => recording.length - 20
 */
export function startGlideAudit(recording: GlideRecordingSample[], tick: number): GlideRecordingSample[] {
  if (tick <= 0)
    return recording
  return recording.slice(Math.min(tick, Math.max(0, recording.length - 1)))
}

/** One planned input for one tick of an audited window. */
export interface ScheduledWindowInput {
  yaw: number
  pitch: number
  /** A firework is spent at the start of this tick. */
  useRocket?: boolean
}

/**
 * Audits an already-deduped tick window against a scheduled input series.
 *
 * This is the shared core of every E-01 window: the steady glide, the steady
 * yaw rate turn and the rocket boost differ only in the schedule and in where
 * the window starts. The caller dedupes
 * ({@link dedupeGlideRecording}) and, for a manoeuvre, offsets the window so
 * index 0 is the tick the schedule describes.
 *
 * @example
 * auditGlideWindow(profile, ticks, tick => ({ yaw: 90, pitch: -3 })).points[0]?.tick
 * // => 10
 */
export function auditGlideWindow(
  profile: FlightProfile,
  ticks: GlideRecordingSample[],
  inputForTick: (tick: number) => ScheduledWindowInput,
  options: { tickMarks?: readonly number[] } = {},
): ResidualReport {
  const notes: string[] = []
  const tickMarks = options.tickMarks ?? RESIDUAL_TICK_MARKS
  if (ticks.length < 2)
    return { points: [], notes: ['window needs at least two distinct ticks'] }

  const first = ticks[0]!
  const maxTick = Math.max(...tickMarks)
  const schedule = Array.from({ length: maxTick }, (_, index) => {
    const input = inputForTick(index + 1)
    return {
      yaw: input.yaw,
      pitch: input.pitch,
      useRocket: input.useRocket === true,
      // A tick that fires needs a rocket available for the step to apply it.
      rocketAvailable: input.useRocket === true,
    }
  })
  const trajectory = simulateFlight(profile, {
    position: { ...first.position },
    velocity: { ...first.motion },
    yaw: schedule[0]?.yaw ?? 0,
    pitch: schedule[0]?.pitch ?? 0,
    rocketTicksRemaining: 0,
    onGround: false,
    inWater: false,
  }, schedule)
  if (trajectory.endReason === 'blocked' || trajectory.endReason === 'below-world' || trajectory.endReason === 'landed')
    notes.push(`simulation ended early: ${trajectory.endReason}`)

  const points: ResidualPoint[] = []
  for (const tick of tickMarks) {
    const predicted = trajectory.samples[tick - 1]?.position
    if (!predicted) {
      notes.push(`simulation has no sample for tick ${tick}`)
      continue
    }
    const best = ticks[tick]
    if (!best) {
      notes.push(`window covers only ${ticks.length - 1} distinct ticks; tick ${tick} is not comparable`)
      continue
    }
    points.push({
      tick,
      predicted: { ...predicted },
      actual: { ...best.position },
      errorBlocks: Math.hypot(
        predicted.x - best.position.x,
        predicted.y - best.position.y,
        predicted.z - best.position.z,
      ),
      sampleJitterMs: Math.abs(best.at - (first.at + tick * MS_PER_TICK)),
    })
  }
  return { points, notes }
}

/**
 * Fits the steady yaw rate a turning capture actually flew.
 *
 * Least squares over the recorded yaw series, in degrees per tick. A live sweep
 * is applied from the main process on a wall-clock poll, so the commanded rate is
 * the plan and this fit is the fact; the audit uses the fit so it never credits
 * the model for a turn the bot did not fly.
 *
 * @example
 * fitYawRatePerTick([{ yaw: 90 }, { yaw: 92 }, { yaw: 94 }])
 * // => 2
 */
export function fitYawRatePerTick(samples: Array<{ yaw: number }>): number {
  const count = samples.length
  if (count < 2)
    return 0
  const meanIndex = (count - 1) / 2
  const meanYaw = samples.reduce((total, sample) => total + sample.yaw, 0) / count
  let covariance = 0
  let variance = 0
  for (let index = 0; index < count; index++) {
    const centered = index - meanIndex
    covariance += centered * (samples[index]!.yaw - meanYaw)
    variance += centered * centered
  }
  return variance === 0 ? 0 : covariance / variance
}

/**
 * Finds the tick where a rocket changed the velocity, from the recorded series.
 *
 * The capture commands the firing, but only the telemetry proves when it took
 * effect, so the boost audit aligns on this index instead of on the requested
 * tick. The detector reads the SPEED, not the vertical component: a rocket
 * accelerates along the look direction, so at the calibration heading (yaw 90,
 * pitch -3) the impulse is almost entirely horizontal. A vertical-only test
 * missed a live burn whose horizontal speed sat at 1.68 blocks/tick against a
 * 0.6 glide while `motion.y` stayed at +0.08.
 *
 * @example
 * findBoostTick([{ motion: { x: -0.6, y: -0.13, z: 0 } }, { motion: { x: -1.5, y: 0.08, z: 0 } }])
 * // => 1
 */
export function findBoostTick(
  samples: Array<{ motion: { x: number, y: number, z: number } }>,
  jumpThreshold = 0.3,
): number | undefined {
  const speed = (motion: { x: number, y: number, z: number }): number => Math.hypot(motion.x, motion.y, motion.z)
  for (let index = 1; index < samples.length; index++) {
    const before = speed(samples[index - 1]!.motion)
    const now = speed(samples[index]!.motion)
    if (now - before > jumpThreshold)
      return index
  }
  return undefined
}

/**
 * Computes the E-01 residuals for one recorded glide.
 *
 * The recording is collapsed to one sample per client tick first
 * ({@link dedupeGlideRecording}), so a tick mark selects the n-th distinct
 * sample rather than whichever read happened to land nearest a wall-clock
 * target. `sampleJitterMs` still reports how far that read sat from the nominal
 * 50 ms cadence, because the read time is the only wall-clock fact available.
 *
 * @example
 * computeGlideResiduals(profile, recording, { yaw: 0, pitch: -5 }).points[0]?.tick
 * // => 10
 */
export function computeGlideResiduals(
  profile: FlightProfile,
  recording: GlideRecordingSample[],
  inputs: GlideInputs,
  options: { tickMarks?: readonly number[] } = {},
): ResidualReport {
  const ticks = dedupeGlideRecording(recording)
  return auditGlideWindow(profile, ticks, () => ({ yaw: inputs.yaw, pitch: inputs.pitch }), options)
}
