import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'drop-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'drop-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))

function textOf(result) {
  return (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  try {
    return JSON.parse(textOf(result))
  }
  catch {
    return undefined
  }
}
async function run(command) {
  return await server.callTool({ name: 'run_command', arguments: { command } })
}

await run('fill 42 141 -37 44 143 -37 minecraft:stone')
await run('clear airitest minecraft:arrow')
await run('give airitest minecraft:arrow 64')
await run('give airitest minecraft:bow 1')
await run('tp airitest 43.5 141 -57.5 180 0')
await new Promise(resolve => setTimeout(resolve, 800))

// Aim the wall centre: y=142 (the middle block of the 141..143 wall).
const start = await game.callTool({ name: 'combat_start', arguments: { weapon: 'bow', targetX: 43.5, targetY: 142, targetZ: -37.5, maxShots: 3, chargeTicks: 20 } })
console.log('combat_start:', JSON.stringify(structuredOf(start)).slice(0, 200))
await new Promise(resolve => setTimeout(resolve, 5_000))
const status = structuredOf(await game.callTool({ name: 'combat_status', arguments: {} }))
console.log('status:', JSON.stringify(status).slice(0, 260))
await game.callTool({ name: 'combat_cancel', arguments: {} }).catch(() => {})
await new Promise(resolve => setTimeout(resolve, 500))

const arrows = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 43, y: 142, z: -37 }, radius: 6, includePlayers: false, maxResults: 50, types: ['minecraft:arrow'] } }))
console.log('arrows near wall:', JSON.stringify(arrows))
await run('fill 42 141 -37 44 143 -37 air')
await game.close()
await server.close()
