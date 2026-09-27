import { writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Captures a solid-block snapshot of the ab-17 terminal region (ab-17 audit
// item 4: save a big enough end space, then compare planned chord vs executed
// trajectory). The read is server-side and read-only.
// Usage: node end-region-snapshot.mjs <port> <minX> <minY> <minZ> <maxX> <maxY> <maxZ> <outPath>
const [port, minX, minY, minZ, maxX, maxY, maxZ, outPath] = process.argv.slice(2)
const box = { x0: Number(minX), y0: Number(minY), z0: Number(minZ), x1: Number(maxX), y1: Number(maxY), z1: Number(maxZ) }
const client = new Client({ name: 'end-region-snapshot', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
const footprint = (box.x1 - box.x0 + 1) * (box.z1 - box.z0 + 1)
const bandLayers = Math.max(1, Math.floor(8_000 / footprint))
const cells = []
let reads = 0
for (let y = box.y0; y <= box.y1; y += bandLayers) {
  const bandY1 = Math.min(box.y1, y + bandLayers - 1)
  const result = await client.callTool({
    name: 'get_blocks_region',
    arguments: {
      from: { x: box.x0, y, z: box.z0 },
      to: { x: box.x1, y: bandY1, z: box.z1 },
      includeAir: true,
    },
  })
  reads += 1
  const record = result.structuredContent ?? {}
  if (result.isError === true)
    throw new Error(`get_blocks_region failed: ${JSON.stringify(record).slice(0, 200)}`)
  const blocks = Array.isArray(record.blocks) ? record.blocks : []
  for (const block of blocks) {
    const x = Number(block.x)
    const yy = Number(block.y)
    const z = Number(block.z)
    const id = typeof block.id === 'string' ? block.id : ''
    // Air is implicit: a missing cell is not solid, which is how the
    // comparison tool reads it. Keeping solid cells only bounds the file.
    if (Number.isFinite(x) && Number.isFinite(yy) && Number.isFinite(z) && !id.includes('air'))
      cells.push([`${x},${yy},${z}`, id])
  }
  console.info(`[snapshot] y=${y}..${bandY1} volume=${record.volume} count=${record.count} truncated=${record.truncated} cells=${cells.length}`)
}
writeFileSync(outPath, JSON.stringify({ box, reads, cells }))
console.info(`[snapshot] wrote ${cells.length} solid cells from ${reads} reads to ${outPath}`)
await client.close()
