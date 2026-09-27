import { readFileSync, writeFileSync } from 'node:fs'

import { planSpaceRoute } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/corridor'

/**
 * Extend the accepted local route through the actual remaining fixture.
 * Call stack: plan-extension -> planSpaceRoute -> footprint and edge checks.
 * This offline diagnostic does not establish dynamic flight feasibility.
 */
const root = new URL('./', import.meta.url)
const { box, palette } = JSON.parse(readFileSync(new URL('world.json', root), 'utf8')) as {
  box: { x0: number, x1: number, y0: number, y1: number, z0: number, z1: number }
  palette: string[]
}
const binary = readFileSync(new URL('world.bin', root))
const nx = box.x1 - box.x0 + 1
const nz = box.z1 - box.z0 + 1
const cells = new Map<string, string>()
for (let y = 63; y <= 79; y++) {
  for (let z = box.z0; z <= box.z1; z++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const index = (x - box.x0) + nx * ((z - box.z0) + nz * (y - box.y0))
      cells.set(`${x},${y},${z}`, palette[binary.readUInt16LE(index * 2)]!)
    }
  }
}
const previous = JSON.parse(readFileSync(new URL('../elytra-local-passages-20260926/geometric-route.json', root), 'utf8')) as {
  points: { x: number, y: number, z: number }[]
}
const start = previous.points.at(-1)!
const goal = { x: -842.5, y: 66.5, z: -265.5 }
const result = planSpaceRoute({ cells, start, goal, timeCapMs: 15_000 })
console.info(JSON.stringify({ ...result, path: result.ok ? result.path.length : undefined }))
writeFileSync(new URL('extension-plan.json', root), `${JSON.stringify(result, null, 2)}\n`)
if (result.ok) {
  const points = [...previous.points, ...result.path.slice(1)]
  writeFileSync(new URL('geometric-route.json', root), `${JSON.stringify({ points, goal }, null, 2)}\n`)
  writeFileSync(new URL('route.tsv', root), `${points.map(p => `${p.x}\t${p.y}\t${p.z}`).join('\n')}\n`)
  writeFileSync(new URL('extension.tsv', root), `${result.path.map(p => `${p.x}\t${p.y}\t${p.z}`).join('\n')}\n`)
}
