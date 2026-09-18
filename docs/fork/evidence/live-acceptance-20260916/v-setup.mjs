/** Post-reboot setup: heal the bot, park it at the base, verify. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'setup-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'setup-game', version: '1.0.0' })
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
  const record = structuredOf(result)
  console.log(`${command} -> success=${record?.success ?? result.isError === false}`)
}

await run('effect give airitest minecraft:regeneration 8 4 true')
await run('effect give airitest minecraft:saturation 8 4 true')
await run('effect give airitest minecraft:resistance 8 4 true')
await run('tp airitest 82.5 75 -24.5 0 0')
await new Promise(resolve => setTimeout(resolve, 1200))
const self = structuredOf(await game.callTool({ name: 'get_self', arguments: {} }))
console.log('self:', JSON.stringify({ x: self?.x, y: self?.y, z: self?.z, health: self?.health, dimension: self?.dimension }))
await game.close()
await server.close()
