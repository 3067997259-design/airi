import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Clears the circuit output of the combo fixture: the stone blocker and the
// bridge row the command blocks place. Numeric-only arguments keep the Windows
// shells out of the JSON quoting business.
// Usage: node reset-circuit.mjs <port>
const [port] = process.argv.slice(2)
const client = new Client({ name: 'reset-circuit', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))

const setBlock = async (x, y, z, blockId) => {
  const result = await client.callTool({ name: 'set_block', arguments: { x, y, z, blockId } })
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  console.log(`set ${x} ${y} ${z} ${blockId}: isError=${result.isError === true} ${text.slice(0, 60).replace(/\s+/g, ' ')}`)
}

await setBlock(92, 84, -14, 'minecraft:air')
for (let x = 88; x <= 91; x++)
  await setBlock(x, 82, -15, 'minecraft:air')

for (const [x, y, z] of [[92, 84, -14], [88, 82, -15], [90, 82, -15], [92, 83, -25]]) {
  const read = await client.callTool({ name: 'get_block', arguments: { x, y, z } })
  const text = (read.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  console.log(`read ${x} ${y} ${z}: ${(text.match(/minecraft:[a-z_]+/) ?? ['?'])[0]}`)
}
await client.close()
