/**
 * Rebuilds the CD-V fixture site as ONE 2-block-thick platform (no upper deck),
 * so shallow canals can be dug into it.
 *
 * Centre (300, 0), 129x129, blocks at y199..200, walk surface y201.
 * The old two-deck build (lower y200 + upper y232) is cleared first.
 *
 * Usage: node build-deck2.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'deck2-server', version: '1.0.0' })
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
  return { ok: record?.success === true, output: record?.output?.[0] ?? textOf(result).slice(0, 100) }
}

const C = { x: 300, z: 0 }
const R = 64
const Y_BOTTOM = 199
const Y_TOP = 200
const SURFACE = Y_TOP + 1

await run(`forceload add ${C.x - R} ${C.z - R} ${C.x + R} ${C.z + R}`)
await new Promise(resolve => setTimeout(resolve, 2000))
await run(`tp airitest ${C.x}.5 ${SURFACE + 8} ${C.z}.5 0 0`)
await new Promise(resolve => setTimeout(resolve, 2500))

console.log('--- clear the old decks (chunked z, vanilla fill cap is 32768) ---')
for (const [z1, z2] of [[-50, -17], [-16, 16], [17, 50]]) {
  console.log('clear lower', z1, z2, JSON.stringify(await run(`fill 250 198 ${z1} 350 203 ${z2} minecraft:air`)))
  console.log('clear upper', z1, z2, JSON.stringify(await run(`fill 250 230 ${z1} 350 235 ${z2} minecraft:air`)))
}

console.log('--- 2-thick platform (chunked z) ---')
for (const [z1, z2] of [[-64, -1], [0, 64]])
  console.log('platform', z1, z2, JSON.stringify(await run(`fill ${C.x - R} ${Y_BOTTOM} ${z1} ${C.x + R} ${Y_TOP} ${z2} minecraft:stone`)))
console.log('rim:', JSON.stringify(await run(`fill ${C.x - R} ${SURFACE} ${C.z - R} ${C.x + R} ${SURFACE} ${C.z - R} minecraft:white_concrete`)))
console.log('rim:', JSON.stringify(await run(`fill ${C.x - R} ${SURFACE} ${C.z + R} ${C.x + R} ${SURFACE} ${C.z + R} minecraft:white_concrete`)))
console.log('rim:', JSON.stringify(await run(`fill ${C.x - R} ${SURFACE} ${C.z - R} ${C.x - R} ${SURFACE} ${C.z + R} minecraft:white_concrete`)))
console.log('rim:', JSON.stringify(await run(`fill ${C.x + R} ${SURFACE} ${C.z - R} ${C.x + R} ${SURFACE} ${C.z + R} minecraft:white_concrete`)))
console.log('centre marker:', JSON.stringify(await run(`fill ${C.x - 1} ${SURFACE} ${C.z - 1} ${C.x + 1} ${SURFACE} ${C.z + 1} minecraft:red_concrete`)))

console.log('--- verify (bottom layer, top layer, surface, outside) ---')
for (const [label, x, y, z] of [['bottom corner', C.x - R, Y_BOTTOM, C.z - R], ['top layer', C.x, Y_TOP, C.z], ['surface block', C.x, Y_TOP + 1, C.z], ['beyond edge', C.x + R + 2, Y_TOP, C.z]]) {
  const block = structuredOf(await server.callTool({ name: 'get_block', arguments: { x, y, z } }))
  console.log(label, JSON.stringify({ id: block?.id }))
}

await run(`forceload remove ${C.x - R} ${C.z - R} ${C.x + R} ${C.z + R}`)
await run('tp airitest 82.5 75 -24.5 0 0')
console.log(`\nPLATFORM READY: centre (${C.x}, ${C.z}), ${R * 2 + 1}x${R * 2 + 1}`)
console.log(`blocks y${Y_BOTTOM}..y${Y_TOP} (2 thick), walk surface y${SURFACE}`)
console.log(`bounds x${C.x - R}..${C.x + R}, z${C.z - R}..${C.z + R}`)
console.log(`tp: /tp @s ${C.x}.5 ${SURFACE} ${C.z}.5`)
await server.close()
