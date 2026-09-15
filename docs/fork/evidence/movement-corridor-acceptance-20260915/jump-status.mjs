/**
 * Writes the mod's last jump task status to a file, then exits.
 *
 * The task's status survives completion, so this reads the evidence of the
 * last climb (edge ids, per-edge landings, phase, settle errors) without
 * running a new command. The output goes straight to the file: a shell
 * redirect on Windows merges Node's stderr assertion text into it.
 *
 * Usage: node jump-status.mjs [port] [outputPath]
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const port = process.argv[2] ?? '25600'
const output = process.argv[3] ?? 'jump-status.json'
const client = new Client({ name: 'jump-status', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const result = await client.callTool({ name: 'jump_plan_status', arguments: {} })
const text = (result.content ?? []).map(part => part.text).join('')
writeFileSync(output, text, 'utf8')
console.log(`wrote ${output} (${text.length} chars)`)
process.exit(0)
