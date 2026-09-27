import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const client = new Client({ name: 'probe', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25600/mcp')))
try {
  const self = await client.callTool({ name: 'get_self', arguments: {} })
  const s = self.structuredContent ?? {}
  console.info('self', JSON.stringify({ x: s.x, y: s.y, z: s.z, onGround: s.onGround, gliding: s.fallFlying, health: s.health }))
  const flight = await client.callTool({ name: 'flight_status', arguments: { sinceTick: 0 } })
  const f = flight.structuredContent ?? {}
  console.info('flight', JSON.stringify({ build: f.build, state: f.state, phase: f.phase, routeOutcome: f.routeOutcome, handoverCapable: f.handoverCapable }))
}
catch (error) {
  console.info('ERR', String(error).slice(0, 200))
}
await client.close()
