import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Dumps the raw region entries for a small box, so a reader can see whether the
// bulk read sends collision shapes at all.
// Usage: node region-raw.mjs <port> <minX> <minY> <minZ> <maxX> <maxY> <maxZ> <outPath>
const [port, minX, minY, minZ, maxX, maxY, maxZ, outPath] = process.argv.slice(2)
const client = new Client({ name: 'region-raw', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const result = await client.callTool({
  name: 'get_blocks_region',
  arguments: {
    from: { x: Number(minX), y: Number(minY), z: Number(minZ) },
    to: { x: Number(maxX), y: Number(maxY), z: Number(maxZ) },
  },
})
writeFileSync(outPath, JSON.stringify({ isError: result.isError === true, structured: result.structuredContent ?? null, text: (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 1500) }, null, 2))
console.log(`isError=${result.isError === true}`)
await client.close()
