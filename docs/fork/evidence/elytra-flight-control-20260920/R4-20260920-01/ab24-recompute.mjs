import process from 'node:process'

import { readFileSync, writeFileSync } from 'node:fs'

// Recomputes the D3 gates for one e02 run from its raw JSONL with the
// corrected definitions (ab-24 audit section 6). The original log and the
// original report are kept; this is the corrected accounting only.
//
// Usage: node ab24-recompute.mjs <run.jsonl> <outPath>
const [runPath, outPath] = process.argv.slice(2)
const record = JSON.parse(readFileSync(runPath, 'utf8').trim())
const BUDGET_MS = 150_000
const lines = []

function gate(label, value) {
  return `${label}=${value === undefined ? 'unknown' : value}`
}

for (const arm of record.arms ?? []) {
  const samples = arm.samples ?? []
  const crossZ = 20
  // 1. Geometric forward crossings, classified by the owner at the event.
  let routeCrossing
  let recoveryCrossing
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1]
    const current = samples[index]
    const crossed = Number(previous.z) > crossZ && Number(current.z) <= crossZ
    if (!crossed)
      continue
    const event = { tick: current.tick, owner: current.inputOwner, x: current.x, y: current.y, z: current.z, gliding: current.gliding, inWater: current.inWater }
    // Interpolated x at the line for the river-band check.
    const t = (Number(previous.z) - crossZ) / (Number(previous.z) - Number(current.z))
    event.xAtLine = Number(previous.x) + (Number(current.x) - Number(previous.x)) * t
    if (current.inputOwner === 'flight-recovery' && !recoveryCrossing)
      recoveryCrossing = event
    else if (!routeCrossing)
      routeCrossing = event
  }
  const driven = samples.filter(sample => sample.inputOwner === 'flight-session')
  const budgetExhaustedTicks = driven.filter(sample => sample.budgetExhausted === true).length
  const feasibleTicks = driven.filter(sample => Number(sample.feasible) >= 1).length
  const uncontrolledAirborneTicks = samples.filter(sample =>
    sample.controlPhase === 'RECOVER' && sample.inputOwner === 'none'
    && sample.onGround !== true && sample.inWater !== true && sample.gliding !== true).length
  // The ending starts at the first FAILED transition, one sample earlier to
  // include the transition tick's damage (audit 6.5).
  const firstFailedIndex = samples.findIndex(sample => sample.routeOutcome === 'FAILED')
  const endingStart = firstFailedIndex > 0 ? firstFailedIndex - 1 : 0
  const ending = samples.slice(endingStart)
  let damage = 0
  let firstDamageTick
  let previousHealth
  let minHealth
  for (const sample of ending) {
    const health = typeof sample.health === 'number' ? sample.health : undefined
    if (health === undefined)
      continue
    if (minHealth === undefined || health < minHealth)
      minHealth = health
    if (previousHealth !== undefined && health < previousHealth - 0.0001) {
      damage += previousHealth - health
      if (firstDamageTick === undefined)
        firstDamageTick = sample.tick
    }
    previousHealth = health
  }
  const ticks = ending.map(sample => sample.tick)
  const gaps = ticks.slice(1).filter((tick, index) => tick !== ticks[index] + 1).length
  const fieldsComplete = ending.every(sample => typeof sample.health === 'number'
    && typeof sample.vx === 'number' && typeof sample.vy === 'number' && typeof sample.vz === 'number'
    && typeof sample.onGround === 'boolean' && typeof sample.inWater === 'boolean')
  const fullyObserved = gaps === 0 && fieldsComplete
  // Stable end: the last run of limited-speed ground/water samples.
  let stableTicks = 0
  for (let index = ending.length - 1; index >= 0; index--) {
    const sample = ending[index]
    if (index < ending.length - 1 && sample.tick !== ending[index + 1].tick - 1)
      break
    const horizontal = Math.hypot(Number(sample.vx), Number(sample.vz))
    const vertical = Math.abs(Number(sample.vy))
    const settled = (sample.onGround === true || sample.inWater === true)
      && horizontal <= 0.5 && vertical <= 0.5
    if (!settled)
      break
    stableTicks += 1
  }
  const lastSample = samples.at(-1)
  const firstDriven = driven[0]
  const hardDeadlineEstimate = firstDriven?.wallMs !== undefined ? firstDriven.wallMs + BUDGET_MS : undefined
  const settledAtWallMs = lastSample?.wallMs
  const minFlightHealth = samples.reduce((min, sample) => {
    const health = typeof sample.health === 'number' ? sample.health : undefined
    if (health === undefined)
      return min
    return min === undefined ? health : Math.min(min, health)
  }, undefined)

  lines.push(`## arm=${arm.arm}`)
  lines.push(gate('controlledRouteCrossing', routeCrossing?.owner === 'flight-session' && routeCrossing.gliding === true && routeCrossing.inWater !== true))
  lines.push(gate('riverBandCrossing', routeCrossing !== undefined && routeCrossing.xAtLine >= -1006 && routeCrossing.xAtLine <= -994))
  lines.push(`routeCrossing=${routeCrossing ? `tick ${routeCrossing.tick} owner=${routeCrossing.owner} xAtLine=${routeCrossing.xAtLine.toFixed(2)}` : 'none'}`)
  lines.push(`recoveryCrossing=${recoveryCrossing ? `tick ${recoveryCrossing.tick} owner=${recoveryCrossing.owner}` : 'none'}`)
  lines.push(gate('searchCompleted', driven.length > 0 && budgetExhaustedTicks === 0))
  lines.push(gate('chosenTrajectoryVerified', driven.length > 0 && feasibleTicks === driven.length))
  lines.push('recoveryTrajectoryVerified=unknown (field added after ab-24)')
  lines.push(`budgetExhaustedTicks=${budgetExhaustedTicks}`)
  lines.push(gate('settledBeforeDeadline', stableTicks >= 20 && settledAtWallMs !== undefined && hardDeadlineEstimate !== undefined && settledAtWallMs <= hardDeadlineEstimate))
  lines.push(`stableTicks=${stableTicks} settledAtWallMs=${settledAtWallMs} hardDeadlineEstimate=${hardDeadlineEstimate}`)
  lines.push(gate('flightDamageFree', minFlightHealth !== undefined ? minFlightHealth >= 19.9999 : undefined))
  lines.push(gate('endingDamageFree', fullyObserved && damage === 0))
  lines.push(`endingObservedDamage=${damage.toFixed(5)} firstDamageTick=${firstDamageTick} fullyObserved=${fullyObserved} gaps=${gaps}`)
  lines.push(gate('noUncontrolledAirborne', uncontrolledAirborneTicks === 0))
  lines.push(`uncontrolledAirborneTicks=${uncontrolledAirborneTicks}`)
  lines.push('')
}
writeFileSync(outPath, lines.join('\n'))
console.info(lines.join('\n'))
