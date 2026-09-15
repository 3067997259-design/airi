import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  codingApprovalDecided,
  codingApprovalRequested,
  codingHostCodeRun,
  codingHostExecRun,
  codingHostFsRead,
  codingHostListTools,
  codingHostSetWorkspaceRoot,
  planApprovalAsk,
} from '../../../../shared/eventa'
import { setupCodingHost } from './index'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function createHost() {
  const userData = await temporaryDirectory('airi-coding-host-data-')
  const firstRoot = await temporaryDirectory('airi-coding-host-first-')
  await writeFile(join(firstRoot, 'marker.txt'), 'first root\n')

  const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
  type EmitArgs = Parameters<typeof context.emit>
  const broadcast = { broadcast: vi.fn((..._args: EmitArgs) => {}), dispose: vi.fn() }

  const api = await setupCodingHost(context, { workspaceRoot: firstRoot, broadcast }, userData)

  return {
    context,
    broadcast,
    firstRoot,
    userData,
    api,
    listTools: defineInvoke(context, codingHostListTools),
    readFile: defineInvoke(context, codingHostFsRead),
    runProgram: defineInvoke(context, codingHostCodeRun),
    runCommand: defineInvoke(context, codingHostExecRun),
    askPlanApproval: defineInvoke(context, planApprovalAsk),
    setWorkspaceRoot: defineInvoke(context, codingHostSetWorkspaceRoot),
  }
}

describe('setupCodingHost workspace root', () => {
  it('rejects a skill read and invocation whose workspace was replaced', async () => {
    // ROOT CAUSE:
    // Source verification and sandbox execution use separate IPC requests.
    // A workspace switch between them could redirect relative skill IO.
    const host = await createHost()
    const expectedWorkspaceRoot = (await host.listTools()).workspaceRoot
    const secondRoot = await temporaryDirectory('airi-skill-workspace-')
    await host.setWorkspaceRoot({ root: secondRoot })

    await expect(host.readFile({ path: 'marker.txt', expectedWorkspaceRoot })).rejects.toThrow('Workspace changed')
    await expect(host.runProgram({ program: 'return 1', expectedWorkspaceRoot })).rejects.toThrow('Workspace changed')
    const result = await host.runProgram({ program: 'return 1', expectedWorkspaceRoot: (await host.listTools()).workspaceRoot })
    expect(result.ok).toBe(true)
  })

  it('switches every root-bound part, including the Code Mode runtime', async () => {
    // ROOT CAUSE:
    //
    // The host, the tool table and the Code Mode runtime each capture the
    // canonical root when they are built. Rebuilding only the host would leave
    // code_mode reading and writing the previous tree while every other tool
    // moved, and nothing in the result would say so.
    const host = await createHost()
    const secondRoot = await temporaryDirectory('airi-coding-host-second-')
    await writeFile(join(secondRoot, 'marker.txt'), 'second root\n')

    expect((await host.listTools()).tools).toContainEqual(expect.objectContaining({ name: 'setWorkspaceRoot', available: true }))

    const outcome = await host.setWorkspaceRoot({ root: secondRoot })

    expect(outcome).toMatchObject({ status: 'switched' })
    expect((await host.listTools()).workspaceRoot).toContain('airi-coding-host-second-')
    expect((await host.readFile({ path: 'marker.txt' })).content).toBe('second root\n')

    const program = await host.runProgram({ program: 'return await bridge(\'readRaw\', [\'marker.txt\'])' })
    expect(program.ok).toBe(true)
    if (program.ok)
      expect((program.value as { content: string }).content).toBe('second root\n')
  })

  it('keeps the current root when the target cannot host a workspace', async () => {
    const host = await createHost()
    const parent = await temporaryDirectory('airi-coding-host-file-')
    const filePath = join(parent, 'not-a-directory.txt')
    await writeFile(filePath, 'file\n')

    const missing = await host.setWorkspaceRoot({ root: join(parent, 'absent') })
    const notADirectory = await host.setWorkspaceRoot({ root: filePath })

    expect(missing.status).toBe('rejected')
    expect(notADirectory.status).toBe('rejected')
    expect((await host.listTools()).workspaceRoot).toContain('airi-coding-host-first-')
    expect((await host.readFile({ path: 'marker.txt' })).content).toBe('first root\n')
  })

  it('remembers a switched root for the next boot', async () => {
    const host = await createHost()
    const secondRoot = await temporaryDirectory('airi-coding-host-remembered-')
    await mkdir(join(secondRoot, 'src'), { recursive: true })

    await host.setWorkspaceRoot({ root: secondRoot })

    // A second host built on the same user-data directory, with no explicit
    // root, must come back where the user left her.
    const context = createContext<ElectronMainContextExtensions, ElectronMainEmitOptions>()
    await setupCodingHost(context, {}, host.userData)
    const listTools = defineInvoke(context, codingHostListTools)

    expect((await listTools()).workspaceRoot).toContain('airi-coding-host-remembered-')
  })
})

