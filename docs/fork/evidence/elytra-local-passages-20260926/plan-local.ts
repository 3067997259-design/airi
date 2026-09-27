import { readFileSync, writeFileSync } from 'node:fs'

import { planSpaceRoute } from '../../../../apps/stage-tamagotchi/src/main/services/airi/game-host/flight/corridor'

/**
 * Run the production geometric search on a complete passage snapshot.
 * Call stack: plan-local -> planSpaceRoute -> footprint and edge validation.
 * The fixture bounds restrict the experiment to the required underpass.
 */
const root = new URL('./', import.meta.url)
const metadata = JSON.parse(readFileSync(new URL('world.json', root), 'utf8')) as {
  box: { x0: number, x1: number, y0: number, y1: number, z0: number, z1: number }
  palette: string[]
}
const { box, palette } = metadata
const binary = readFileSync(new URL('world.bin', root))
const nx = box.x1 - box.x0 + 1
const nz = box.z1 - box.z0 + 1
const cells = new Map<string, string>()
for (let y = 63; y <= 76; y++) {
  for (let z = box.z0; z <= box.z1; z++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const index = (x - box.x0) + nx * ((z - box.z0) + nz * (y - box.y0))
      cells.set(`${x},${y},${z}`, palette[binary.readUInt16LE(index * 2)]!)
    }
  }
}
const stops = [
  { x: -985.5, y: 73.5, z: -65.5 },
  { x: -973.5, y: 73.5, z: -94.5 },
  { x: -966.5, y: 73.5, z: -104.5 },
  { x: -953.5, y: 69.5, z: -120.5 },
  { x: -940.5, y: 69.5, z: -136.5 },
  // The entire six-block completion sphere must be beyond the final section.
  { x: -909.5, y: 69.5, z: -170.5 },
]
const path: typeof stops = []
for (let i = 1; i < stops.length; i++) {
  const route = planSpaceRoute({ cells, start: stops[i - 1]!, goal: stops[i]!, timeCapMs: 10_000 })
  console.info(JSON.stringify({ stage: i, ...route, path: route.ok ? route.path.length : undefined }))
  if (!route.ok)
    throw new Error(`Stage ${i}: ${route.reason}`)
  path.push(...(i === 1 ? route.path : route.path.slice(1)))
}
writeFileSync(new URL('geometric-route.json', root), `${JSON.stringify({ points: path, stops }, null, 2)}\n`)
writeFileSync(new URL('route.tsv', root), `${path.map(p => `${p.x}\t${p.y}\t${p.z}`).join('\n')}\n`)
