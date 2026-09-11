/**
 * Coding host service (WIRING-BACKLOG §2 / CODING-HARNESS-DESIGN §5).
 *
 * The Electron main-process owner of the workspace host: renders Hashline
 * file tools, approval-gated bash and the PTC (Code Mode) runtime behind the
 * `eventa:invoke:*:coding-host` contracts. Approval is mediated through
 * `codingApprovalRequested` / `codingApprovalDecided` events so any renderer
 * can host the approval card; unanswered requests time out to rejected.
 *
 * The workspace root is switchable at runtime (HARNESS-PLAN §3.5.3 C7). A
 * coding agent is pointed at a repository, so the root is state, not a boot
 * constant: `AIRI_WORKSPACE_ROOT` and the default only decide the first root,
 * a later switch persists to `<userData>/coding-host.json` and wins from then
 * on. Switching rebuilds the workspace host, the tool table and the Code Mode
 * runtime together, because each of them closes over the canonical root, and
 * rebuilding only the first would leave Code Mode running in the old tree.
 */
import type { createContext as createMainEventaContext } from '@moeru/eventa/adapters/electron/main'
import type { CodeModeRuntime, CodeModeTool, WorkspaceHost } from '@proj-airi/coding-harness'

import type { CodingApprovalDecisionPayload, CodingApprovalMode, CodingWorkspaceRootResult } from '../../../../shared/eventa'
import type { EventaWindowBroadcast } from '../../../libs/electron/eventa-window-broadcast'

import { constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from 'node:process'

import { defineInvokeHandler } from '@moeru/eventa'
import { createCodeModeRuntime, createCodingTools, createNodeWorkspaceHost, WORKSPACE_ROOT_TOOL_META } from '@proj-airi/coding-harness'

import {
  codingApprovalDecided,
  codingApprovalRequested,
  codingHostCodeRun,
  codingHostExecRun,
  codingHostFsGrep,
  codingHostFsList,
  codingHostFsRead,
  codingHostFsWrite,
  codingHostFsWriteGuarded,
  codingHostGetApprovalMode,
  codingHostJobKill,
  codingHostJobOutput,
  codingHostListTools,
  codingHostSetApprovalMode,
  codingHostSetWorkspaceRoot,
  codingWorkspaceRootChanged,
  planApprovalAsk,
} from '../../../../shared/eventa'
import { runBashCommand } from './policy'

const APPROVAL_TIMEOUT_MS = 60_000
const DEFAULT_WORKSPACE_ROOT = join(homedir(), 'AIRI-workspace')
const PERSISTED_FILE_NAME = 'coding-host.json'

export interface CodingHostOptions {
  /** Overrides the workspace root; default `~/AIRI-workspace` or `AIRI_WORKSPACE_ROOT`. */
  workspaceRoot?: string
  mediumBashApprovalRequired?: boolean
  /** Initial approval policy; the renderer can switch it live. */
  approvalMode?: CodingApprovalMode
  /** Push channel for approval cards; the plain ipc context has no sender to echo to. */
  broadcast?: EventaWindowBroadcast
  /** Overrides where the switched workspace root is remembered. */
  persistencePath?: string
}

interface PersistedCodingHost {
  workspaceRoot?: string
}

/** Reads the remembered workspace root, or nothing when none was stored. */
async function readPersistedWorkspaceRoot(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PersistedCodingHost
    return typeof parsed.workspaceRoot === 'string' && parsed.workspaceRoot.length > 0 ? parsed.workspaceRoot : undefined
  }
  catch {
    return undefined
  }
}

async function writePersistedWorkspaceRoot(path: string, workspaceRoot: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ workspaceRoot } satisfies PersistedCodingHost, null, 2), 'utf8')
  }
  catch {
    // Remembering the root is a convenience: a failed write costs the switch
    // on the next boot, never the running host.
  }
}

/**
 * Checks that a directory can host the workspace before anything is rebuilt.
 *
 * A rejected switch leaves the previous root running; the caller reports the
 * reason instead of dropping the agent into a directory it cannot write.
 */
async function validateWorkspaceRoot(root: string): Promise<{ ok: true } | { ok: false, reason: string }> {
  if (root.length === 0)
    return { ok: false, reason: 'The workspace root cannot be empty.' }

  try {
    const stats = await stat(root)
    if (!stats.isDirectory())
      return { ok: false, reason: 'The workspace root must be a directory.' }
  }
  catch {
    return { ok: false, reason: 'The workspace root does not exist.' }
  }

  try {
    await access(root, constants.W_OK)
  }
  catch {
    return { ok: false, reason: 'The workspace root is not writable.' }
  }

  return { ok: true }
}

