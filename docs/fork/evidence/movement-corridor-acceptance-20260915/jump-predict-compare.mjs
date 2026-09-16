/**
 * Aligns the batch-4 takeoff prediction with the real per-tick trail.
 *
 * Reads the mod's last jump task status (jump-status.mjs), then prints the
 * prediction's landing tick and position next to the first real touchdown
 * after the takeoff, the rest positions, and the per-tick deltas of the two
 * trails while both are airborne.
 *
 * Usage: node jump-predict-compare.mjs [statusJsonPath]
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'jump-status.json'
const status = JSON.parse(readFileSync(path, 'utf8'))
const prediction = status.predictionNow
const trail = status.realTrail ?? []
const base = status.realTrailBase ?? 0

if (!prediction) {
  console.log('no prediction recorded (the task never reached a takeoff decision)')
  process.exit(1)
}

// The real takeoff is the first tick where the bot is airborne after a grounded
// entry; the real touchdown is the first grounded tick after that.
let takeoffIndex = -1
for (let index = 1; index < trail.length; index++) {
  if (!trail[index].onGround && trail[index - 1].onGround) {
    takeoffIndex = index
    break
  }
}
let touchIndex = -1
if (takeoffIndex >= 0) {
  for (let index = takeoffIndex + 1; index < trail.length; index++) {
    if (trail[index].onGround) {
      touchIndex = index
      break
    }
  }
}

const predictedTrail = prediction.trail ?? []
console.log(`prediction: landTick=${prediction.landTick} land=(${prediction.landX?.toFixed(3)},${prediction.landY?.toFixed(3)},${prediction.landZ?.toFixed(3)}) rest=(${prediction.restX?.toFixed(3)},${prediction.restZ?.toFixed(3)}) support=${prediction.staysOnSupport}`)
if (touchIndex >= 0) {
  const real = trail[touchIndex]
  const predictedLand = predictedTrail[prediction.landTick - 1] ?? {}
  console.log(`real:       touchdown at trail index ${touchIndex} (task tick ${real.tick}, base ${base}) pos=(${real.x.toFixed(3)},${real.y.toFixed(3)},${real.z.toFixed(3)})`)
  console.log(`delta:      dx=${(real.x - (prediction.landX ?? 0)).toFixed(3)} dy=${(real.y - (prediction.landY ?? 0)).toFixed(3)} dz=${(real.z - (prediction.landZ ?? 0)).toFixed(3)} tick: predicted ${prediction.landTick} vs real ${real.tick - base}`)
  if (predictedLand.y !== undefined)
    console.log(`predicted landing sample: (${predictedLand.x.toFixed(3)},${predictedLand.y.toFixed(3)},${predictedLand.z.toFixed(3)})`)
}
else {
  console.log('no real touchdown in the recorded trail')
}

// Per-tick airborne deltas: the prediction's first airborne sample vs the real
// trail's first airborne sample (takeoffIndex), then step by step. Ticks the
// prediction spends on the ground before that are its pre-takeoff phase.
console.log('airborne per-tick deltas (prediction tick vs real tick):')
let predictedAir = 0
while (predictedAir < predictedTrail.length && predictedTrail[predictedAir].onGround !== false)
  predictedAir++
for (let step = 1; step <= 8; step++) {
  const predicted = predictedTrail[predictedAir + step - 1]
  const real = takeoffIndex >= 0 ? trail[takeoffIndex + step - 1] : undefined
  if (!predicted || !real)
    break
  console.log(`  +${step}: pred=(${predicted.x.toFixed(3)},${predicted.y.toFixed(3)},${predicted.z.toFixed(3)}) real=(${real.x.toFixed(3)},${real.y.toFixed(3)},${real.z.toFixed(3)}) dx=${(real.x - predicted.x).toFixed(3)} dy=${(real.y - predicted.y).toFixed(3)} dz=${(real.z - predicted.z).toFixed(3)}`)
}
