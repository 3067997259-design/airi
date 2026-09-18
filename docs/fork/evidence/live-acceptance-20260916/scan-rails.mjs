/** Reads the fixture rail shapes and levers, then probes one powered start. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'railscan-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'railscan-game', version: '1.0.0' })
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
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  return structuredOf(result)?.success === true
}
async function block(x, y, z) {
  return structuredOf(await server.callTool({ name: 'get_block', arguments: { x, y, z } }))
}

console.log('--- rail shapes ---')
const region = structuredOf(await server.callTool({ name: 'get_blocks_region', arguments: { from: { x: 236, y: 201, z: -60 }, to: { x: 256, y: 201, z: -40 }, includeAir: false } }))
for (const b of region?.blocks ?? []) {
  if (b.id === 'minecraft:rail' || b.id === 'minecraft:powered_rail' || b.id === 'minecraft:lever')
    console.log(`${b.id.replace('minecraft:', '').padEnd(13)} ${b.x},${b.y},${b.z} shape=${b.properties?.shape ?? '-'} powered=${b.properties?.powered ?? '-'}`)
}

console.log('\n--- probe: cart on the start powered rail with the lever pulled ---')
await run(`forceload add 230 -70 290 -30`)
await run('kill @e[type=minecraft:minecart]')
await run('tp airitest 240.5 203 -40.5 180 30')
await new Promise(resolve => setTimeout(resolve, 1500))
await run('setblock 241 201 -42 minecraft:lever[face=floor,facing=north,powered=true]')
await new Promise(resolve => setTimeout(resolve, 300))
const powered = await block(240, 201, -42)
console.log('start powered rail:', JSON.stringify({ id: powered?.id, props: powered?.properties }))
await run('summon minecraft:minecart 240.5 201.2 -41.6')
for (let sample = 0; sample < 6; sample++) {
  await new Promise(resolve => setTimeout(resolve, 700))
  const carts = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 242, y: 201, z: -52 }, radius: 30, includePlayers: false, maxResults: 10, types: ['minecraft:minecart'] } }))
  const cart = carts?.entities?.[0]
  console.log(`+${(sample + 1) * 0.7}s:`, cart ? `${Number(cart.x).toFixed(2)},${Number(cart.y).toFixed(2)},${Number(cart.z).toFixed(2)}` : 'none')
}
await run('setblock 241 201 -42 minecraft:lever[face=floor,facing=north,powered=false]')
await run('kill @e[type=minecraft:minecart]')
await run(`forceload remove 230 -70 290 -30`)
await game.close()
await server.close()
