/**
 * Prints the mod's last jump task status, then exits.
 *
 * The task's status survives completion, so this reads the evidence of the
 * last hop (edge ids, per-edge landings, phase, settle errors) without
 * running a new command. Usage: node jump-status.mjs [port]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const port = process.argv[2] ?? '25600'
const client = new Client({ name: 'jump-status', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const result = await client.callTool({ name: 'jump_plan_status', arguments: {} })
console.log((result.content ?? []).map(part => part.text).join(''))
await client.close().catch(() => {})
process.exit(0)
