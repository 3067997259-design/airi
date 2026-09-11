import process from 'node:process'

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Collects a reproducible source baseline for fork execution records. */
async function main() {
  const [head, status, diff] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']),
    run('git', ['status', '--short']),
    run('git', ['diff', '--binary']),
  ])
  const diffHash = createHash('sha256').update(diff.stdout).digest('hex')
  const lines = status.stdout.trim().split(/\r?\n/).filter(Boolean)
  process.stdout.write(`${JSON.stringify({
    head: head.stdout.trim(),
    changedFiles: lines.length,
    status: lines,
    diffSha256: diffHash,
    checks: ['pnpm typecheck', 'pnpm lint'],
  }, null, 2)}\n`)
}

await main()
