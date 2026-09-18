/**
 * Floods the CD-V fixture waterways: every lapis_block cell (the water
 * placeholder) plus the two 1-block separators (x248, x260) and the redstone /
 * emerald start markers become real water at y200. The netherite block (237,200,
 * -61) and the diamond block (265,200,-45) stay as the channel end walls.
 *
 * The original lapis cell list is printed first so the change is reversible.
 *
 * Usage: node flood-channels.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'flood-server', version: '1.0.0' })
await server.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))

function textOf(result) {
  return (result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
}
function structuredOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = textOf(result)
  if (!text)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}
async function run(command) {
  const result = await server.callTool({ name: 'run_command', arguments: { command } })
  const record = structuredOf(result)
  return { ok: record?.success === true, output: record?.output?.[0] ?? textOf(result).slice(0, 90) }
}

// rows: channel #1/#2 keep the three z rows; channel #3 follows the scanned runs
const ROWS = [
  { z: -44, runs: [[266, 275]] },
  { z: -45, runs: [[266, 275]] },
  { z: -46, runs: [[266, 275]] },
  { z: -47, runs: [[273, 275]] },
  { z: -48, runs: [[273, 275]] },
  { z: -49, runs: [[273, 275]] },
  { z: -50, runs: [[273, 275]] },
  { z: -51, runs: [[272, 275]] },
  { z: -52, runs: [[271, 274]] },
  { z: -53, runs: [[268, 273]] },
  { z: -54, runs: [[268, 272]] },
  { z: -55, runs: [[266, 270]] },
  { z: -56, runs: [[266, 270]] },
  { z: -57, runs: [[265, 268]] },
  { z: -58, runs: [[264, 267]] },
  { z: -59, runs: [[264, 267]] },
]

await run(`forceload add 230 -70 290 -30`)
await new Promise(resolve => setTimeout(resolve, 1500))
await run(`tp airitest 250.5 203 -50.5 0 0`)
await new Promise(resolve => setTimeout(resolve, 2000))

console.log('--- waterways #1/#2 (z -62..-60, x 238..265: lapis + separators + markers) ---')
console.log(JSON.stringify(await run(`fill 238 200 -62 265 200 -60 minecraft:water`)))

console.log('--- waterway #3 rows ---')
for (const row of ROWS) {
  for (const [x1, x2] of row.runs) {
    const result = await run(`fill ${x1} 200 ${row.z} ${x2} 200 ${row.z} minecraft:water`)
    console.log(`z=${row.z} x ${x1}..${x2}`, JSON.stringify(result))
  }
}

console.log('--- verify: water cells (count + ends) ---')
const region = structuredOf(await server.callTool({ name: 'get_blocks_region', arguments: { from: { x: 236, y: 200, z: -64 }, to: { x: 278, y: 201, z: -42 }, includeAir: false } }))
const water = (region?.blocks ?? []).filter(block => block.id === 'minecraft:water')
console.log('water cells:', water.length)
for (const [label, x, y, z] of [
  ['start west wall', 237, 200, -61],
  ['channel #1 first cell', 238, 200, -61],
  ['separator 248', 248, 200, -61],
  ['marker 249', 249, 200, -61],
  ['separator 260', 260, 200, -61],
  ['marker 261', 261, 200, -61],
  ['channel #3 corner', 264, 200, -62],
  ['channel #3 top', 274, 200, -47],
  ['channel #3 west end', 266, 200, -45],
  ['bank diamond wall', 265, 200, -45],
]) {
  const block = structuredOf(await server.callTool({ name: 'get_block', arguments: { x, y, z } }))
  console.log(label.padEnd(24), JSON.stringify({ id: block?.id }))
}

console.log('--- horse states (bot is now near them) ---')
for (const uuid of ['7a2513b3-1099-4995-9c68-493bd207e6cb', 'dab18f00-b926-42a8-ae37-4adbc93ed24a', '539d63d5-26fd-48d8-baef-0c40e66322af', '89d46d22-a475-4287-aa2c-0dc8f663cd5a']) {
  const state = structuredOf(await server.callTool({ name: 'get_entity', arguments: { uuid } }))
  console.log(uuid.slice(0, 8), JSON.stringify({ x: state?.x, z: state?.z, motion: state?.motion }))
}

await run(`forceload remove 230 -70 290 -30`)
await run('tp airitest 82.5 75 -24.5 0 0')
await server.close()
