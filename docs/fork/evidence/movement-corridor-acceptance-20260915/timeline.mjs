import { readFileSync, writeFileSync } from 'node:fs'

const source = process.argv[2]
const target = process.argv[3] ?? `${source}.timeline.txt`
const record = JSON.parse(readFileSync(source, 'utf8').trim())
const lines = []
lines.push(`E-02 route A/B flight timeline`)
lines.push(`schema=${record.schema}  at=${record.at}  crossZ=${record.crossZ}  routePoints=${record.route.points}`)
lines.push(`route first=${JSON.stringify(record.route.first)} last=${JSON.stringify(record.route.last)}`)
lines.push('')
for (const arm of record.arms) {
  lines.push(`===== ARM ${arm.arm} =====`)
  lines.push(`startState=${JSON.stringify(arm.startState)} legs=${arm.legs} submissions=${arm.submissions}`)
  lines.push(`crossed=${arm.crossed} end=${arm.lastEndReason} ending=${arm.ending} final=${JSON.stringify(arm.finalState)}`)
  if (arm.crossing)
    lines.push(`crossing=${JSON.stringify(arm.crossing)}`)
  lines.push('')
  lines.push('--- host trail ---')
  for (const item of arm.trail)
    lines.push(`  ${item}`)
  lines.push('')
  lines.push('--- per-tick client samples (every tick) ---')
  lines.push('  ms      tick   x        y       z       yaw    pitch  spd    vy     boost fire water glide ground owner          rev hold hp  rockets H/I')
  const start = arm.samples[0]?.tick ?? 0
  let previousOwner
  for (const s of arm.samples) {
    const ms = typeof s.at === 'number' ? s.at : (s.tick - start) * 50
    const speed = Math.hypot(s.vx ?? 0, s.vz ?? 0)
    const ownerChanged = previousOwner !== undefined && previousOwner !== s.inputOwner
    previousOwner = s.inputOwner
    lines.push([
      `${String(ms).padStart(6)}`,
      `${String(s.tick).padStart(6)}`,
      `${(s.x ?? 0).toFixed(1).padStart(8)}`,
      `${(s.y ?? 0).toFixed(1).padStart(7)}`,
      `${(s.z ?? 0).toFixed(1).padStart(7)}`,
      `${Math.round(s.yaw ?? 0).toString().padStart(6)}`,
      `${Math.round(s.pitch ?? 0).toString().padStart(6)}`,
      `${speed.toFixed(2).padStart(5)}`,
      `${(s.vy ?? 0).toFixed(3).padStart(6)}`,
      `${(s.boostRemaining ?? 0).toString().padStart(5)}`,
      `${s.rocketFiredThisTick ? ' FIRE' : '    .'}`,
      `${s.inWater ? ' water' : '     .'}`,
      `${s.gliding ? ' glide' : '     .'}`,
      `${s.onGround ? ' ground' : '      .'}`,
      `${(s.inputOwner ?? 'none').padEnd(14)}`,
      `${String(s.revision ?? '-').padStart(3)}`,
      `${s.holding ? ' HOLD' : '    .'}`,
      `${String(s.health ?? '-').padStart(4)}`,
      `${s.rocketsInHands ?? '-'}/${s.rocketsInInventory ?? '-'}`,
      ownerChanged ? 'OWNER-CHANGE' : '',
    ].join(' '))
  }
  lines.push('')
}
writeFileSync(target, `${lines.join('\n')}\n`)
console.log(`written ${target} (${lines.length} lines)`)
