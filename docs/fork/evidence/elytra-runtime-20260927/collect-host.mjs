import { appendFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** Records a normal AIRI command without submitting a frozen channel.
 * Call stack: main -> flight_status -> append-only native tick evidence.
 * AIRI owns submission and cancellation; this collector only reads.
 */
const client = new Client({ name: 'host-flight-audit', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
const output = new URL('host-01.jsonl', import.meta.url)
const read = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError)
    throw new Error(result.content.filter(p => p.type === 'text').map(p => p.text).join('\n'))
  return result.structuredContent ?? JSON.parse(result.content.find(p => p.type === 'text').text)
}
const before = await read('flight_status', { sinceTick: 0 })
let cursor = Math.max(0, ...(before.trajectory ?? []).map(s => s.tick))
let active = false
let stable = 0
appendFileSync(output, `${JSON.stringify({ kind: 'start', at: new Date().toISOString(), self: await read('get_self'), build: before.build })}\n`)
console.info('collector ready')
try {
  const until = Date.now() + 65_000
  while (Date.now() < until) {
    const status = await read('flight_status', { sinceTick: cursor })
    appendFileSync(output, `${JSON.stringify({ kind: 'status', at: new Date().toISOString(), status })}\n`)
    for (const s of status.trajectory ?? []) {
      if (s.tick <= cursor) continue
      cursor = s.tick
      active ||= s.inputOwner === 'flight-session' || s.inputOwner === 'launch-macro'
      stable = active && s.onGround && !s.gliding && Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z) < .1 ? stable + 1 : 0
    }
    const last = status.trajectory?.at(-1)
    if (active && (stable >= 20 || status.routeOutcome === 'FAILED' || last?.safeEmergency || last?.inWater)) {
      console.info(JSON.stringify({ state: status.state, reason: status.endReason, detail: status.endDetail, stable, last }))
      break
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
} finally { await client.close() }
