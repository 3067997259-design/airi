import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
const TARGET = 'MTarget'
const sleep = ms => new Promise(r => setTimeout(r, ms))
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent
  const text = (result?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
  try { return JSON.parse(text) } catch { return undefined }
}
const server = new Client({ name: 'b06b', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
async function run(command) { return structuredOf(await server.callTool({ name: 'run_command', arguments: { command } })) }
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let id = 0; const pending = new Map()
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
async function evalJs(expression) {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const m = await new Promise(resolve => pending.set(mid, resolve))
  return m.result?.exceptionDetails ? `EXC ${m.result.exceptionDetails.exception?.description}` : m.result?.result?.value
}
await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await sleep(900)
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
await run(`summon minecraft:sheep 258 201 -20 {CustomName:'"${TARGET}"',CustomNameVisible:1b,NoAI:1b,Silent:1b,PersistenceRequired:1b,Health:45f}`)
await run('tp airitest 258 201 -32 180 0')
await sleep(700)
const started = Date.now()
await evalJs(`window.__late = 'pending'
window.__AIRI_GAME_HOST_SMOKE__.executeGameTool('game_shoot', { target: '${TARGET}', weapon: 'bow', maxShots: 1, chargeTicks: 20 }).then(r => { window.__late = r }).catch(e => { window.__late = { error: String(e) } })
'go'`)
await sleep(1900)
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
console.log('sheep killed at ~1900ms (mid-flight), elapsed', Date.now() - started)
let state = 'pending'
for (let i = 0; i < 120 && state === 'pending'; i++) { await sleep(250); state = await evalJs('typeof window.__late === "string" ? window.__late : JSON.stringify(window.__late)') }
const receipt = typeof state === 'string' ? JSON.parse(state) : state
console.log('late-read receipt:', JSON.stringify({ endReason: receipt?.endReason, fired: receipt?.shot?.shots?.length ?? 0, hitEvidence: receipt?.shot?.shots?.[0]?.hitEvidence, killed: receipt?.shot?.killed, unobservedTargetDeath: receipt?.shot?.unobservedTargetDeath, observationAgeMs: receipt?.shot?.observationAgeMs }).slice(0, 400))
import('node:fs').then(fs => fs.writeFileSync(new URL('./b06b.json', import.meta.url), JSON.stringify({ receipt }, null, 2)))
// cleanup: remove the leftover patch stone and loose cobblestone items
await run('fill 258 201 -33 258 201 -32 minecraft:air')
await run('fill 259 201 -31 259 201 -31 minecraft:air')
await run('kill @e[type=minecraft:item,name=Cobblestone,x=248,y=198,z=-40,dx=22,dy=10,dz=26]')
await run('kill @e[type=minecraft:arrow]')
await run(`kill @e[type=minecraft:sheep,name=${TARGET}]`)
ws.close(); await server.close()
