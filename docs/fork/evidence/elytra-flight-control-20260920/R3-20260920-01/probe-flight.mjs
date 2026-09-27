/**
 * Read-only probe for the R3 channel exchange: observe, try one submit, then
 * revoke the probe session. Prints the raw receipts so a refusal reason is
 * visible instead of mapped away.
 *
 *   node probe-flight.mjs
 */
import process from 'node:process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'r3-probe', version: '1.0.0' })

function payload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return text ? JSON.parse(text) : {}
}

async function main() {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { isError: result?.isError === true, payload: payload(result) }
  }

  const before = await call('flight_observe')
  console.info('observe:', JSON.stringify({ session: before.payload.session, launch: before.payload.launch?.state }))

  const lastStatus = await call('flight_status', { sinceTick: 9_999_999 })
  console.info('last status:', JSON.stringify({ sessionId: lastStatus.payload.sessionId, state: lastStatus.payload.state, endReason: lastStatus.payload.endReason }))

  const sessionId = `r3-probe-${Date.now()}`
  const submit = await call('flight_submit', {
    sessionId,
    generation: Number(process.env.R3_GENERATION ?? 99),
    revision: 1,
    deadlineMs: Date.now() + 60_000,
    dimension: 'minecraft:overworld',
    channel: {
      path: [
        { x: -1000, y: 72, z: 40 },
        { x: -992, y: 70, z: -20 },
      ],
      entryReach: 8,
    },
  })
  console.info('submit:', JSON.stringify(submit))

  const status = await call('flight_status', { sinceTick: 0 })
  console.info('status:', JSON.stringify({ state: status.payload.state, endReason: status.payload.endReason, applyingStarted: status.payload.applyingStarted }))

  const revoke = await call('flight_revoke', { sessionId })
  console.info('revoke:', JSON.stringify(revoke))

  await client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
