import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Replaces the two oak-fence turn pads with iron bars. A fence tops out 1.5
// above its base, so the step from the previous pad (top 78) needed a 1.5 rise,
// which no jump clears. Iron bars top out 1.0 above their base, so the rises
// stay at one block, and the landing is still a 0.125-wide post.
// Usage: node swap-fences.mjs <port>
const [port] = process.argv.slice(2)
const client = new Client({ name: 'swap-fences', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const cells = [[91, 78, -26], [92, 79, -27]]
for (const [x, y, z] of cells) {
  const set = await client.callTool({ name: 'set_block', arguments: { x, y, z, blockId: 'minecraft:iron_bars' } })
  console.log(`set ${x} ${y} ${z} iron_bars: isError=${set.isError === true}`)
}
for (const [x, y, z] of cells) {
  const read = await client.callTool({ name: 'get_block', arguments: { x, y, z } })
  const text = (read.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  console.log(`read ${x} ${y} ${z}: ${(text.match(/minecraft:[a-z_]+/) ?? ['?'])[0]}`)
}
await client.close()
