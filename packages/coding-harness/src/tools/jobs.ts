/**
 * Background command jobs (HARNESS-PLAN §4.4).
 *
 * A foreground `bash` call holds the whole turn until the command exits, so
 * "start the dev server" burned two minutes of wall clock and then timed out
 * with nothing to show (§0.2 R5). A background job returns an id immediately;
 * the turn continues and the model reads output when it wants it.
 *
 * The registry owns process lifetime for the app session: output is kept in a
 * bounded buffer (a watch process would otherwise grow without limit), and
 * every job is killed on dispose so a closing app leaves no orphans.
 */
import type { WorkspaceShell } from './shell'

import process from 'node:process'

import { spawn } from 'node:child_process'

/** Output kept per job; older output is dropped, and the read says so. */
export const DEFAULT_JOB_BUFFER_CHARS = 20_000

/** Jobs kept after they finish, so a late read still finds the outcome. */
const MAX_FINISHED_JOBS = 20

export type CommandJobStatus = 'running' | 'exited' | 'killed'

export interface CommandJobSnapshot {
  jobId: string
  command: string
  status: CommandJobStatus
  exitCode?: number
  /** Combined stdout and stderr, oldest dropped first. */
  output: string
  /** Whether output was dropped from the front of the buffer. */
  truncated: boolean
  startedAt: number
}

export interface CommandJobs {
  /** Spawns a command and returns its first snapshot; never waits for exit. */
  start: (command: string) => CommandJobSnapshot
  /** Reads a job, optionally only its last `tail` characters. */
  read: (jobId: string, options?: { tail?: number }) => CommandJobSnapshot | undefined
  /** Stops a running job and its children. */
  kill: (jobId: string) => 'killed' | 'already-finished' | 'unknown'
  list: () => CommandJobSnapshot[]
  /** Kills every running job; called when the host is torn down. */
  disposeAll: () => void
}

interface JobRecord {
  jobId: string
  command: string
  status: CommandJobStatus
  exitCode?: number
  output: string
  truncated: boolean
  startedAt: number
  pid?: number
  kill: () => void
}

export interface CommandJobsOptions {
  shell: WorkspaceShell
  cwd: string
  maxBufferChars?: number
}

export function createCommandJobs(options: CommandJobsOptions): CommandJobs {
  const maxBufferChars = options.maxBufferChars ?? DEFAULT_JOB_BUFFER_CHARS
  const jobs = new Map<string, JobRecord>()
  let nextJobId = 1

  function snapshot(record: JobRecord, tail?: number): CommandJobSnapshot {
    const output = tail != null && tail > 0 ? record.output.slice(-tail) : record.output
    return {
      jobId: record.jobId,
      command: record.command,
      status: record.status,
      ...(record.exitCode != null ? { exitCode: record.exitCode } : {}),
      output,
      truncated: record.truncated || output.length < record.output.length,
      startedAt: record.startedAt,
    }
  }

  /** Drops the oldest finished jobs so a long session cannot grow unbounded. */
  function pruneFinished(): void {
    const finished = [...jobs.values()].filter(job => job.status !== 'running')
    if (finished.length <= MAX_FINISHED_JOBS)
      return
    finished
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(0, finished.length - MAX_FINISHED_JOBS)
      .forEach(job => jobs.delete(job.jobId))
  }

  return {
    start(command) {
      const jobId = `job-${nextJobId++}`
      const child = spawn(options.shell.executable, [...options.shell.commandArgs, command], {
        cwd: options.cwd,
        windowsHide: true,
        ...(options.shell.env ? { env: { ...process.env, ...options.shell.env } } : {}),
      })

      const record: JobRecord = {
        jobId,
        command,
        status: 'running',
        output: '',
        truncated: false,
        startedAt: Date.now(),
        ...(child.pid != null ? { pid: child.pid } : {}),
        kill: () => killProcessTree(child),
      }

      const append = (chunk: string): void => {
        record.output += chunk
        if (record.output.length > maxBufferChars) {
          record.output = record.output.slice(-maxBufferChars)
          record.truncated = true
        }
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', append)
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', append)
      child.on('error', (error) => {
        append(`\n[job error] ${error.message}`)
        record.status = 'exited'
        record.exitCode = 1
      })
      child.on('close', (code, signal) => {
        // A signalled close is the kill path; `kill` already set the status,
        // and an exit code would misreport a stop as a command failure.
        record.status = signal || record.status === 'killed' ? 'killed' : 'exited'
        if (record.status === 'exited')
          record.exitCode = code ?? 0
        pruneFinished()
      })

      jobs.set(jobId, record)
      return snapshot(record)
    },
    read(jobId, readOptions) {
      const record = jobs.get(jobId)
      return record ? snapshot(record, readOptions?.tail) : undefined
    },
    kill(jobId) {
      const record = jobs.get(jobId)
      if (!record)
        return 'unknown'
      if (record.status !== 'running')
        return 'already-finished'
      record.status = 'killed'
      record.kill()
      return 'killed'
    },
    list() {
      return [...jobs.values()].map(record => snapshot(record))
    },
    disposeAll() {
      for (const record of jobs.values()) {
        if (record.status === 'running') {
          record.status = 'killed'
          record.kill()
        }
      }
    },
  }
}

/**
 * Stops a spawned shell and everything it started.
 *
 * NOTICE:
 * Killing the shell alone leaves its children running: a dev server started
 * from bash keeps the port bound and the model sees a "killed" job that still
 * answers requests. POSIX handles this through the process group; Windows has
 * no group signal, so the tree is walked by taskkill /T.
 * Removal condition: none — this is the platform contract.
 */
function killProcessTree(child: { pid?: number, kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (child.pid == null) {
    child.kill()
    return
  }

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {
      child.kill()
    })
    return
  }

  child.kill('SIGTERM')
}
