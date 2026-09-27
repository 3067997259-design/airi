import { readFileSync } from 'node:fs'

// Summarizes one e02 route-ab JSONL record (the file the fixture appends).
// Usage: node analyze-run.mjs <path-to.jsonl> [arm]
const [path, armFilter] = process.argv.slice(2)
const records = readFileSync(path, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line))
for (const record of records) {
  for (const arm of record.arms ?? []) {
    if (armFilter && arm.arm !== armFilter)
      continue
    const samples = arm.samples ?? []
    const owners = {}
    for (const sample of samples)
      owners[sample.inputOwner] = (owners[sample.inputOwner] ?? 0) + 1
    const driven = samples.filter(sample => sample.inputOwner === 'flight-session')
    const recovery = samples.filter(sample => sample.inputOwner === 'flight-recovery')
    const fired = samples.filter(sample => sample.rocketFiredThisTick === true).length
    const stacked = samples.filter(sample => Number(sample.boostCount) > 1).length
    const last = driven.at(-1)
    console.info(`=== arm=${arm.arm} submissions=${arm.submissions} crossed=${arm.crossed} end=${arm.lastEndReason} ending=${arm.ending}`)
    console.info(`    damageDuringEnding=${arm.damageDuringEnding} residualSpeed=${arm.residualSpeed} endHealth=${arm.endHealth} finalHealth=${arm.finalHealth}`)
    console.info(`    samples=${samples.length} owners=${JSON.stringify(owners)} fired=${fired} stackedTicks=${stacked}`)
    if (arm.crossing)
      console.info(`    crossing tick=${arm.crossing.tick} pos=${[arm.crossing.position.x, arm.crossing.position.y, arm.crossing.position.z].map(v => Math.round(v * 10) / 10).join(',')} speed=${(arm.crossing.horizontalSpeed ?? 0).toFixed(2)} controlled=${arm.crossing.controlled} revision=${arm.crossing.revision}`)
    else
      console.info('    crossing=none')
    if (last) {
      const target = [last.targetX, last.targetY, last.targetZ].map(v => Math.round(Number(v) * 10) / 10).join(',')
      console.info(`    lastDriven tick=${last.tick} cursor=${last.cursor} target=${target} predictedEnd=${last.predictedEndTicks}(${last.predictedEndReason}) terminalAction=${last.terminalAction}`)
      console.info(`    lastReject ${last.rejectKind}@t${last.rejectTick} block=${last.rejectBlock} shape=${last.rejectShape} counts[c/f/s/ta]=${last.rejectCollisions}/${last.rejectFloor}/${last.rejectSpeed}/${last.rejectTerminal}`)
      console.info(`    preview=${last.preview}`)
    }
    // A blocked tick is the one that explains an early end: print the two
    // ticks before the last driven one with their rejection counts.
    for (const sample of driven.slice(-3, -1)) {
      console.info(`    prior tick=${sample.tick} pos=${[sample.x, sample.y, sample.z].map(v => Math.round(v * 10) / 10).join(',')} pitch=${Math.round(sample.pitch * 10) / 10} reject=${sample.rejectKind}@t${sample.rejectTick} counts=${sample.rejectCollisions}/${sample.rejectFloor}/${sample.rejectSpeed}/${sample.rejectTerminal}`)
    }
    for (const line of (arm.trail ?? []).filter(t => String(t).includes('ended') || String(t).includes('crossed')))
      console.info(`    trail: ${line}`)
  }
}
