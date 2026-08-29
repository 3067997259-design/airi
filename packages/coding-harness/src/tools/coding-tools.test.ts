import type { CodeModeRuntime } from '../ptc/code-mode'

import process from 'node:process'

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCodeModeRuntime } from '../ptc/code-mode'
import { createCodingTools } from './coding-tools'
import { createNodeWorkspaceHost } from './workspace-host'

// Sandboxed shells may not write to the OS temp dir; keep the fixture inside
// the workspace so every environment can run the suite.
const FIXTURE_ROOT = join(fileURLToPath(new URL('../../', import.meta.url)), '.tmp-tests')

let rootDir: string
let outsideDir: string
let runtime: CodeModeRuntime

beforeAll(async () => {
  await mkdir(FIXTURE_ROOT, { recursive: true })
  rootDir = await mkdtemp(join(FIXTURE_ROOT, 'workspace-'))
  outsideDir = await mkdtemp(join(FIXTURE_ROOT, 'outside-'))
  await writeFile(join(rootDir, 'adapter.ts'), 'export const MODE = "read" as const')
  const host = createNodeWorkspaceHost(rootDir)
  const tools = createCodingTools(host, { approveBash: () => false })
  runtime = createCodeModeRuntime(tools, { timeoutMs: 5_000 })
})

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true })
})

describe('coding tools over the node host', () => {
  it('reads a file with signed projections', async () => {
    const result = await runtime.run(`return await bridge('read', ['adapter.ts'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const read = result.value as { projection: string }
      expect(read.projection).toContain('adapter.ts  (1 行')
      expect(read.projection).toMatch(/\n\s+1 {2}.. {2}export const MODE = "read" as const/)
    }
  })

  it('writes a whole file', async () => {
    const result = await runtime.run(`
      await bridge('write', ['fresh.ts', 'export const fresh = 1\\n'])
      return await bridge('read', ['fresh.ts'])
    `)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
  })

  it('edits one line through its content signature', async () => {
    const result = await runtime.run(`
      const read = await bridge('read', ['adapter.ts'])
      const lines = read.projection.split('\\n')
      const target = lines[1]
      const signature = target.trim().split('  ')[1]
      return await bridge('edit', ['adapter.ts', signature, 'export const MODE', 'export const MODE = "write" as const'])
    `)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const edit = result.value as { result: { status: string } }
      expect(edit.result.status).toBe('applied')
    }
    const after = await runtime.run(`return await bridge('read', ['adapter.ts'])`)
    if (after.ok)
      expect((after.value as { projection: string }).projection).toContain('"write" as const')
  })

  it('rejects an edit when the signature no longer matches (state_changed)', async () => {
    const result = await runtime.run(`return await bridge('edit', ['adapter.ts', 'zz', 'nope', 'x'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const edit = result.value as { result: { status: string } }
      expect(edit.result.status).toBe('state_changed')
    }
  })

  it('runs read-only bash without approval', async () => {
    const result = await runtime.run(`return await bridge('bash', ['echo hello-workspace'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const bash = result.value as { status: string, stdout: string }
      expect(bash.status).toBe('ok')
      expect(bash.stdout.trim()).toBe('hello-workspace')
    }
  })

  it('denies high-tier bash without approval', async () => {
    const result = await runtime.run(`return await bridge('bash', ['git push origin main'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const bash = result.value as { status: string, tier: string, reason?: string }
      expect(bash.status).toBe('denied')
      expect(bash.tier).toBe('high')
      expect(bash.reason).toBe('approval_required')
    }
  })

  it('returns structured command output for allowed commands', async () => {
    const result = await runtime.run(`return await bridge('bash', ['node --version'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const bash = result.value as { stdout: string }
      expect(bash.stdout).toMatch(/^v\d+/)
    }
  })
})

describe('workspace path containment', () => {
  it('rejects absolute escapes and parent traversal', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    await expect(host.readFile(join(rootDir, '..', 'secret.txt'))).rejects.toThrow(/escapes workspace/)
    await expect(host.readFile('../../../etc/passwd')).rejects.toThrow(/escapes workspace/)
  })

  it('allows absolute paths inside the root', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    const read = await host.readFile(join(rootDir, 'adapter.ts'))
    expect(read.content).toContain('export const MODE')
  })

  it('rejects a workspace link that resolves outside the root', async () => {
    await writeFile(join(outsideDir, 'secret.txt'), 'outside')
    await symlink(outsideDir, join(rootDir, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir')
    const host = createNodeWorkspaceHost(rootDir)

    await expect(host.readFile('linked-outside/secret.txt')).rejects.toThrow(/escapes workspace/)
    await expect(host.writeFile('linked-outside/new.txt', 'outside')).rejects.toThrow(/escapes workspace/)
  })
})
