import { readFileSync } from 'node:fs'

const root = new URL('./', import.meta.url)
const { box, palette } = JSON.parse(readFileSync(new URL('world.json', root), 'utf8'))
const data = readFileSync(new URL('world.bin', root))
const nx = box.x1 - box.x0 + 1
const nz = box.z1 - box.z0 + 1
for (let z = -156; z >= -184; z -= 2) {
  const row = []
  for (let x = -932; x <= -902; x += 2) {
    let cell = '?'
    for (let y = 73; y >= box.y0; y--) {
      const id = palette[data.readUInt16LE(2 * ((x - box.x0) + nx * ((z - box.z0) + nz * (y - box.y0))))]
      if (!id.endsWith('air') && !id.endsWith('grass') && !id.endsWith('fern')) {
        cell = `${y + 1}${id.endsWith('water') ? 'w' : id.endsWith('leaves') ? 'l' : 's'}`
        break
      }
    }
    row.push(cell)
  }
  console.info(z, row.join(' '))
}