describe('coding approval settlement', () => {
  it('broadcasts timeout rejection and ignores a late approval', async () => {
    // ROOT CAUSE:
    // Command timeout resolved the executor without publishing a decision.
    // Other windows kept an unanswered approval card and journal entry.
    const host = await createHost()
    vi.useFakeTimers()
    const result = host.runCommand({ command: 'echo approval-test', approvalRequired: true })
    await vi.waitFor(() => expect(host.broadcast.broadcast).toHaveBeenCalledWith(
      codingApprovalRequested,
      expect.objectContaining({ requestId: 'coding-approval-1' }),
    ))
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(result).resolves.toMatchObject({ status: 'denied', requestId: 'coding-approval-1', stdout: '' })
    expect(host.broadcast.broadcast).toHaveBeenCalledWith(codingApprovalDecided, {
      requestId: 'coding-approval-1',
      decision: 'rejected',
      planId: undefined,
    })
    const count = host.broadcast.broadcast.mock.calls.length
    host.context.emit(codingApprovalDecided, { requestId: 'coding-approval-1', decision: 'approved' })
    expect(host.broadcast.broadcast).toHaveBeenCalledTimes(count)
  })

  it('settles rejection once and cancels its deadline', async () => {
    const host = await createHost()
    vi.useFakeTimers()
    const result = host.runCommand({ command: 'echo approval-test', approvalRequired: true })
    await vi.waitFor(() => expect(host.broadcast.broadcast).toHaveBeenCalledWith(
      codingApprovalRequested,
      expect.objectContaining({ requestId: 'coding-approval-1' }),
    ))
    host.context.emit(codingApprovalDecided, { requestId: 'coding-approval-1', decision: 'rejected' })
    await expect(result).resolves.toMatchObject({ status: 'denied', requestId: 'coding-approval-1' })
    expect(vi.getTimerCount()).toBe(0)
    const count = host.broadcast.broadcast.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    host.context.emit(codingApprovalDecided, { requestId: 'coding-approval-1', decision: 'approved' })
    expect(host.broadcast.broadcast).toHaveBeenCalledTimes(count)
  })

  it('times out a plan approval with a rejection and ignores a late grant', async () => {
    const host = await createHost()
    vi.useFakeTimers()
    const result = host.askPlanApproval({
      requestId: 'plan-approval-1',
      planId: 'plan-1',
      stepId: 'step-1',
      subject: 'Update the workspace',
      reason: 'The plan step needs approval.',
      riskLevel: 'high',
    })
    await vi.waitFor(() => expect(host.broadcast.broadcast).toHaveBeenCalledWith(
      codingApprovalRequested,
      expect.objectContaining({ requestId: 'plan-approval-1', planId: 'plan-1', stepId: 'step-1' }),
    ))

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(result).resolves.toEqual({ requestId: 'plan-approval-1', decision: 'rejected', planId: 'plan-1' })
    expect(host.broadcast.broadcast).toHaveBeenCalledWith(codingApprovalDecided, {
      requestId: 'plan-approval-1',
      decision: 'rejected',
      planId: 'plan-1',
    })
    const count = host.broadcast.broadcast.mock.calls.length
    host.context.emit(codingApprovalDecided, { requestId: 'plan-approval-1', decision: 'approved', planId: 'plan-1' })
    expect(host.broadcast.broadcast).toHaveBeenCalledTimes(count)
  })
})

describe('game bridge attachment (mc-1c D1)', () => {
  it('keeps game tools out of the Code Mode table until the port is attached', async () => {
    const host = await createHost()
    const before = (await host.listTools()).tools.map(tool => tool.name)
    expect(before).not.toContain('game_observe')
    expect(before).not.toContain('game_collect')

    const port = {
      isConnected: () => true,
      listTools: () => [],
      execute: vi.fn(async () => {
        throw new Error('not used')
      }),
      cancel: vi.fn(async () => {
        throw new Error('not used')
      }),
    }
    host.api.attachGameCommands(port)

    const after = (await host.listTools()).tools.map(tool => tool.name)
    expect(after).toContain('game_observe')
    expect(after).toContain('game_collect')
    expect(after).toContain('game_cancel')
    // The coding tools survive the swap.
    expect(after).toContain('read')
    expect(after).toContain('bash')
  })
})
