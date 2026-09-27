/**
 * Surface probe for the R2b test area (read-only, server 25602).
 *
 * Reads vertical slabs between the bridge and the north river bend, then
 * prints a coarse map: the highest non-air block per column and whether it is
 * water. Used once to pick an open diagnostic channel; safe to rerun.
 *
 *   node probe-surface.mjs --raw    # print the first raw response
 *   node probe-surface.mjs          # print the height/water map
 */
import process from 'node:process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const RAW = process.argv.includes('--raw')
const Y_MIN = 55
const Y_MAX = 95
const X_SLABS = [
  [-1060, -1000],
  [-1000, -940],
  [-940, -880],
]
const Z_START = 90
const Z_END = -190
const Z_STEP = 10

const client = new Client({ name: 'surface-probe', version: '1.0.0' })

function structured(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return result.structuredContent
  const text = (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return text ? JSON.parse(text) : {}
}

function entriesOf(payload) {
  for (const key of ['blocks', 'entries', 'results', 'data']) {
    if (Array.isArray(payload?.[key]))
      return payload[key]
  }
  return []
}

function posOf(entry) {
  const x = entry.x ?? entry.position?.x
  const y = entry.y ?? entry.position?.y
  const z = entry.z ?? entry.position?.z
  return { x, y, z }
}

async function main() {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25602/mcp')))
  const columns = new Map()
  let calls = 0
  let truncated = 0
  for (const [x0, x1] of X_SLABS) {
    for (let z0 = Z_START; z0 > Z_END; z0 -= Z_STEP) {
      const payload = structured(await client.callTool({
        name: 'get_blocks_region',
        arguments: {
          from: { x: x0, y: Y_MIN, z: z0 - Z_STEP + 1 },
          to: { x: x1, y: Y_MAX, z: z0 },
        },
      }))
      calls += 1
      if (RAW && calls === 1) {
        console.info(JSON.stringify(payload).slice(0, 1500))
        await client.close()
        return
      }
      if (payload.truncated)
        truncated += 1
      for (const entry of entriesOf(payload)) {
        const { x, y, z } = posOf(entry)
        if (x === undefined)
          continue
        const id = String(entry.id ?? entry.block ?? entry.name ?? '')
        const key = `${x},${z}`
        const current = columns.get(key)
        if (!current || y > current.y)
          columns.set(key, { y, id })
      }
    }
  }
  const xs = []
  for (const [x0, x1] of X_SLABS) {
    for (let x = x0; x <= x1; x += 5) xs.push(x)
  }
  const zs = []
  for (let z = Z_START; z > Z_END; z -= 10) zs.push(z)
  console.info(`calls=${calls} truncated=${truncated} columns=${columns.size}`)
  const header = ['z\\x', ...xs.map(x => String(Math.floor(x / 10) % 1000).padStart(3))].join(' ')
  console.info(header)
  for (const z of zs) {
    const row = [String(z).padStart(4)]
    for (const x of xs) {
      const column = columns.get(`${x},${z}`)
      if (!column)
        row.push('  ?')
      else if (/water/.test(column.id))
        row.push(` ${String(column.y).padStart(2)}~`)
      else
        row.push(` ${String(column.y).padStart(2)}#`)
    }
    console.info(row.join(' '))
  }
  await client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
