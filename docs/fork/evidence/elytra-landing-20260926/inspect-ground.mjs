import { readFileSync } from 'node:fs'

const { box, palette } = JSON.parse(readFileSync(new URL('world.json', import.meta.url), 'utf8'))
const data = readFileSync(new URL('world.bin', import.meta.url))
const nx = box.x1 - box.x0 + 1
const nz = box.z1 - box.z0 + 1
function cell(x, y, z) {
  if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1 || z < box.z0 || z > box.z1)
    return 'unknown'
  return palette[data.readUInt16LE(2 * ((x - box.x0) + nx * ((z - box.z0) + nz * (y - box.y0))))].replace('minecraft:', '')
}
const clear = id => /^(?:air|cave_air|short_grass|tall_grass|vine|dead_bush|torch|wall_torch|glow_lichen)$/.test(id)
for (let z = -241; z >= -244; z--) {
  console.info('impact-neighborhood', z, [-868, -867, -866, -865].map(x => [x, cell(x, 70, z), cell(x, 71, z)]))
}
console.info('Columns x=-920..-830 step 5; highest surface below y=76. W=water L=leaves O=obsidian G=glass P=prismarine')
for (let z = -160; z >= -275; z -= 5) {
  const row = []
  for (let x = -920; x <= -830; x += 5) {
    let y = 75
    while (y >= box.y0 && clear(cell(x, y, z))) y--
    const id = cell(x, y, z)
    row.push(`${y + 1}${({ water: 'W', oak_leaves: 'L', obsidian: 'O', glass: 'G', prismarine: 'P' })[id] ?? '.'}`)
  }
  console.info(z, row.join(' '))
}
const patches = []
for (let z = -170; z >= -273; z -= 1) {
  for (let x = -930; x <= -828; x += 1) {
    for (let y = 63; y <= 78; y++) {
      let good = true
      for (let dx = -2; dx <= 2 && good; dx++) {
        for (let dz = -2; dz <= 2 && good; dz++) {
          const support = cell(x + dx, y - 1, z + dz)
          if (clear(support) || /water|leaves|lava|unknown/.test(support))
            good = false
          for (let dy = 0; dy < 4 && good; dy++) {
            if (!clear(cell(x + dx, y + dy, z + dz)))
              good = false
          }
        }
      }
      if (good && !patches.some(p => Math.hypot(x - p.x, z - p.z) < 8))
        patches.push({ x, y, z })
    }
  }
}
console.info('Flat 5x5 patches:', JSON.stringify(patches))
for (const material of ['glass', 'prismarine', 'obsidian']) {
  const points = []
  for (let y = box.y0; y <= box.y1; y++) {
    for (let z = box.z0; z <= box.z1; z++) {
      for (let x = box.x0; x <= box.x1; x++) {
        if (cell(x, y, z) === material)
          points.push([x, y, z])
      }
    }
  }
  console.info(material, points.length, points.length < 30 ? points : [0, 1, 2].map(i => [Math.min(...points.map(p => p[i])), Math.max(...points.map(p => p[i]))]))
  if (material === 'obsidian') {
    for (let z = -145; z >= -250; z -= 5) {
      const row = points.filter(p => p[2] === z)
      console.info('roof', z, row.length ? [0, 1].map(i => [Math.min(...row.map(p => p[i])), Math.max(...row.map(p => p[i]))]) : 'none')
    }
  }
}
