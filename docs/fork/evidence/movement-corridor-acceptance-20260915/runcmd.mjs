import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Runs one server command through the mcpfabric bridge. The command is the last
// argument, or `@path` to read it from a file (Windows shells mangle quotes in
// inline JSON, so a file avoids every quoting trap).
// Usage: node runcmd.mjs <port> <command|@path>
const [port, arg] = process.argv.slice(2)
const command = arg?.startsWith('@') ? readFileSync(arg.slice(1), 'utf8').trim() : arg
const client = new Client({ name: 'runcmd', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const result = await client.callTool({ name: 'run_command', arguments: { command } })
const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
console.log(`isError=${result.isError === true} ${text.slice(0, 300)}`)
await client.close()
