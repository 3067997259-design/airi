import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const server = new Client({ name: 'cleanup', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function run(command) { return await server.callTool({ name: 'run_command', arguments: { command } }) }
await run('kill @e[type=minecraft:item,x=235,y=198,z=-46,dx=12,dy=10,dz=32]')
await run('kill @e[type=minecraft:arrow]')
await run('kill @e[type=minecraft:sheep,x=235,y=198,z=-46,dx=12,dy=10,dz=32]')
await run('tp airitest 82.5 75 -23.5 0 0')
await run('summon minecraft:minecart 240.5 202.7 -36.6')
await sleep(900)
const samples = []
for (let i = 0; i < 20; i++) {
  const record = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 240, y: 201, z: -30 }, radius: 22, includePlayers: false, maxResults: 10, types: ['minecraft:minecart'] } }))
  const cart = (record?.entities ?? [])[0]
  samples.push(cart ? Number(cart.z) : null)
  await sleep(250)
}
const zs = samples.filter(v => v !== null)
const items = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 240.5, y: 201, z: -30 }, radius: 40, includePlayers: false, maxResults: 60, types: ['minecraft:item'] } }))
console.log('new cart oscillating:', zs.length > 0 && (Math.max(...zs) - Math.min(...zs)) > 5, 'items left:', (items?.entities ?? []).length)
await server.close()
