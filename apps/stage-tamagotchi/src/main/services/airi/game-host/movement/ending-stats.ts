/**
 * Ending-phase accounting for an e02 arm (ab-23 repair plan, batch A4/A5).
 *
 * A route failure does not end observation: the client may keep flying under
 * its recovery owner, and the arm must be recorded until a stable end or a
 * bounded timeout. This module derives the ending facts from the recorded
 * samples only, so the same rules run in the fixture and in tests.
 *
 * Damage is measured as cumulative drops, not end-minus-start: natural
 * regeneration was hiding a 6.64 drop behind a 3.64 net loss (ab-23 full arm:
 * 20 -> 13.36 at t26086, then healed to 16.36).
 */

/** One recorded sample; missing values stay missing, never defaulted to 0. */
export interface EndingSample {
  tick: number
  health?: number
  onGround?: boolean
  inWater?: boolean
  gliding?: boolean
  vx?: number
  vy?: number
  vz?: number
}

export interface DamageEvent {
  tick: number
  from: number
  to: number
}

export interface TickRange {
  from: number
  to: number
}

export interface EndingStats {
  firstTick?: number
  lastTick?: number
  sampleCount: number
  /** Samples whose native tick was already seen (the ring can be re-read). */
  duplicateTicks: number
  /** Native-tick gaps inside the observed ending, computed on unique ticks. */
  missingTickRanges: TickRange[]
  endingMinHealth?: number
  endingHealthDropFromStart?: number
  endingObservedDamage: number
  firstDamageTick?: number
  damageEvents: DamageEvent[]
  /** Consecutive native ticks at the end that satisfy the stable-end rules. */
  stableTicks: number
  stableSettled: boolean
  settledGround: boolean
  settledWater: boolean
  unresolvedAirborne: boolean
  /**
   * Every sample has health, speeds and medium flags, ticks are consecutive
   * and unique. A damage-free verdict needs this.
   */
  fullyObserved: boolean
  /**
   * The only allowed "no damage" pass: fully observed, stably settled and no
   * visible drop. Touching down after damage is NOT damage-free.
   */
  damageFreeObserved: boolean
}

/**
 * Touch-down classification thresholds, reused from the host's touchdown
 * helper (horizontal 0.5, vertical 0.5 blocks/tick).
 */
export const SETTLE_SPEED = 0.5
/** Consecutive native ticks required for a stable end. */
export const SETTLE_TICKS = 20

function motionKnown(sample: EndingSample): boolean {
  return typeof sample.vx === 'number' && typeof sample.vy === 'number' && typeof sample.vz === 'number'
}

function stableTick(sample: EndingSample): boolean {
  if (!motionKnown(sample))
    return false
  const horizontal = Math.hypot(sample.vx!, sample.vz!)
  const vertical = Math.abs(sample.vy!)
  if (horizontal > SETTLE_SPEED || vertical > SETTLE_SPEED)
    return false
  if (sample.onGround === true)
    return true
  return sample.inWater === true
}

/**
 * Derives the ending facts from `samples` (route-failure tick onward).
 *
 * Samples are ordered by the caller; duplicate ticks are dropped (first wins)
 * and counted. A tick gap breaks the stable run and is reported; fields that
 * are missing are treated as unknown, not as zero.
 */
export function endingStatsOf(samples: EndingSample[]): EndingStats {
  const unique = new Map<number, EndingSample>()
  let duplicateTicks = 0
  for (const sample of samples) {
    if (unique.has(sample.tick)) {
      duplicateTicks += 1
      continue
    }
    unique.set(sample.tick, sample)
  }
  const ordered = [...unique.values()].sort((a, b) => a.tick - b.tick)
  const ticks = ordered.map(sample => sample.tick)
  const missingTickRanges: TickRange[] = []
  for (let index = 1; index < ticks.length; index++) {
    if (ticks[index]! !== ticks[index - 1]! + 1)
      missingTickRanges.push({ from: ticks[index - 1]! + 1, to: ticks[index]! - 1 })
  }

  let endingMinHealth: number | undefined
  let endingHealthDropFromStart: number | undefined
  let firstDamageTick: number | undefined
  let endingObservedDamage = 0
  const damageEvents: DamageEvent[] = []
  let previousHealth: number | undefined
  for (const sample of ordered) {
    if (typeof sample.health !== 'number')
      continue
    if (endingMinHealth === undefined || sample.health < endingMinHealth)
      endingMinHealth = sample.health
    if (previousHealth !== undefined && sample.health < previousHealth - 0.0001) {
      endingObservedDamage += previousHealth - sample.health
      damageEvents.push({ tick: sample.tick, from: previousHealth, to: sample.health })
      if (firstDamageTick === undefined)
        firstDamageTick = sample.tick
    }
    previousHealth = sample.health
  }
  const startHealth = ordered.find(sample => typeof sample.health === 'number')?.health
  if (startHealth !== undefined && endingMinHealth !== undefined)
    endingHealthDropFromStart = Math.max(0, startHealth - endingMinHealth)

  let stableTicks = 0
  for (let index = ordered.length - 1; index >= 0; index--) {
    const sample = ordered[index]!
    if (index < ordered.length - 1 && sample.tick !== ordered[index + 1]!.tick - 1)
      break
    if (!stableTick(sample))
      break
    stableTicks += 1
  }
  const last = ordered.at(-1)
  const stableSettled = stableTicks >= SETTLE_TICKS
  const settledGround = stableSettled && last?.onGround === true
  const settledWater = stableSettled && last?.inWater === true && last?.onGround !== true
  const unresolvedAirborne = !stableSettled && (last?.onGround !== true && last?.inWater !== true)

  const fullyObserved = ordered.length > 0
    && duplicateTicks === 0
    && missingTickRanges.length === 0
    && ordered.every(sample => typeof sample.health === 'number' && motionKnown(sample)
      && typeof sample.onGround === 'boolean' && typeof sample.inWater === 'boolean')
  const damageFreeObserved = fullyObserved && stableSettled && damageEvents.length === 0

  return {
    ...(ordered.length > 0 ? { firstTick: ordered[0]!.tick, lastTick: last!.tick } : {}),
    sampleCount: ordered.length,
    duplicateTicks,
    missingTickRanges,
    ...(endingMinHealth !== undefined ? { endingMinHealth } : {}),
    ...(endingHealthDropFromStart !== undefined ? { endingHealthDropFromStart } : {}),
    endingObservedDamage,
    ...(firstDamageTick !== undefined ? { firstDamageTick } : {}),
    damageEvents,
    stableTicks,
    stableSettled,
    settledGround,
    settledWater,
    unresolvedAirborne,
    fullyObserved,
    damageFreeObserved,
  }
}
