import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const server = new Client({ name: 'srvcheck', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
const status = structuredOf(await server.callTool({ name: 'get_status', arguments: {} }))
console.log('server mod:', JSON.stringify({ modVersion: status?.modVersion, side: status?.side, players: status?.players }))
const players = structuredOf(await server.callTool({ name: 'list_players', arguments: {} }))
console.log('online:', JSON.stringify((players?.players ?? []).map(p => p.name)))
const probe = structuredOf(await server.callTool({ name: 'get_entity', arguments: { uuid: (players?.players ?? []).find(p => p.name === 'airitest')?.uuid ?? '' } }))
console.log('effects field present:', Array.isArray(probe?.effects), JSON.stringify(probe?.effects))
await server.close()
