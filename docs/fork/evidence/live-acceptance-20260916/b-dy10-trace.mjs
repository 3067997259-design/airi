/** dy-10 aim trace: poll get_self during the charge, then find the arrow. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'trace-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'trace-game', version: '1.0.0' })
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
const self = async () => structuredOf(await game.callTool({ name: 'get_self', arguments: {} }))
const inv = async () => structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
const arrowCount = async () => {
  const inventory = await inv()
  return (inventory?.hotbar ?? []).filter(item => item.id === 'minecraft:arrow').reduce((sum, item) => sum + Number(item.count ?? 0), 0)
}
const arrowsNear = async (center, radius) => structuredOf(await server.callTool({ name: 'query_entities', arguments: { center, radius, includePlayers: false, maxResults: 60, types: ['minecraft:arrow'] } }))

const TARGET_NBT = `{CustomName:'"Target"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:400f,attributes:[{id:"minecraft:generic.max_health",base:400}]}`
await run('kill @e[type=minecraft:sheep,name=Target]')
await run(`summon minecraft:sheep 43.5 131 -15.5 ${TARGET_NBT}`)
await run('clear airitest minecraft:arrow')
await run('give airitest minecraft:arrow 64')
await run('tp airitest 43.5 141 -25.5 180 0')
await new Promise(resolve => setTimeout(resolve, 800))
console.log('arrows before:', await arrowCount())

const sheepRecord = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 43, y: 131, z: -15 }, radius: 5, includePlayers: false, maxResults: 5, types: ['minecraft:sheep'] } }))
const targetUuid = (sheepRecord?.entities ?? []).find(entry => entry.name === 'Target')?.uuid
console.log('target uuid:', targetUuid)

const started = structuredOf(await game.callTool({ name: 'combat_start', arguments: { weapon: 'bow', targetX: 43.5, targetY: 131.65, targetZ: -15.5, targetUuid, maxShots: 1, chargeTicks: 20 } }))
console.log('combat_start:', JSON.stringify(started).slice(0, 160))

const trace = []
for (let tick = 0; tick < 30; tick++) {
  const state = await self()
  trace.push(`${state?.yaw?.toFixed?.(1) ?? state?.yaw}/${state?.pitch?.toFixed?.(1) ?? state?.pitch} using=${state?.usingItem} ticks=${state?.usingTicks}`)
  await new Promise(resolve => setTimeout(resolve, 150))
}
console.log('aim trace:', trace.join(' | '))
const status = structuredOf(await game.callTool({ name: 'combat_status', arguments: {} }))
console.log('status:', JSON.stringify(status).slice(0, 220))
console.log('arrows after:', await arrowCount())
const dropped = await arrowsNear({ x: 43.5, y: 131, z: -15 }, 20)
console.log('arrows near target:', JSON.stringify((dropped?.entities ?? []).map(a => [Number(a.x).toFixed(2), Number(a.y).toFixed(2), Number(a.z).toFixed(2)])))
await new Promise(resolve => setTimeout(resolve, 3000))
const later = await arrowsNear({ x: 43.5, y: 131, z: -15 }, 20)
console.log('arrows near target +3s:', JSON.stringify((later?.entities ?? []).map(a => [Number(a.x).toFixed(2), Number(a.y).toFixed(2), Number(a.z).toFixed(2)])))

await run('kill @e[type=minecraft:sheep,name=Target]')
await run('tp airitest 82.5 75 -24.5 0 0')
await game.close()
await server.close()
