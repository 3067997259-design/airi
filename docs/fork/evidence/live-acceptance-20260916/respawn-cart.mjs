import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const server = new Client({ name: 'respawn-cart', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function run(command) { return await server.callTool({ name: 'run_command', arguments: { command } }) }
await run('kill @e[type=minecraft:item,x=236,y=198,z=-44,dx=10,dy=8,dz=30]')
await run('kill @e[type=minecraft:arrow]')
await run('kill @e[type=minecraft:sheep,x=236,y=198,z=-40,dx=10,dy=8,dz=24]')
await sleep(400)
await run('summon minecraft:minecart 240.5 202.7 -36.6')
await sleep(900)
const samples = []
for (let i = 0; i < 40; i++) {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 240, y: 201, z: -30 }, radius: 22, includePlayers: false, maxResults: 10, types: ['minecraft:minecart'] } }))
  const cart = (record?.entities ?? [])[0]
  samples.push(cart ? Number(cart.z) : null)
  await sleep(250)
}
const zs = samples.filter(v => v !== null)
console.log('cart z samples:', zs.map(v => v.toFixed(2)).join(' '))
console.log('range:', Math.min(...zs).toFixed(2), '..', Math.max(...zs).toFixed(2), 'moving:', (Math.max(...zs) - Math.min(...zs)) > 5)
const items = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 240.5, y: 201, z: -30 }, radius: 30, includePlayers: false, maxResults: 60, types: ['minecraft:item'] } }))
console.log('items left:', (items?.entities ?? []).length)
await server.close()
