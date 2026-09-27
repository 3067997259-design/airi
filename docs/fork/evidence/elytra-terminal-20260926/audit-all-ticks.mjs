import process from 'node:process'

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Audit native trajectories against the captured world, independent of the
 * controller's chosen-action and success flags.
 * Call stack: audit-local -> native segments -> inflated voxel sweep -> report.
 * Unknown cells and every non-air block reject this conservative audit.
 */
const root = new URL('./', import.meta.url)
const worlds = ['../elytra-landing-20260926/', '../elytra-local-passages-20260926/'].map((path) => {
  const directory = new URL(path, root)
  return { ...JSON.parse(readFileSync(new URL('world.json', directory), 'utf8')), binary: readFileSync(new URL('world.bin', directory)) }
})
function blockAt(x, y, z) {
  for (const { box, palette, binary } of worlds) {
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1 || z < box.z0 || z > box.z1)
      continue
    const nx = box.x1 - box.x0 + 1
    const nz = box.z1 - box.z0 + 1
    return palette[binary.readUInt16LE(2 * ((x - box.x0) + nx * ((z - box.z0) + nz * (y - box.y0))))]
  }
  return 'unknown'
}
const results = []
for (const tag of process.argv.slice(2)) {
  const bytes = readFileSync(new URL(`${tag}.jsonl`, root))
  const records = bytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  const start = records.find(r => r.kind === 'start')
  const samples = records.filter(r => r.kind === 'status').flatMap(r => r.status.trajectory ?? [])
  const sections = []
  for (const section of start.sections) {
    const length = Math.hypot(section.nx, section.nz)
    const nx = section.nx / length
    const nz = section.nz / length
    let crossing
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]
      const b = samples[i]
      const from = (a.position.x - section.cx) * nx + (a.position.z - section.cz) * nz
      const to = (b.position.x - section.cx) * nx + (b.position.z - section.cz) * nz
      if (from > 0 || to <= 0)
        continue
      const t = -from / (to - from)
      const p = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, a.position[axis] + (b.position[axis] - a.position[axis]) * t]))
      const lateral = Math.abs((p.x - section.cx) * -nz + (p.z - section.cz) * nx)
      crossing = {
        name: section.name,
        tick: b.tick,
        position: p,
        passed: b.tick === a.tick + 1 && [a, b].every(s => s.inputOwner === 'flight-session'
          && !s.holding && s.gliding && !s.inWater && s.routeOutcome !== 'FAILED')
        && lateral <= section.width && p.y >= section.minY && p.y <= section.maxY,
      }
      break
    }
    sections.push(crossing ?? { name: section.name, passed: false })
  }
  const allCrossed = sections.every(s => s.passed)
  const prefix = sections.slice(0, sections.findIndex(s => !s.passed) === -1 ? sections.length : sections.findIndex(s => !s.passed))
  const routeTicks = samples.filter(s => s.inputOwner === 'flight-session')
  const segment = samples.filter(s => s.tick >= routeTicks[0]?.tick && s.tick <= routeTicks.at(-1)?.tick)
  const contacts = []
  let sweptPoints = 0
  let maxYaw = 0
  let maxPitch = 0
  let gapTicks = 0
  let damage = 0
  for (let i = 1; i < segment.length; i++) {
    const a = segment[i - 1]
    const b = segment[i]
    gapTicks += Math.max(0, b.tick - a.tick - 1)
    damage += Math.max(0, a.health - b.health)
    maxYaw = Math.max(maxYaw, Math.abs(((b.yaw - a.yaw + 540) % 360) - 180))
    maxPitch = Math.max(maxPitch, Math.abs(b.pitch - a.pitch))
    const pa = a.position
    const pb = b.position
    const vertical = { x: pa.x, y: pb.y, z: pa.z }
    const zFirst = Math.abs(pb.x - pa.x) < Math.abs(pb.z - pa.z)
    const horizontal = { x: zFirst ? pa.x : pb.x, y: pb.y, z: zFirst ? pb.z : pa.z }
    for (const [from, to] of [[pa, pb], [pa, vertical], [vertical, horizontal], [horizontal, pb]]) {
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / 0.25))
      for (let step = 0; step <= steps; step++) {
        const t = step / steps
        const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t }
        sweptPoints++
        for (let x = Math.floor(p.x - 0.45); x < Math.ceil(p.x + 0.45); x++) {
          for (let z = Math.floor(p.z - 0.45); z < Math.ceil(p.z + 0.45); z++) {
            for (let y = Math.floor(p.y - 0.15); y < Math.ceil(p.y + 1.8 + 0.15); y++) {
              const id = blockAt(x, y, z)
              if (!['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(id)
                && contacts.length < 20) {
                contacts.push({ tick: b.tick, x, y, z, id })
              }
            }
          }
        }
      }
    }
  }
  const ownersValid = segment.length > 1 && segment.every(s => s.inputOwner === 'flight-session'
    && !s.holding && s.gliding && !s.inWater && !s.safeEmergency && !s.budgetExhausted && s.boostCount <= 1)
  const summary = records.find(r => r.kind === 'summary')
  results.push({ tag, build: start.build, wholeRunDamage: summary.damage, prefixThrough: prefix.at(-1)?.name, prefixVerified: ownersValid && gapTicks === 0 && summary.damage < 0.01 && damage < 0.01 && contacts.length === 0 && maxYaw <= 25.01 && maxPitch <= 8.01, sha256: createHash('sha256').update(bytes).digest('hex'), sections, nativeTicks: segment.length, sweptPoints, contacts, gapTicks, damage, maxYaw, maxPitch, ownersValid, localVerified: allCrossed && ownersValid && gapTicks === 0 && damage < 0.01
    && contacts.length === 0 && maxYaw <= 25.01 && maxPitch <= 8.01, ending: { stopReason: summary.stopReason ?? 'old_harness', damage: summary.damage,
    // local-01/02 counted water as settled; local-03 omitted damage in endingVerified.
    verified: summary.stopReason === 'settled_ground' && summary.damage < 0.01
      && samples.filter(s => s.inputOwner === 'flight-recovery').every(s => !s.gliding || !s.safeEmergency) } })
}
for (const result of results) {
  result.auditSpan = 'all route-owned ticks, including intervals after a failed gate'
  result.allRouteTicksVerified = result.prefixVerified
  delete result.prefixVerified
}
writeFileSync(new URL('all-tick-audit.json', root), `${JSON.stringify({ results }, null, 2)}\n`)
console.info(results.map(r => ({ run: r.tag, build: r.build, local: r.localVerified, ticks: r.nativeTicks, contacts: r.contacts.length, gaps: r.gapTicks, damage: r.damage, yaw: r.maxYaw.toFixed(2), ending: r.ending.verified })))
