/**
 * R2a supplement: launch cancel behavior regression (execution plan §6 gate:
 * "原起飞宏的成功、取消和无烟花行为没有回归" — success was proven by the
 * main run's D1; this covers cancel. The no-fireworks variant is NOT-RUN:
 * the bot holds hundreds of rockets and clearing them changes fixture state.)
 */
import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const token = '4065cb42ca7b48e2a4c7d35e9ad20378'
const client = new Client({ name: 'r2a-cancel', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}))
function structured(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return text ? JSON.parse(text) : {}
}
const call = (name, args = {}) => client.callTool({ name, arguments: args }).then(structured)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Start a launch, let it tick briefly, then cancel through the launch's own
// RPC (the macro owns its lifecycle; the flight session only observes).
const start = await call('elytra_launch', { goalX: -984, goalY: 90, goalZ: 30, withFireworks: true })
await sleep(1200)
const cancel = await call('elytra_launch_cancel', {})
await sleep(1500)
const status = await call('flight_status', {})
const record = {
  scenario: 'E-launch-cancel',
  startPhase: start.phase,
  cancelState: cancel.state,
  cancelEndReason: cancel.endReason,
  sessionAfterLaunch: status.state,
  sessionEndReason: status.endReason,
  trajectoryLost: status.trajectoryLost,
}
console.log(JSON.stringify(record, null, 2))
writeFileSync('r2a-cancel-20260920.json', JSON.stringify(record, null, 2))
process.exit(0)
