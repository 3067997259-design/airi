import { readFileSync } from 'node:fs'

// Offline evidence extraction only. This script never connects to Minecraft.
const data = JSON.parse(readFileSync(new URL('../cave-ab-24.jsonl', import.meta.url), 'utf8').trim())
const keys = ['tick', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'health', 'inputOwner', 'controlPhase', 'cursor', 'evaluated', 'feasible', 'simMs', 'physicsSteps', 'blockQueries', 'rejectTerminal', 'terminalAction', 'predictedEndTicks', 'predictedEndCursor']
const pick = value => Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]))

for (const arm of data.arms) {
  const samples = arm.samples
  const driven = samples.filter(sample => sample.inputOwner === 'flight-session')
  const recover = samples.filter(sample => sample.inputOwner === 'flight-recovery')
  const crossings = samples.flatMap((sample, index) => {
    const before = samples[index - 1]
    return before && before.z > data.crossZ && sample.z <= data.crossZ
      ? [{ ...pick(sample), previousTick: before.tick, previousZ: before.z }]
      : []
  })
  const gaps = samples.flatMap((sample, index) => {
    const before = samples[index - 1]
    return before && sample.tick !== before.tick + 1
      ? [{ from: before.tick + 1, to: sample.tick - 1 }]
      : []
  })
  const sim = driven.map(sample => sample.simMs).sort((a, b) => a - b)
  const summary = {
    arm: arm.arm,
    sourceGates: arm.gates,
    drivenTicks: driven.length,
    recoveryTicks: recover.length,
    recoveryWithSimulation: recover.filter(sample => sample.physicsSteps > 0).length,
    drivenSimMs: { median: sim[Math.floor(sim.length * .5)], p95: sim[Math.floor(sim.length * .95)], max: sim.at(-1) },
    budgetExhaustions: samples.filter(sample => sample.budgetExhausted).map(pick),
    actualForwardCrossings: crossings,
    reportedRecoveryCrossing: arm.recoveryCrossing,
    reportedInRiverBand: arm.crossing?.inRiverBand,
    airborneNoOwnerTicks: samples.filter(sample => sample.inputOwner === 'none' && !sample.onGround && !sample.inWater).map(sample => sample.tick),
    damageSamples: samples.flatMap((sample, index) => index > 0 && sample.health < samples[index - 1].health - .0001 ? [pick(sample)] : []),
    damageAdjacent: samples.filter(sample => sample.tick >= 9999 && sample.tick <= 10003).map(pick),
    gaps,
    endingStats: arm.endingStats,
    endTrail: arm.trail.slice(-7),
  }
  console.log(JSON.stringify(summary))
}