export async function setupCodingHost(
  context: ReturnType<typeof createMainEventaContext>['context'],
  options: CodingHostOptions = {},
  userDataDir = '',
): Promise<void> {
  const persistencePath = options.persistencePath ?? join(userDataDir, PERSISTED_FILE_NAME)
  // Precedence: an explicit option (tests) beats a remembered switch, which
  // beats the environment variable, which beats the default sandbox. The
  // environment variable therefore seeds the first run and stops deciding once
  // the user has pointed her at a repository.
  const initialRoot = options.workspaceRoot
    ?? await readPersistedWorkspaceRoot(persistencePath)
    ?? env.AIRI_WORKSPACE_ROOT?.trim()
    ?? DEFAULT_WORKSPACE_ROOT

  // Approval policy owns two knobs: whether medium-tier commands need
  // approval (`substitute` mode lets them run), and whether even high-tier
  // commands auto-approve (`full` mode). Policy object stays mutable so the
  // live IPC setter and the tools' per-call reads agree.
  const policy = {
    // Mode map (CAPABILITY-PLAN §三 approval tri-state):
    // - require:    medium + high both ask
    // - substitute: medium runs, high asks (the pre-existing default)
    // - full:       nothing asks (auto-approve even high)
    mode: options.approvalMode ?? (options.mediumBashApprovalRequired ? 'require' : 'substitute') satisfies CodingApprovalMode,
  }
  const mediumRequired = () => policy.mode === 'require'
  const autoApproveAll = () => policy.mode === 'full'

  let nextRequestId = 1
  // A request ID owns one settlement. Remove it before broadcasting so echoed
  // decisions and responses after the deadline cannot settle it again.
  const pendingApprovals = new Map<string, { resolve: (decision: CodingApprovalDecisionPayload['decision']) => void, planId?: string, timeout?: ReturnType<typeof setTimeout> }>()

  function settleApproval({ requestId, decision }: CodingApprovalDecisionPayload) {
    const pending = pendingApprovals.get(requestId)
    // The request already ended, or this response belongs to another host.
    if (!pending)
      return
    pendingApprovals.delete(requestId)
    if (pending.timeout !== undefined)
      clearTimeout(pending.timeout)
    pending.resolve(decision)
    // Re-broadcast so every window's journal records the decision (the plan
    // evidence gate reads the leader window's journal, the click may happen
    // in any window). Journal dedupe keeps single-window appends singular.
    ;(options.broadcast?.broadcast ?? context.emit)(codingApprovalDecided, { requestId, decision, planId: pending.planId })
  }

  context.on(codingApprovalDecided, (event) => {
    if (event.body)
      settleApproval(event.body)
  })

  /** Ask every renderer for approval; unanswered requests reject to denied. */
  const approve = async (tier: 'read-only' | 'medium' | 'high', command: string): Promise<{ approved: boolean, requestId: string }> => {
    if (autoApproveAll())
      return { approved: true, requestId: `auto-approval-${nextRequestId++}` }
    const requestId = `coding-approval-${nextRequestId++}`
    const decision = await new Promise<CodingApprovalDecisionPayload['decision']>((resolve) => {
      const timeout = setTimeout(settleApproval, APPROVAL_TIMEOUT_MS, { requestId, decision: 'rejected' })
      pendingApprovals.set(requestId, { resolve, timeout })
      ;(options.broadcast?.broadcast ?? context.emit)(codingApprovalRequested, {
        requestId,
        subject: command,
        reason: `Bash command requires approval (${tier} risk tier)`,
        riskLevel: tier === 'high' ? 'high' : 'medium',
        expectedEvidence: 'tool_result (command output)',
      })
    })
    return { approved: decision === 'approved', requestId }
  }

  /**
   * One workspace root and everything bound to it.
   *
   * The host, the tool table and the Code Mode runtime each capture the
   * canonical root when they are created, so a switch replaces all three at
   * once. Handlers read `workspace` per call rather than capturing it.
   */
  interface CodingWorkspace {
    root: string
    host: WorkspaceHost
    tools: CodeModeTool[]
    codeRuntime: CodeModeRuntime
  }

  async function createWorkspace(root: string): Promise<CodingWorkspace> {
    await mkdir(root, { recursive: true })
    const host = createNodeWorkspaceHost(root)
    const tools = createCodingTools(host, {
      approveBash: approve,
      mediumBashApprovalRequired: mediumRequired,
    })
    return { root, host, tools, codeRuntime: createCodeModeRuntime(tools) }
  }

  let workspace = await createWorkspace(initialRoot)

  defineInvokeHandler(context, codingHostSetApprovalMode, async ({ mode }) => {
    policy.mode = mode
  })

  // Plan-step approval uses the same timeout and decision broadcast as bash.
  // The decision loops back through every window's approvals
  // bridge, which journals approval/asked + approval/decided for the gate.
  defineInvokeHandler(context, planApprovalAsk, async ({ requestId, planId, stepId, subject, reason, riskLevel }) => {
    const decision = await new Promise<CodingApprovalDecisionPayload['decision']>((resolve) => {
      const timeout = setTimeout(settleApproval, APPROVAL_TIMEOUT_MS, { requestId, decision: 'rejected' })
      pendingApprovals.set(requestId, { resolve, planId, timeout })
      ;(options.broadcast?.broadcast ?? context.emit)(codingApprovalRequested, {
        requestId,
        subject,
        reason,
        riskLevel,
        expectedEvidence: 'human_approval (plan step)',
        planId,
        stepId,
      })
    })
    return { requestId, decision, planId }
  })

  defineInvokeHandler(context, codingHostGetApprovalMode, () => ({ mode: policy.mode }))

  defineInvokeHandler(context, codingHostFsRead, async ({ path, expectedWorkspaceRoot }) => {
    if (expectedWorkspaceRoot !== undefined && expectedWorkspaceRoot !== workspace.root)
      throw new Error('Workspace changed before the artifact read.')
    return workspace.host.readFile(path)
  })

  defineInvokeHandler(context, codingHostFsList, async ({ path }) => ({ entries: await workspace.host.listDir(path) }))

  defineInvokeHandler(context, codingHostFsGrep, async query => workspace.host.grep(query))

  defineInvokeHandler(context, codingHostFsWrite, async ({ path, content }) => {
    await workspace.host.writeFile(path, content)
    return { ok: true }
  })

  defineInvokeHandler(context, codingHostFsWriteGuarded, async ({ path, content, baseHash }) =>
    workspace.host.writeFileIfUnchanged(path, content, baseHash))

  defineInvokeHandler(context, codingHostSetWorkspaceRoot, async ({ root }): Promise<CodingWorkspaceRootResult> => {
    const target = root.trim()
    const validation = await validateWorkspaceRoot(target)
    if (!validation.ok)
      return { status: 'rejected', workspaceRoot: workspace.root, reason: validation.reason }

    // Jobs belong to the root they started in; leaving them running after a
    // switch would hide processes in a tree nothing points at any more.
    workspace.host.jobs.disposeAll()
    workspace = await createWorkspace(target)
    await writePersistedWorkspaceRoot(persistencePath, workspace.root)
    // Switching the root is a session-level fact, not a silent setting: the
    // renderer journals it so the model learns the ground moved under it.
    ;(options.broadcast?.broadcast ?? context.emit)(codingWorkspaceRootChanged, { workspaceRoot: workspace.root })
    return { status: 'switched', workspaceRoot: workspace.root }
  })

  defineInvokeHandler(context, codingHostExecRun, async ({ command, mediumApprovalRequired, approvalRequired, runInBackground, timeoutMs }) => {
    void timeoutMs
    return runBashCommand(command, {
      host: workspace.host,
      approve,
      mediumApprovalRequired: mediumApprovalRequired ?? mediumRequired(),
      approvalRequired,
      ...(runInBackground ? { runInBackground } : {}),
    })
  })

  defineInvokeHandler(context, codingHostJobOutput, async ({ jobId, tail }) =>
    workspace.host.jobs.read(jobId, tail != null ? { tail } : undefined) ?? { jobId, status: 'unknown' as const })

  defineInvokeHandler(context, codingHostJobKill, async ({ jobId }) => ({
    jobId,
    outcome: workspace.host.jobs.kill(jobId),
  }))

  defineInvokeHandler(context, codingHostCodeRun, async ({ program, timeoutMs, expectedWorkspaceRoot }) => {
    if (expectedWorkspaceRoot !== undefined && expectedWorkspaceRoot !== workspace.root)
      throw new Error('Workspace changed before skill execution.')
    // The runtime captures this workspace for the entire program. Later root
    // switches cannot redirect bridge calls from an already running skill.
    return workspace.codeRuntime.run(program, timeoutMs ? { timeoutMs } : undefined)
  })

  defineInvokeHandler(context, codingHostListTools, async () => ({
    workspaceRoot: workspace.root,
    // The renderer builds the model-facing bash description from this, so the
    // declared shell and the process that runs commands stay the same fact.
    shell: { kind: workspace.host.shell.kind, label: workspace.host.shell.label, syntax: workspace.host.shell.syntax },
    tools: [
      ...workspace.tools.map(tool => ({ name: tool.name, description: tool.description, available: true })),
      // Root switching is a renderer-facing control-plane tool. It is not a
      // Code Mode bridge because the latter captures one immutable host per
      // program; the normal tool calls the runtime handler that rebuilds all
      // root-bound services together.
      { name: WORKSPACE_ROOT_TOOL_META.name, description: WORKSPACE_ROOT_TOOL_META.description, available: true },
      // The PTC runtime is host-level rather than a bridge capability, so it
      // is listed separately; renderers gate registration on this entry.
      { name: 'code_mode', description: 'Run a sandboxed program that dispatches the coding tools through bridge().', available: true },
    ],
  }))
}
