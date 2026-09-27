import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** Prepare the original bridge without submitting a flight channel.
 * Call stack: preparation -> MCP supply/reset -> AIRI owns the later move_to.
 */
const clients = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  for (const port of [25600, 25602]) {
    const client = new Client({ name: 'host-flight-prepare', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
    clients.push(client)
  }
  async function call(side, name, args = {}) {
    const result = await clients[side].callTool({ name, arguments: args })
    if (result.isError) throw new Error(JSON.stringify(result))
    return result.structuredContent ?? JSON.parse(result.content.find(p => p.type === 'text').text)
  }
  const command = command => call(1, 'run_command', { command })
  const old = await call(0, 'flight_status')
  if (old.sessionId) await call(0, 'flight_revoke', { sessionId: old.sessionId })
  await call(0, 'stop_movement')
  await command('effect give airitest minecraft:resistance 5 5 true')
  await command('clear airitest minecraft:elytra')
  await sleep(2000)
  await call(1, 'teleport_player', { player: 'airitest', x: -1006.5, y: 74, z: 79.5 })
  await command('effect give airitest minecraft:instant_health 1 20 true')
  await command('effect give airitest minecraft:saturation 5 10 true')
  await command('item replace entity airitest armor.chest with minecraft:elytra')
  const hands = await call(0, 'get_equipment')
  if (hands.offHand?.id && !['minecraft:air', 'minecraft:firework_rocket'].includes(hands.offHand.id))
    throw new Error('Offhand contains unrelated equipment')
  const rocket = 'minecraft:firework_rocket[minecraft:fireworks={flight_duration:1,explosions:[]}]'
  if (hands.mainHand?.id === 'minecraft:firework_rocket')
    await command(`item replace entity airitest weapon.mainhand with ${rocket} 64`)
  await command(`item replace entity airitest weapon.offhand with ${rocket} 64`)
  await sleep(6000)
  const self = await call(0, 'get_self')
  if (!self.onGround || self.fallFlying) throw new Error('Bridge reset did not settle')
  console.info(JSON.stringify({ self, build: old.build, recipe: 1 }))
} finally {
  await Promise.all(clients.map(client => client.close()))
}
