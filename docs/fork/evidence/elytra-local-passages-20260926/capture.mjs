import process from 'node:process'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * Capture a complete bounded world snapshot for the passage replay.
 * Call stack: capture -> MCP get_blocks_region -> checked dense palette cells.
 * Unknown cells keep index zero. A truncated or incomplete read aborts capture.
 */
async function main() {
  const client = new Client({ name: 'passage-capture', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args })
    const data = result.structuredContent ?? JSON.parse(result.content.find(p => p.type === 'text').text)
    if (result.isError)
      throw new Error(JSON.stringify(data))
    return data
  }
  const box = { x0: -1010, x1: -900, y0: 55, y1: 104, z0: -185, z1: -45 }
  const nx = box.x1 - box.x0 + 1
  const ny = box.y1 - box.y0 + 1
  const nz = box.z1 - box.z0 + 1
  const cells = new Uint16Array(nx * ny * nz)
  const palette = ['minecraft:unknown']
  const ids = new Map([[palette[0], 0]])
  const reads = []
  try {
    const before = await call('run_command', { command: 'forceload query' })
    writeFileSync(new URL('./forceload-before.json', import.meta.url), `${JSON.stringify(before, null, 2)}\n`)
    const loaded = await call('run_command', { command: `forceload add ${box.x0} ${box.z0} ${box.x1} ${box.z1}` })
    if (!loaded.success)
      throw new Error(JSON.stringify(loaded))
    await new Promise(resolve => setTimeout(resolve, 1500))
    for (let x = box.x0; x <= box.x1; x += 16) {
      for (let z = box.z0; z <= box.z1; z += 24) {
        const to = { x: Math.min(x + 15, box.x1), y: box.y1, z: Math.min(z + 23, box.z1) }
        const result = await call('get_blocks_region', { from: { x, y: box.y0, z }, to, includeAir: true })
        const expected = (to.x - x + 1) * ny * (to.z - z + 1)
        if (result.truncated || result.blocks?.length !== expected)
          throw new Error(`Incomplete region ${x},${z}: ${result.blocks?.length}/${expected}`)
        for (const block of result.blocks) {
          if (!ids.has(block.id)) {
            ids.set(block.id, palette.length)
            palette.push(block.id)
          }
          cells[(block.x - box.x0) + nx * ((block.z - box.z0) + nz * (block.y - box.y0))] = ids.get(block.id)
        }
        reads.push({ from: { x, y: box.y0, z }, to, cells: expected })
      }
      console.info(`captured x=${x} reads=${reads.length}`)
    }
    if (cells.includes(0))
      throw new Error('Unobserved cells remain')
    const binary = Buffer.alloc(cells.length * 2)
    cells.forEach((cell, index) => binary.writeUInt16LE(cell, index * 2))
    writeFileSync(new URL('./world.bin', import.meta.url), binary)
    const metadata = { capturedAt: new Date().toISOString(), box, palette, cells: cells.length, sha256: createHash('sha256').update(binary).digest('hex'), reads }
    writeFileSync(new URL('./world.json', import.meta.url), `${JSON.stringify(metadata, null, 2)}\n`)
    writeFileSync(new URL('./world.properties', import.meta.url), `${Object.entries(box).map(([key, value]) => `${key}=${value}`).concat(palette.map((id, i) => `palette.${i}=${id}`)).join('\n')}\n`)
    console.info(`complete cells=${cells.length} palette=${palette.length}`)
  }
  finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
