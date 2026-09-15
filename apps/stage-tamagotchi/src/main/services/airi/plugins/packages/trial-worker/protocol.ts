/**
 * EP-2b package-trial worker protocol (parent <-> forked child).
 *
 * The worker only observes untrusted content: covered-file enumeration,
 * per-file sha256, `JSON.parse` of the two JSON files, and the reviewed-skill
 * source texts. Every trust decision (schema validation, skill binding,
 * digest assembly, lock write) stays in the main process.
 */

/** One covered file and its byte hash, as observed by the worker. */
export interface TrialWorkerFile {
  path: string
  sha256: string
}

export interface TrialWorkerSkillSource {
  toolId: string
  source: string
}

/** Raw observations the main process turns into a trial result. */
export interface TrialWorkerObservation {
  files: TrialWorkerFile[]
  manifestJson: unknown
  descriptorJson: unknown
  skillSources: TrialWorkerSkillSource[]
}

export type ParentToWorkerMessage
  = | { type: 'run', directory: string, debug?: 'crash' | 'hang' }
    | { type: 'dispose' }

export type WorkerToParentMessage
  = | { type: 'observation', observation: TrialWorkerObservation }
    | { type: 'error', message: string }
