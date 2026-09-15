import type { Extension } from '@proj-airi/plugin-sdk'
import type { ExtensionLoader, ExtensionLoadOptions, ExtensionManifestV1 } from '@proj-airi/plugin-sdk/plugin-host'

import { Worker } from 'node:worker_threads'

import { useLogg } from '@guiiai/logg'
import { FileSystemLoader } from '@proj-airi/plugin-sdk/plugin-host'
import {
  createNodeWorkerContext,
  workerDisposeEvent,
  workerFailedEvent,
  workerInitializeEvent,
  workerReadyEvent,
} from '@proj-airi/plugin-sdk/plugin-host/worker'

/**
 * CP-2 node-worker extension loader.
 *
 * Extensions started with `runtime: 'node'` are loaded inside a
 * `worker_threads` worker through the SDK bootstrap; every other runtime
 * keeps the in-process filesystem loader. The host only observes the
 * `ready` / `failed` / exit signals, so a crash, throw, or infinite loop
 * stays inside the worker boundary.
 *
 * Lifecycle:
 * - spawn + handshake on load (`startupTimeoutMs`, default 5s)
 * - `setup()` runs the handshake; a pre-ready failure terminates the worker
 * - post-ready exit/error is reported through `onCrash` (the host keeps running)
 * - `disposeExtension` asks the worker to exit, then terminates after
 *   `stopGraceMs` (default 2s)
 */

export interface NodeWorkerExtensionLoaderOptions {
  /** Absolute path of the SDK worker bootstrap (`@proj-airi/plugin-sdk/plugin-host/worker-bootstrap`). */
  bootstrapPath: string
  /** Startup handshake budget before the worker is judged failed. @default 5000 */
  startupTimeoutMs?: number
  /** Grace period between the dispose request and a forced terminate. @default 2000 */
  stopGraceMs?: number
  /** Called when a worker fails after it reported ready. */
  onCrash?: (extensionId: string, error: Error) => void
  /** Test seam: spawn one worker for an entrypoint. @default worker_threads.Worker */
  spawn?: (entrypoint: string) => Worker
}

interface WorkerSession {
  worker: Worker
  context: ReturnType<typeof createNodeWorkerContext>
}

export class NodeWorkerExtensionLoader implements ExtensionLoader {
  private readonly delegate = new FileSystemLoader()
  private readonly sessions = new Map<string, WorkerSession>()
  private readonly log = useLogg('main/extension-host/worker').useGlobalConfig()
  private readonly bootstrapPath: string
  private readonly startupTimeoutMs: number
  private readonly stopGraceMs: number
  private readonly onCrash: NodeWorkerExtensionLoaderOptions['onCrash']
  private readonly spawn: (entrypoint: string) => Worker

  constructor(options: NodeWorkerExtensionLoaderOptions) {
    this.bootstrapPath = options.bootstrapPath
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5_000
    this.stopGraceMs = options.stopGraceMs ?? 2_000
    this.onCrash = options.onCrash
    this.spawn = options.spawn ?? (entrypoint => new Worker(this.bootstrapPath, { workerData: { entrypoint } }))
  }

  resolveEntrypointFor(manifest: ExtensionManifestV1, options?: ExtensionLoadOptions): string {
    return this.delegate.resolveEntrypointFor(manifest, options)
  }

  async loadExtensionFor(manifest: ExtensionManifestV1, options?: ExtensionLoadOptions): Promise<Extension> {
    // Only `runtime: 'node'` opts into worker isolation; every other runtime
    // keeps upstream behavior (in-process import).
    if (options?.runtime !== 'node')
      return await this.delegate.loadExtensionFor(manifest, options)

    const entrypoint = this.resolveEntrypointFor(manifest, options)
    const worker = this.spawn(entrypoint)
    const context = createNodeWorkerContext(worker)
    const extensionId = manifest.id
    this.sessions.set(extensionId, { worker, context })

    worker.on('error', error => this.handleCrash(extensionId, worker, error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', (code) => {
      const session = this.sessions.get(extensionId)
      if (session?.worker !== worker)
        return
      this.sessions.delete(extensionId)
      // Report directly: the session is already removed, so the guarded
      // handler would drop the crash.
      if (code !== 0)
        this.reportCrash(extensionId, new Error(`Worker extension "${extensionId}" exited with code ${code}.`))
    })

    return {
      id: extensionId,
      setup: async () => {
        try {
          await this.waitForReady(worker, context, extensionId)
        }
        catch (error) {
          await this.terminate(extensionId)
          throw error
        }
      },
    }
  }

  /** Terminates one worker; returns false when no worker session exists. */
  async disposeExtension(extensionId: string): Promise<boolean> {
    return await this.terminate(extensionId)
  }

  /** Terminates every worker session (host shutdown). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(extensionId => this.terminate(extensionId)))
  }

  private async waitForReady(worker: Worker, context: WorkerSession['context'], extensionId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const offs: Array<() => void> = []
      const cleanup = () => {
        if (timer)
          clearTimeout(timer)
        for (const off of offs) off()
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      const finish = (error?: Error) => {
        if (settled)
          return
        settled = true
        cleanup()
        if (error)
          reject(error)
        else
          resolve()
      }
      function onError(error: Error) {
        finish(error)
      }
      function onExit(code: number) {
        finish(new Error(`Worker extension "${extensionId}" exited with code ${code} before ready.`))
      }

      timer = setTimeout(
        () => finish(new Error(`Worker extension "${extensionId}" did not report ready within ${this.startupTimeoutMs}ms.`)),
        this.startupTimeoutMs,
      )
      offs.push(context.on(workerReadyEvent, () => finish()))
      offs.push(context.on(workerFailedEvent, (event) => {
        // The worker-threads adapter delivers the event envelope; the payload
        // sits on `body` (same shape the Electron bridges read).
        const body = (event as { body?: { error?: string } })?.body
        finish(new Error(body?.error ?? 'Worker extension reported failure.'))
      }))
      worker.on('error', onError)
      worker.on('exit', onExit)
      context.emit(workerInitializeEvent, undefined)
    })
  }

  private async terminate(extensionId: string): Promise<boolean> {
    const session = this.sessions.get(extensionId)
    if (!session)
      return false
    this.sessions.delete(extensionId)

    try {
      session.context.emit(workerDisposeEvent, undefined)
    }
    catch {
      // The worker may already be gone; the terminate below is the backstop.
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        session.worker.once('exit', () => resolve())
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, this.stopGraceMs)
      }),
    ])
    await session.worker.terminate().catch(() => undefined)
    return true
  }

  private reportCrash(extensionId: string, error: Error): void {
    this.log.withError(error).withFields({ extensionId }).warn('worker extension failed after start')
    this.onCrash?.(extensionId, error)
  }

  private handleCrash(extensionId: string, worker: Worker, error: Error): void {
    const session = this.sessions.get(extensionId)
    if (session?.worker !== worker)
      return
    this.sessions.delete(extensionId)
    this.reportCrash(extensionId, error)
  }
}
