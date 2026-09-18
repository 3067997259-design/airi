/**
 * Builds a large two-level deck in an empty sky area for the CD-V fixtures.
 *
 * Center (300, -, 0): far from the base (82,75,-24) and the ballistics range
 * (43,140,-57), so nothing else uses these chunks. The two decks are 97x97:
 * lower at y200 (surface 201), upper at y232 (surface 233), with 32 blocks of
 * open headroom between them and open sides.
 *
 * Usage: node build-deck.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const server = new Client({ name: 'deck-server', version: '1.0.0' })
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
  return { ok: record?.success === true, output: record?.output?.[0] ?? textOf(result).slice(0, 120) }
}
async function columnAir(x, z, bottom = 190, top = 245) {
  const record = structuredOf(await server.callTool({ name: 'get_blocks_region', arguments: { from: { x, y: bottom, z }, to: { x, y: top, z }, includeAir: false } }))
  return (record?.blocks ?? []).filter(block => block.id && !block.id.endsWith('air'))
}

const CENTER = { x: 300, z: 0 }
const LOWER_Y = 200
const UPPER_Y = 232
const R = 48

console.log('--- empty-air scan (non-air blocks in 9 columns y190..245) ---')
for (const [dx, dz] of [[0, 0], [-45, -45], [45, -45], [-45, 45], [45, 45], [0, -45], [0, 45], [-45, 0], [45, 0]]) {
  const blocks = await columnAir(CENTER.x + dx, CENTER.z + dz)
  console.log(`(${CENTER.x + dx},${CENTER.z + dz}):`, blocks.length === 0 ? 'air' : JSON.stringify(blocks.slice(0, 4)))
}

console.log('--- force-load the site ---')
console.log('forceload add:', JSON.stringify(await run(`forceload add ${CENTER.x - R} ${CENTER.z - R} ${CENTER.x + R} ${CENTER.z + R}`)))
await new Promise(resolve => setTimeout(resolve, 2500))
console.log('--- bring the bot over (loads surrounding chunks) ---')
console.log('tp:', JSON.stringify(await run(`execute in minecraft:overworld run tp airitest ${CENTER.x}.5 ${LOWER_Y + 5} ${CENTER.z}.5 0 0`)))
await new Promise(resolve => setTimeout(resolve, 4000))

console.log('--- lower deck ---')
console.log(JSON.stringify(await run(`fill ${CENTER.x - R} ${LOWER_Y} ${CENTER.z - R} ${CENTER.x + R} ${LOWER_Y} ${CENTER.z + R} minecraft:stone`)))
console.log('lower rim:', JSON.stringify(await run(`fill ${CENTER.x - R} ${LOWER_Y + 1} ${CENTER.z - R} ${CENTER.x + R} ${LOWER_Y + 1} ${CENTER.z - R} minecraft:white_concrete`)))
console.log('lower rim:', JSON.stringify(await run(`fill ${CENTER.x - R} ${LOWER_Y + 1} ${CENTER.z + R} ${CENTER.x + R} ${LOWER_Y + 1} ${CENTER.z + R} minecraft:white_concrete`)))
console.log('lower rim:', JSON.stringify(await run(`fill ${CENTER.x - R} ${LOWER_Y + 1} ${CENTER.z - R} ${CENTER.x - R} ${LOWER_Y + 1} ${CENTER.z + R} minecraft:white_concrete`)))
console.log('lower rim:', JSON.stringify(await run(`fill ${CENTER.x + R} ${LOWER_Y + 1} ${CENTER.z - R} ${CENTER.x + R} ${LOWER_Y + 1} ${CENTER.z + R} minecraft:white_concrete`)))
console.log('lower centre marker:', JSON.stringify(await run(`fill ${CENTER.x - 1} ${LOWER_Y + 1} ${CENTER.z - 1} ${CENTER.x + 1} ${LOWER_Y + 1} ${CENTER.z + 1} minecraft:red_concrete`)))

console.log('--- upper deck ---')
console.log(JSON.stringify(await run(`fill ${CENTER.x - R} ${UPPER_Y} ${CENTER.z - R} ${CENTER.x + R} ${UPPER_Y} ${CENTER.z + R} minecraft:stone`)))
console.log('upper rim:', JSON.stringify(await run(`fill ${CENTER.x - R} ${UPPER_Y + 1} ${CENTER.z - R} ${CENTER.x + R} ${UPPER_Y + 1} ${CENTER.z - R} minecraft:white_concrete`)))
console.log('upper rim:', JSON.stringify(await run(`fill ${CENTER.x - R} ${UPPER_Y + 1} ${CENTER.z + R} ${CENTER.x + R} ${UPPER_Y + 1} ${CENTER.z + R} minecraft:white_concrete`)))
console.log('upper rim:', JSON.stringify(await run(`fill ${CENTER.x - R} ${UPPER_Y + 1} ${CENTER.z - R} ${CENTER.x - R} ${UPPER_Y + 1} ${CENTER.z + R} minecraft:white_concrete`)))
console.log('upper rim:', JSON.stringify(await run(`fill ${CENTER.x + R} ${UPPER_Y + 1} ${CENTER.z - R} ${CENTER.x + R} ${UPPER_Y + 1} ${CENTER.z + R} minecraft:white_concrete`)))
console.log('upper centre marker:', JSON.stringify(await run(`fill ${CENTER.x - 1} ${UPPER_Y + 1} ${CENTER.z - 1} ${CENTER.x + 1} ${UPPER_Y + 1} ${CENTER.z + 1} minecraft:red_concrete`)))

console.log('--- verify ---')
for (const [label, x, y, z] of [['lower corner', CENTER.x - R, LOWER_Y, CENTER.z - R], ['lower centre', CENTER.x, LOWER_Y, CENTER.z], ['upper corner', CENTER.x + R, UPPER_Y, CENTER.z + R], ['upper centre', CENTER.x, UPPER_Y, CENTER.z]]) {
  const block = structuredOf(await server.callTool({ name: 'get_block', arguments: { x, y, z } }))
  console.log(label, JSON.stringify({ id: block?.id }))
}
console.log('forceload remove:', JSON.stringify(await run(`forceload remove ${CENTER.x - R} ${CENTER.z - R} ${CENTER.x + R} ${CENTER.z + R}`)))
console.log('return the bot:', JSON.stringify(await run('tp airitest 82.5 75 -24.5 0 0')))
console.log(`\nDECKS READY: centre (${CENTER.x}, -, ${CENTER.z}), ${R * 2 + 1}x${R * 2 + 1} each`)
console.log(`lower surface y=${LOWER_Y + 1}, upper surface y=${UPPER_Y + 1}, headroom ${UPPER_Y - LOWER_Y - 1} blocks`)
console.log(`tp: /tp @s ${CENTER.x}.5 ${LOWER_Y + 1} ${CENTER.z}.5`)
console.log(`tp upper: /tp @s ${CENTER.x}.5 ${UPPER_Y + 1} ${CENTER.z}.5`)
await server.close()