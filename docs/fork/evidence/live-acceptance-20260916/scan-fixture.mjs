/**
 * Scans the CD-V fixture the user built on the (300,0) platform and prints a
 * readable map: marker blocks, waterways, the rail line, levers and horses.
 *
 * Usage: node scan-fixture.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'scan-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

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

const FROM = { x: 230, y: 197, z: -80 }
const TO = { x: 275, y: 206, z: -34 }
const region = structuredOf(await server.callTool({ name: 'get_blocks_region', arguments: { from: FROM, to: TO, includeAir: false } }))
const blocks = (region?.blocks ?? []).filter(block => block.id && !block.id.endsWith('air'))
console.log(`scanned ${FROM.x},${FROM.y},${FROM.z} .. ${TO.x},${TO.y},${TO.z}: ${blocks.length} non-air blocks`)

const byId = new Map()
for (const block of blocks) {
  const list = byId.get(block.id) ?? []
  list.push(block)
  byId.set(block.id, list)
}
console.log('\n--- ids present ---')
for (const [id, list] of [...byId.entries()].sort((a, b) => b[1].length - a[1].length))
  console.log(`${String(list.length).padStart(5)}  ${id}`)

// print the interesting ids with their extents and coordinates
const interesting = ['minecraft:netherite_block', 'minecraft:redstone_block', 'minecraft:emerald_block', 'minecraft:diamond_block', 'minecraft:lapis_block', 'minecraft:lever', 'minecraft:powered_rail', 'minecraft:rail', 'minecraft:stripped_cherry_log', 'minecraft:stripped_acacia_log', 'minecraft:crimson_stem', 'minecraft:jungle_log', 'minecraft:oak_fence', 'minecraft:carpet', 'minecraft:white_carpet', 'minecraft:red_carpet', 'minecraft:stone', 'minecraft:white_concrete', 'minecraft:red_concrete']
console.log('\n--- markers and fixtures ---')
for (const id of interesting) {
  const list = byId.get(id)
  if (!list)
    continue
  const xs = list.map(b => b.x)
  const ys = list.map(b => b.y)
  const zs = list.map(b => b.z)
  console.log(`${id}: n=${list.length} x[${Math.min(...xs)}..${Math.max(...xs)}] y[${Math.min(...ys)}..${Math.max(...ys)}] z[${Math.min(...zs)}..${Math.max(...zs)}]`)
  if (list.length <= 24)
    console.log('   ', list.map(b => `${b.x},${b.y},${b.z}`).join(' | '))
}

console.log('\n--- horses near the bank ---')
const horses = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 250, y: 201, z: -60 }, radius: 40, includePlayers: false, maxResults: 30, types: ['minecraft:horse'] } }))
for (const horse of horses?.entities ?? [])
  console.log(JSON.stringify({ name: horse.name, uuid: horse.uuid?.slice(0, 8), x: Number(horse.x).toFixed(1), y: Number(horse.y).toFixed(1), z: Number(horse.z).toFixed(1) }))

await server.close()
