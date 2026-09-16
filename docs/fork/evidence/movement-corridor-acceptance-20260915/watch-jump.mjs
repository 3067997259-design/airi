import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Polls the mod's jump task status and keeps a compact timeline. Used to find
// where a chain stalls: the host log shows polls, this shows the mod's own
// phase, edge, wait ticks, and takeoff trace.
// Usage: node watch-jump.mjs <port> <seconds> <outPath>
const [port, secondsRaw, outPath] = process.argv.slice(2)
const seconds = Number(secondsRaw ?? 40)
const client = new Client({ name: 'watch-jump', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const rows = []
const started = Date.now()
while (Date.now() - started < seconds * 1000) {
  const result = await client.callTool({ name: 'jump_plan_status', arguments: {} })
  const text = (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  try {
    const status = JSON.parse(text)
    rows.push({
      t: Date.now() - started,
      state: status.state,
      endReason: status.endReason,
      phase: status.phase,
      edgeId: status.edgeId,
      done: status.completedCount,
      wait: status.waitTicks,
      ticks: status.ticks,
      pos: status.position ? `${Number(status.position.x).toFixed(2)},${Number(status.position.y).toFixed(2)},${Number(status.position.z).toFixed(2)}` : '',
      trace: typeof status.takeoffTrace === 'string' ? status.takeoffTrace.slice(0, 120) : '',
    })
  }
  catch {
    rows.push({ t: Date.now() - started, raw: text.slice(0, 120) })
  }
  writeFileSync(outPath, JSON.stringify(rows, null, 2))
  await new Promise(resolve => setTimeout(resolve, 700))
}
console.log(`samples=${rows.length}`)
await client.close()
