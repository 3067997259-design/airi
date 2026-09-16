import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Reads blocks at numeric positions (Windows shells mangle inline JSON, so this
// takes plain numbers).
// Usage: node blocks.mjs <port> <outPath> x y z [x y z ...]
const [port, outPath, ...rest] = process.argv.slice(2)
const client = new Client({ name: 'blocks', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const rows = []
for (let index = 0; index < rest.length; index += 3) {
  const x = Number(rest[index])
  const y = Number(rest[index + 1])
  const z = Number(rest[index + 2])
  const result = await client.callTool({ name: 'get_block', arguments: { x, y, z } })
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  const id = (text.match(/minecraft:[a-z_]+/) ?? ['?'])[0]
  const props = (text.match(/\{[^}]*\}/) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 90)
  rows.push({ x, y, z, id, props })
}
writeFileSync(outPath, JSON.stringify(rows, null, 2))
for (const row of rows)
  console.log(`${row.x} ${row.y} ${row.z} -> ${row.id} ${row.props}`)
await client.close()
