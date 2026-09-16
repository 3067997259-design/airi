import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Samples every online player's position for a while, so an automation run can
// be attributed to the right account (a live session had AIRI driving the human
// player because both clients shared one bridge port).
// Usage: node watch-players.mjs <port> <seconds> <outPath>
const [port, secondsRaw, outPath] = process.argv.slice(2)
const seconds = Number(secondsRaw ?? 60)
const client = new Client({ name: 'watch-players', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const samples = []
const started = Date.now()
while (Date.now() - started < seconds * 1000) {
  const result = await client.callTool({ name: 'list_players', arguments: {} })
  const structured = result.structuredContent ?? {}
  const players = Array.isArray(structured.players) ? structured.players : []
  samples.push({
    t: Date.now() - started,
    players: players.map(player => ({
      name: player.name,
      x: Number(player.position?.x ?? player.x),
      y: Number(player.position?.y ?? player.y),
      z: Number(player.position?.z ?? player.z),
    })),
  })
  writeFileSync(outPath, JSON.stringify(samples, null, 2))
  await new Promise(resolve => setTimeout(resolve, 500))
}
writeFileSync(outPath, JSON.stringify(samples, null, 2))
const names = [...new Set(samples.flatMap(sample => sample.players.map(player => player.name)))]
for (const name of names) {
  const trail = samples
    .map(sample => sample.players.find(player => player.name === name))
    .filter(Boolean)
  const moved = trail.filter((player, index) => index === 0 || Math.hypot(player.x - trail[index - 1].x, player.z - trail[index - 1].z) > 0.05)
  const first = trail[0]
  const last = trail[trail.length - 1]
  const distance = trail.reduce((total, player, index) => index === 0 ? 0 : total + Math.hypot(player.x - trail[index - 1].x, player.z - trail[index - 1].z), 0)
  console.log(`${name}: samples=${trail.length} distance=${distance.toFixed(2)} start=(${first.x.toFixed(1)},${first.y.toFixed(1)},${first.z.toFixed(1)}) end=(${last.x.toFixed(1)},${last.y.toFixed(1)},${last.z.toFixed(1)}) moveSamples=${moved.length}`)
}
await client.close()
