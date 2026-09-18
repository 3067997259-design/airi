import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const game = new Client({ name: 'modcheck', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
const status = structuredOf(await game.callTool({ name: 'get_status', arguments: {} }))
console.log('bot client:', JSON.stringify({ modVersion: status?.modVersion, minecraftVersion: status?.minecraftVersion, side: status?.side, inWorld: status?.inWorld, dimension: status?.dimension }))
const self = structuredOf(await game.callTool({ name: 'get_self', arguments: {} }))
console.log('bot self:', JSON.stringify({ x: self?.x, y: self?.y, z: self?.z, health: self?.health, heldItem: self?.heldItem }))
await game.close()
