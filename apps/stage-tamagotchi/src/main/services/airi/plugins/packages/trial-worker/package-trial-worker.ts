import type { TrialWorkerFile, TrialWorkerObservation, TrialWorkerSkillSource, WorkerToParentMessage } from './protocol'

import process from 'node:process'

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * EP-2b package-trial worker (forked child; self-contained by design).
 *
 * Runs with `--permission --allow-fs-read=<package dir>` so this process can
 * only read the package under trial. It returns raw observations; the main
 * process performs every trust decision (see the EP-2b spec D1).
 *
 * The covered-file rules mirror `packages/descriptor.ts`
 * (`DIGEST_ROOT_FILES` / `DIGEST_ROOT_DIRS`): root `extension.airi.json` and
 * `airi-package.json`, plus `skills/**` and `assets/**`; `data/**`, `logs/**`,
 * and the derived lock file stay out. The equivalence test locks this copy to
 * the main implementation.
 */

const DIGEST_ROOT_FILES = ['extension.airi.json', 'airi-package.json']
const DIGEST_ROOT_DIRS = ['skills', 'assets']

async function listCoveredFiles(rootDir: string): Promise<string[]> {
  const files: string[] = []

  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await readdir(join(rootDir, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!relativeDir && (entry.name === 'data' || entry.name === 'logs'))
          continue
        await walk(relativePath)
        continue
      }
      if (!entry.isFile())
        continue
      const covered = DIGEST_ROOT_FILES.includes(relativePath)
        || DIGEST_ROOT_DIRS.some(dir => relativePath.startsWith(`${dir}/`))
      if (covered)
        files.push(relativePath)
    }
  }

  await walk('')
  return files.sort()
}

async function readJson(rootDir: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(rootDir, name), 'utf8'))
}

async function observe(directory: string): Promise<TrialWorkerObservation> {
  const paths = await listCoveredFiles(directory)
  const files: TrialWorkerFile[] = []
  for (const path of paths) {
    const data = await readFile(join(directory, path))
    files.push({ path, sha256: createHash('sha256').update(data).digest('hex') })
  }

  // Skill sources are returned as text; the main process computes the
  // reviewed-skill hash (`contentHashOf`) and decides every binding.
  const skillSources: TrialWorkerSkillSource[] = []
  for (const file of files) {
    const segments = file.path.split('/')
    if (segments.length === 3 && segments[0] === 'skills' && segments[2] === 'source.mjs') {
      skillSources.push({
        toolId: segments[1]!,
        source: await readFile(join(directory, file.path), 'utf8'),
      })
    }
  }

  return {
    files,
    manifestJson: await readJson(directory, 'extension.airi.json'),
    descriptorJson: await readJson(directory, 'airi-package.json'),
    skillSources,
  }
}

function send(message: WorkerToParentMessage): void {
  process.send?.(message)
}

process.on('message', (message: { type?: string, directory?: string, debug?: string }) => {
  if (message?.type === 'dispose')
    process.exit(0)

  if (message?.type !== 'run' || !message.directory)
    return

  void (async () => {
    // Acceptance-only seams: the devtools probe requests a forced crash or a
    // hang to prove containment; production callers never send `debug`.
    if (message.debug === 'crash') {
      process.exit(9)
      return
    }
    if (message.debug === 'hang') {
      setInterval(() => {}, 1_000)
      return
    }

    try {
      send({ type: 'observation', observation: await observe(message.directory!) })
      process.exit(0)
    }
    catch (error) {
      // Keep the worker dependency-free; extract the message structurally.
      const reason = (error as { message?: unknown })?.message
      send({ type: 'error', message: typeof reason === 'string' ? reason : String(error) })
      process.exit(1)
    }
  })()
})
