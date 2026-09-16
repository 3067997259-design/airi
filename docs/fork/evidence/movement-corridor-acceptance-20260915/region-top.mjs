import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Prints the top non-air block of every column in a region as an ASCII map.
// Usage: node region-top.mjs <port> <minX> <minY> <minZ> <maxX> <maxY> <maxZ> <outPath>
const [port, minX, minY, minZ, maxX, maxY, maxZ, outPath] = process.argv.slice(2)
const client = new Client({ name: 'region-top', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const result = await client.callTool({
  name: 'get_blocks_region',
  arguments: {
    from: { x: Number(minX), y: Number(minY), z: Number(minZ) },
    to: { x: Number(maxX), y: Number(maxY), z: Number(maxZ) },
  },
})
const record = result.structuredContent ?? {}
const data = Array.isArray(record.blocks) ? record.blocks : Array.isArray(record.entries) ? record.entries : []
const top = new Map()
for (const block of data) {
  if (!block.id || block.id.includes('air'))
    continue
  const key = `${block.x},${block.z}`
  const previous = top.get(key)
  if (!previous || block.y > previous.y)
    top.set(key, { y: block.y, id: block.id })
}
const short = {
  white_glazed_terracotta: 'T',
  smooth_stone: 'S',
  stone: 'S',
  cobblestone: 'S',
  stone_bricks: 'b',
  dirt: 'D',
  coarse_dirt: 'D',
  grass_block: 'g',
  command_block: 'C',
  chain_command_block: 'c',
  repeating_command_block: 'R',
  stone_pressure_plate: 'P',
  oak_pressure_plate: 'P',
  glass_pane: 'p',
  iron_bars: 'B',
  oak_planks: 'w',
  oak_log: 'L',
  stripped_oak_log: 'L',
  oak_fence: 'F',
  oak_fence_gate: 'G',
  oak_slab: 's',
  oak_stairs: 't',
  sand: 'd',
  water: '~',
}
const lines = []
const isAir = id => id.includes('air')
for (let z = Number(minZ); z <= Number(maxZ); z++) {
  let line = String(z).padStart(4) + ' '
  for (let x = Number(minX); x <= Number(maxX); x++) {
    const cell = top.get(`${x},${z}`)
    if (!cell) {
      line += ' . '
      continue
    }
    const id = cell.id.replace('minecraft:', '')
    const label = isAir(cell.id) ? '.' : short[id] ?? id.slice(0, 3)
    line += `${label}${String(cell.y).slice(-1)} `
  }
  lines.push(line)
}
const header = '     ' + Array.from({ length: Number(maxX) - Number(minX) + 1 }, (_, i) => String(Number(minX) + i).padStart(3)).join('')
writeFileSync(outPath, JSON.stringify({ isError: result.isError === true, count: data.length, rows: [...top.entries()].map(([key, value]) => ({ key, ...value })) }, null, 2))
console.log(header)
console.log(lines.join('\n'))
console.log('(letter = top block, digit = last digit of its Y; the same column may hold more blocks below)')
await client.close()
