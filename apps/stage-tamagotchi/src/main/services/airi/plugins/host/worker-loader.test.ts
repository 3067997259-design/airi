import type { ExtensionManifestV1 } from '@proj-airi/plugin-sdk/plugin-host'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NodeWorkerExtensionLoader } from './worker-loader'

const requireForTest = createRequire(import.meta.url)
const eventaWorkerUrl = pathToFileURL(requireForTest.resolve('@moeru/eventa/adapters/worker-threads/worker')).href
const pluginHostUrl = pathToFileURL(requireForTest.resolve('@proj-airi/plugin-sdk/plugin-host')).href

function manifest(entrypoint: string, runtime: 'node' | 'electron' = 'node'): ExtensionManifestV1 {
  return {
    apiVersion: 'v1',
    entrypoints: { [runtime]: entrypoint },
    id: 'worker-fixture',
    kind: 'manifest.extension.airi.moeru.ai',
    permissions: {},
  }
}

/**
 * Writes a protocol worker fixture. `onInitialize` runs when the host asks the
 * worker to initialize; `onDispose` defaults to a clean exit.
 */
async function writeWorkerFixture(
  dir: string,
  name: string,
  input: { onInitialize: string, onDispose?: string },
): Promise<string> {
  const source = [
    `import { createContext } from ${JSON.stringify(eventaWorkerUrl)}`,
    `import { workerDisposeEvent, workerFailedEvent, workerInitializeEvent, workerReadyEvent } from ${JSON.stringify(pluginHostUrl)}`,
    'const { context } = createContext()',
    `context.on(workerInitializeEvent, async () => { ${input.onInitialize} })`,
    `context.on(workerDisposeEvent, () => { ${input.onDispose ?? 'process.exit(0)'} })`,
  ].join('\n')
  const path = join(dir, name)
  await writeFile(path, source)
  return path
}

describe('nodeWorkerExtensionLoader', () => {
  let fixtureDir: string
  let workers: Worker[]
  let loader: NodeWorkerExtensionLoader

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'airi-worker-loader-'))
    workers = []
    loader = new NodeWorkerExtensionLoader({
      bootstrapPath: 'unused-with-injected-spawn',
      startupTimeoutMs: 400,
      stopGraceMs: 120,
      spawn: (entrypoint) => {
        const worker = new Worker(entrypoint, { workerData: { entrypoint } })
        workers.push(worker)
        return worker
      },
    })
  })

  afterEach(async () => {
    await loader.disposeAll()
    await Promise.all(workers.splice(0).map(worker => worker.terminate()))
    await rm(fixtureDir, { recursive: true, force: true })
  })

  it('resolves setup after the worker reports ready and terminates on dispose', async () => {
    await writeWorkerFixture(fixtureDir, 'ready.mjs', {
      onInitialize: `context.emit(workerReadyEvent, { extensionId: 'worker-fixture' })`,
    })

    const extension = await loader.loadExtensionFor(manifest('./ready.mjs'), { cwd: fixtureDir, runtime: 'node' })
    await expect(extension.setup({} as never)).resolves.toBeUndefined()

    expect(await loader.disposeExtension('worker-fixture')).toBe(true)
    expect(await loader.disposeExtension('worker-fixture')).toBe(false)
  })

  it('rejects setup when the worker reports failed', async () => {
    await writeWorkerFixture(fixtureDir, 'failed.mjs', {
      onInitialize: `context.emit(workerFailedEvent, { error: 'fixture failed' })`,
    })

    const extension = await loader.loadExtensionFor(manifest('./failed.mjs'), { cwd: fixtureDir, runtime: 'node' })
    await expect(extension.setup({} as never)).rejects.toThrow('fixture failed')
  })

  it('rejects setup when the worker crashes before ready', async () => {
    await writeWorkerFixture(fixtureDir, 'crash.mjs', {
      onInitialize: `process.exit(3)`,
    })

    const extension = await loader.loadExtensionFor(manifest('./crash.mjs'), { cwd: fixtureDir, runtime: 'node' })
    await expect(extension.setup({} as never)).rejects.toThrow(/exited with code 3/)
  })

  it('rejects setup when the worker never reports ready', async () => {
    await writeWorkerFixture(fixtureDir, 'hang.mjs', {
      onInitialize: `void 0`,
    })

    const extension = await loader.loadExtensionFor(manifest('./hang.mjs'), { cwd: fixtureDir, runtime: 'node' })
    await expect(extension.setup({} as never)).rejects.toThrow(/did not report ready within 400ms/)
  })

  it('forcibly terminates a worker that ignores the dispose request', async () => {
    const fixture = await writeWorkerFixture(fixtureDir, 'stubborn.mjs', {
      onInitialize: `context.emit(workerReadyEvent, { extensionId: 'worker-fixture' })`,
      onDispose: 'void 0',
    })
    const extension = await loader.loadExtensionFor(manifest('./stubborn.mjs'), { cwd: fixtureDir, runtime: 'node' })
    await extension.setup({} as never)
    const worker = workers.at(-1)!

    const startedAt = Date.now()
    expect(await loader.disposeExtension('worker-fixture')).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await vi.waitFor(() => expect((worker as { exitCode?: number | null }).exitCode).not.toBeNull())
    expect(fixture).toContain('stubborn.mjs')
  })

  it('reports a post-ready crash without stopping the host', async () => {
    await writeWorkerFixture(fixtureDir, 'late-crash.mjs', {
      onInitialize: `context.emit(workerReadyEvent, { extensionId: 'worker-fixture' }); setTimeout(() => process.exit(4), 20)`,
    })
    const onCrash = vi.fn()
    loader = new NodeWorkerExtensionLoader({
      bootstrapPath: 'unused-with-injected-spawn',
      startupTimeoutMs: 400,
      stopGraceMs: 120,
      onCrash,
      spawn: (entrypoint) => {
        const worker = new Worker(entrypoint, { workerData: { entrypoint } })
        workers.push(worker)
        return worker
      },
    })

    const extension = await loader.loadExtensionFor(manifest('./late-crash.mjs'), { cwd: fixtureDir, runtime: 'node' })
    await extension.setup({} as never)

    await vi.waitFor(() => expect(onCrash).toHaveBeenCalledTimes(1))
    expect(onCrash.mock.calls[0]?.[0]).toBe('worker-fixture')
  })

  it('delegates non-node runtimes to the in-process loader', async () => {
    await writeFile(join(fixtureDir, 'direct.mjs'), 'export const id = "worker-fixture"\nexport function setup() {}\n')

    const extension = await loader.loadExtensionFor(manifest('./direct.mjs', 'electron'), { cwd: fixtureDir, runtime: 'electron' })
    expect(extension.id).toBe('worker-fixture')
  })
})
