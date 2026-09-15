import type { ChildProcess } from 'node:child_process'

import type { TrialWorkerObservation } from './protocol'

import { fork } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * EP-2b package-trial worker client.
 *
 * One forked child per trial, run with the Node permission model limited to
 * reading the package directory and this worker file. A crash, an
 * unparseable package, or a hang costs at most one child process: the host
 * observes a typed failure and stays up. `dispose()` bounds termination
 * (dispose request -> grace -> kill).
 */

/** Resolved next to the bundle chunk; the build emits `package-trial-worker.ts` there. */
const TRIAL_WORKER_ENTRY_PATH = realpathSync(fileURLToPath(new URL('./package-trial-worker.ts', import.meta.url)))

export type PackageTrialFailureReason = 'cancelled' | 'crash' | 'protocol' | 'timeout' | 'worker-error'

/** Raised when a trial worker fails or exceeds its budget. */
export class PackageTrialWorkerError extends Error {
  readonly reason: PackageTrialFailureReason

  constructor(reason: PackageTrialFailureReason, detail: string) {
    super(`Package trial worker failed (${reason}): ${detail}`)
    this.name = 'PackageTrialWorkerError'
    this.reason = reason
  }
}

export interface PackageTrialRunInput {
  /** Absolute package version directory under trial. */
  directory: string
  /** Execution budget for read + hash + parse. @default 30000 */
  timeoutMs?: number
  /** Acceptance-only seam; production callers never send it. */
  debug?: 'crash' | 'hang'
}

/** Runs one package trial; the default implementation forks a confined child. */
export interface PackageTrialRunner {
  run: (input: PackageTrialRunInput) => Promise<TrialWorkerObservation>
  /**
   * Stops the running trial within the configured grace (EP-2b cancellation).
   * Returns whether a trial was running.
   */
  dispose?: () => Promise<boolean>
}

export interface PackageTrialWorkerClientOptions {
  /** Execution budget for one trial. @default 30000 */
  trialTimeoutMs?: number
  /** Grace between the dispose request and a forced kill. @default 2000 */
  stopGraceMs?: number
}

export class PackageTrialWorkerClient implements PackageTrialRunner {
  private readonly trialTimeoutMs: number
  private readonly stopGraceMs: number
  private current?: { child: ChildProcess, cancelled: boolean }

  constructor(options: PackageTrialWorkerClientOptions = {}) {
    this.trialTimeoutMs = options.trialTimeoutMs ?? 30_000
    this.stopGraceMs = options.stopGraceMs ?? 2_000
  }

  async run(input: PackageTrialRunInput): Promise<TrialWorkerObservation> {
    const directory = realpathSync(input.directory)
    const workerDirectory = dirname(TRIAL_WORKER_ENTRY_PATH)
    const child = fork(TRIAL_WORKER_ENTRY_PATH, [], {
      cwd: workerDirectory,
      env: {},
      // Confinement: the child may only read the package under trial and the
      // worker source itself; no network, no other fs reads.
      execArgv: [
        '--permission',
        `--allow-fs-read=${directory}`,
        `--allow-fs-read=${workerDirectory}`,
        '--experimental-transform-types',
        '--disable-proto=throw',
        '--no-warnings',
      ],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const session = { child, cancelled: false }
    this.current = session

    try {
      return await new Promise<TrialWorkerObservation>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (error?: Error, observation?: TrialWorkerObservation) => {
          if (settled)
            return
          settled = true
          if (timer)
            clearTimeout(timer)
          if (this.current === session)
            this.current = undefined
          if (error)
            reject(error)
          else
            resolve(observation as TrialWorkerObservation)
        }

        timer = setTimeout(() => {
          child.kill()
          finish(new PackageTrialWorkerError('timeout', `no observation within ${input.timeoutMs ?? this.trialTimeoutMs}ms`))
        }, input.timeoutMs ?? this.trialTimeoutMs)

        child.on('message', (message: { type?: string, observation?: TrialWorkerObservation, message?: string }) => {
          if (session.cancelled)
            return
          if (message?.type === 'observation' && message.observation)
            finish(undefined, message.observation)
          else if (message?.type === 'error')
            finish(new PackageTrialWorkerError('worker-error', message.message ?? 'unknown worker error'))
        })
        child.on('error', error => finish(new PackageTrialWorkerError('crash', error.message)))
        child.on('exit', (code) => {
          if (session.cancelled) {
            finish(new PackageTrialWorkerError('cancelled', 'trial was cancelled'))
            return
          }
          if (code === 0)
            finish(new PackageTrialWorkerError('protocol', 'worker exited without an observation'))
          else
            finish(new PackageTrialWorkerError('crash', `worker exited with code ${code}`))
        })

        child.send({ type: 'run', directory, ...(input.debug ? { debug: input.debug } : {}) })
      })
    }
    catch (error) {
      if (this.current === session)
        this.current = undefined
      throw error
    }
  }

  /**
   * Stops the running trial within the grace window.
   *
   * The in-flight `run` settles with a typed `cancelled` failure; the caller
   * (uninstall / explicit cancel) does not wait for an observation once
   * disposed.
   */
  async dispose(): Promise<boolean> {
    const session = this.current
    if (!session)
      return false
    session.cancelled = true
    this.current = undefined
    try {
      session.child.send({ type: 'dispose' })
    }
    catch {
      // The child may already be gone; the kill below is the backstop.
    }
    await Promise.race([
      new Promise<void>((resolve) => {
        session.child.once('exit', () => resolve())
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, this.stopGraceMs)
      }),
    ])
    session.child.kill()
    return true
  }
}
