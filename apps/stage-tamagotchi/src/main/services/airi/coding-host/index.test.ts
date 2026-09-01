import type { ElectronMainContextExtensions, ElectronMainEmitOptions } from '@moeru/eventa/adapters/electron/main'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext, defineInvoke } from '@moeru/eventa'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  codingHostCodeRun,
  codingHostFsRead,
  codingHostListTools,
  codingHostSetWorkspaceRoot,
} from '../../../../shared/eventa'
import { setupCodingHost } from './index'

const temporaryDirectories: string[] = []

afterEach(async () => {
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

  await setupCodingHost(context, { workspaceRoot: firstRoot, broadcast }, userData)

  return {
    broadcast,
    firstRoot,
    userData,
    listTools: defineInvoke(context, codingHostListTools),
    readFile: defineInvoke(context, codingHostFsRead),
    runProgram: defineInvoke(context, codingHostCodeRun),
    setWorkspaceRoot: defineInvoke(context, codingHostSetWorkspaceRoot),
  }
}

describe('setupCodingHost workspace root', () => {
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
