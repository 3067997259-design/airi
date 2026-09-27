/**
 * Dumps the client ring's health timeline: minimum health, the tick of each
 * drop, and the input owner at that tick. Read-only.
 *
 *   node ring-health.mjs
 */
import process from 'node:process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'ring-health', version: '1.0.0' })

function payload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return text ? JSON.parse(text) : {}
}

async function main() {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
  const result = await client.callTool({ name: 'flight_status', arguments: { sinceTick: 0 } })
  const status = payload(result)
  const samples = status.trajectory ?? []
  console.info(`samples=${samples.length} lost=${status.trajectoryLost} state=${status.state} endReason=${status.endReason} endDetail=${status.endDetail ?? 'n/a'}`)
  let previous
  let minHealth = Infinity
  for (const sample of samples) {
    if (typeof sample.health !== 'number')
      continue
    minHealth = Math.min(minHealth, sample.health)
    if (previous !== undefined && sample.health < previous - 0.01) {
      console.info(`drop tick=${sample.tick} hp=${previous.toFixed(2)}->${sample.health.toFixed(2)} owner=${sample.inputOwner} pos=${sample.position.x.toFixed(1)},${sample.position.y.toFixed(1)},${sample.position.z.toFixed(1)} gliding=${sample.gliding}`)
    }
    previous = sample.health
  }
  console.info(`minHealth=${minHealth}`)
  await client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
