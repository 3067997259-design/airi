import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const server = new Client({ name: 'give-fw2', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
async function run(command) {
  const record = structuredOf(await server.callTool({ name: 'run_command', arguments: { command } }))
  return record?.output?.join('\n').slice(0, 240)
}
const explosions = Array.from({ length: 7 }, () => '{shape:"large_ball"}').join(',')
console.log('give explosive:', await run(`give airitest minecraft:firework_rocket[fireworks={explosions:[${explosions}]}] 8`))
await server.close()
