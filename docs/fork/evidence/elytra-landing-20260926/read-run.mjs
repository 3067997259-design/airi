import process from 'node:process'

import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('./', import.meta.url)
const tag = process.argv[2] ?? 'extension-01'
const rows = readFileSync(new URL(`${tag}.jsonl`, root), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const samples = [...new Map(rows.flatMap(row => row.status?.trajectory ?? []).map(s => [s.tick, s])).values()]
const controlled = samples.filter(s => s.inputOwner === 'flight-session')
console.info('first', JSON.stringify(controlled[0]))
console.info('last', JSON.stringify(samples.at(-1)))
const tsv = samples.map(s => [s.tick, s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.yaw, s.pitch, s.boostRemainingEstimate, s.inputOwner, s.cursor, s.chosenPolicy, s.safeVerified, s.safeEmergency].join('\t')).join('\n')
writeFileSync(new URL(`${tag}-samples.tsv`, root), `${tsv}\n`)
const measured = samples.map((s, i) => ({ s, prior: samples[Math.max(0, i - 1)] }))
  .filter(({ s }) => s.tick >= controlled[0].tick)
  .map(({ s, prior }) => [s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.boostRemainingEstimate, prior.yaw, prior.pitch, s.rocketsInHands].join('\t'))
writeFileSync(new URL(`${tag}-measured.tsv`, root), `${measured.join('\n')}\n`)
