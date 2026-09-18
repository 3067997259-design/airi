/** M-04/M-05/B-05/B-06 fixture setup on the user's platform. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'setup', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'setup-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  if (record && record.success === false)
    console.log(`command failed: ${command} -> ${JSON.stringify(record).slice(0, 160)}`)
  return record
}

// A 3x3 stone patch on the platform surface; the user mines (259,201,-32),
// the bot mines (258,201,-32).
await run('fill 257 201 -33 259 201 -31 minecraft:stone keep')
await run('tp airitest 258 201 -27 0 0')
await run('give airitest minecraft:stone_pickaxe 1')
await run('give AfterRain minecraft:cobblestone 16')
await run('give AfterRain minecraft:bow 1')
await run('give AfterRain minecraft:arrow 64')
await sleep(800)
const self = structuredOf(await game.callTool({ name: 'get_self', arguments: {} }))
const inventory = structuredOf(await game.callTool({ name: 'get_inventory', arguments: {} }))
const items = [...(inventory?.hotbar ?? []), ...(inventory?.main ?? [])].filter(Boolean).map(slot => `${slot.id}x${slot.count}`)
console.log('bot self:', JSON.stringify({ x: self?.x, y: self?.y, z: self?.z }))
console.log('bot items:', JSON.stringify(items))
const nearby = structuredOf(await server.callTool({ name: 'query_entities', arguments: { center: { x: 258, y: 201, z: -30 }, radius: 10, includePlayers: true, maxResults: 30 } }))
console.log('near patch:', JSON.stringify((nearby?.entities ?? []).map(e => `${e.type}(${e.name})@${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.z)}`)))
await run('gamemode creative AfterRain')
await game.close()
await server.close()
