/**
 * Second pass: exact cells for the waterways, bank, rail line, levers, the
 * platform hole and the horse states.
 *
 * Usage: node scan-fixture2.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'scan2-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'scan2-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))

function textOf(result) {
  return (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = textOf(result)
  if (!text)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

const FROM = { x: 232, y: 198, z: -66 }
const TO = { x: 278, y: 204, z: -36 }
const region = structuredOf(await server.callTool({ name: 'get_blocks_region', arguments: { from: FROM, to: TO, includeAir: true } }))
const blocks = (region?.blocks ?? []).filter(block => block.id)
const cell = new Map(blocks.map(block => [`${block.x},${block.y},${block.z}`, block.id]))

// waterway: lapis cells grouped by z rows (the water will replace them)
console.log('--- lapis (to become water), rows by z ---')
const lapis = blocks.filter(block => block.id === 'minecraft:lapis_block')
for (const z of [...new Set(lapis.map(b => b.z))].sort((a, b) => b - a)) {
  const row = lapis.filter(b => b.z === z).map(b => b.x).sort((a, b) => a - b)
  console.log(`z=${z}: x ${row.join(',')}`)
}

console.log('\n--- bank structure (fence/carpet/diamond/stairs) ---')
for (const id of ['minecraft:oak_fence', 'minecraft:white_carpet', 'minecraft:diamond_block', 'minecraft:oak_stairs'])
  console.log(id, blocks.filter(b => b.id === id).map(b => `${b.x},${b.y},${b.z}`).join(' | ') || '(none)')

console.log('\n--- rail line cells (rail/powered_rail/lever/crimson/jungle) ---')
for (const id of ['minecraft:rail', 'minecraft:powered_rail', 'minecraft:lever', 'minecraft:crimson_stem', 'minecraft:jungle_log'])
  console.log(id, blocks.filter(b => b.id === id).map(b => `${b.x},${b.y},${b.z}`).join(' | '))

console.log('\n--- platform holes (air at y199/y200 inside the deck) ---')
const holes = []
for (const block of blocks) {
  if (block.y !== 199 && block.y !== 200)
    continue
  if (block.x < 236 || block.x > 364 || block.z < -64 || block.z > 64)
    continue
  if (block.id.endsWith('air'))
    holes.push(`${block.x},${block.y},${block.z}`)
}
console.log(holes.join(' | ') || '(none read as air)')

console.log('\n--- horses with state ---')
const horses = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 250, y: 201, z: -60 }, radius: 40, includePlayers: false, maxResults: 30, types: ['minecraft:horse'] } }))
for (const horse of horses?.entities ?? []) {
  const state = structuredOf(await game.callTool({ name: 'get_vehicle_state', arguments: { uuid: horse.uuid } }))
  console.log(JSON.stringify({ name: horse.name, uuid: horse.uuid?.slice(0, 8), x: Number(horse.x).toFixed(1), y: Number(horse.y).toFixed(1), z: Number(horse.z).toFixed(1), tamed: state?.state?.tamed, saddled: state?.state?.saddled, free: state?.free }))
}

console.log('\n--- start block + levers context ---')
for (const [x, y, z] of [[237, 200, -61], [240, 200, -41], [240, 201, -42], [241, 201, -42], [240, 201, -58], [245, 201, -56], [253, 201, -57], [265, 200, -45]])
  console.log(`(${x},${y},${z}) = ${cell.get(`${x},${y},${z}`)}`)

await game.close()
await server.close()
