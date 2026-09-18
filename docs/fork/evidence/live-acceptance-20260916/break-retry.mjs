import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const server = new Client({ name: 'retry', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
const game = new Client({ name: 'retry-game', version: '1.0.0' })
await game.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function run(command) { const result = await server.callTool({ name: 'run_command', arguments: { command } }); return structuredOf(result) }
await run('clear airitest minecraft:stone_pickaxe')
await run('item replace entity airitest hotbar.0 with minecraft:stone_pickaxe')
await sleep(600)
const equipment = structuredOf(await game.callTool({ name: 'get_equipment', arguments: {} }))
console.log('equipment:', JSON.stringify(equipment).slice(0, 200))
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let id = 0
const pending = new Map()
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
async function evalJs(expression) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const m = await new Promise(resolve => pending.set(mid, resolve))
  return m.result?.exceptionDetails ? `EXC ${m.result.exceptionDetails.exception?.description}` : m.result?.result?.value
}
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await sleep(1000)
for (let attempt = 1; attempt <= 2; attempt++) {
  await evalJs(`window.__rt = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_break', { x: 259, y: 201, z: -32, itemId: 'minecraft:cobblestone' }).then(r => { window.__rt = r }).catch(e => { window.__rt = { error: String(e) } })
'go'`)
  let state = 'pending'
  for (let i = 0; i < 120 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__rt === "string" ? window.__rt : JSON.stringify(window.__rt)') }
  const receipt = typeof state === 'string' ? JSON.parse(state) : state
  console.log(`attempt ${attempt}:`, JSON.stringify({ status: receipt?.status, endReason: receipt?.endReason, product: receipt?.broken?.product, rejection: receipt?.broken?.rejection, tool: receipt?.broken?.tool }).slice(0, 400))
  if (receipt?.status === 'ok')
    break
  await sleep(1500)
}
ws.close(); await game.close(); await server.close()
