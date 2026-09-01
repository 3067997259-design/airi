import type { CodeModeRuntime } from '../ptc/code-mode'

import process from 'node:process'

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildSignedFileProjection } from '../hashline/read'
import { parseTextFile } from '../hashline/text'
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
  await mkdir(join(rootDir, 'src'))
  await writeFile(join(rootDir, 'adapter.ts'), 'export const MODE = "read" as const')
  await writeFile(join(rootDir, 'src', 'nested.ts'), 'export const nested = true')
  const host = createNodeWorkspaceHost(rootDir)
  const tools = createCodingTools(host, { approveBash: () => false })
  runtime = createCodeModeRuntime(tools, { timeoutMs: 5_000 })
})

afterAll(async () => {
  await rm(FIXTURE_ROOT, { recursive: true, force: true })
})

describe('coding tools over the node host', () => {
  it('lists one directory level without shell approval', async () => {
    const result = await runtime.run(`return await bridge('list', ['.'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      expect(result.value).toEqual({
        path: '.',
        entries: expect.arrayContaining([
          { name: 'adapter.ts', kind: 'file' },
          { name: 'src', kind: 'dir' },
        ]),
      })
    }
  })

  it('reads a file with signed projections', async () => {
    const result = await runtime.run(`return await bridge('read', ['adapter.ts'])`)
    expect(result).toEqual(expect.objectContaining({ ok: true }))
    if (result.ok) {
      const read = result.value as { projection: string }
      expect(read.projection).toContain('adapter.ts  (1 lines')
      expect(read.projection).toMatch(/baseHash [0-9a-f]{8}/)
      expect(read.projection).toMatch(/\n\s+1 {2}.. {2}export const MODE = "read" as const/)
    }
  })

  it('writes a whole file', async () => {
    const result = await runtime.run(`
      await bridge('write', ['fresh.ts', 'export const fresh = 1\\n', null])
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
      return await bridge('edit', ['adapter.ts', 'replace', signature, 'export const MODE', 'export const MODE = "write" as const'])
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
    const result = await runtime.run(`return await bridge('edit', ['adapter.ts', 'replace', 'zz', 'nope', 'x'])`)
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

  it('re-evaluates a function-form medium approval knob on every call', async () => {
    // A live host policy can flip the medium gate without rebuilding tools.
    let gate = false
    const host = createNodeWorkspaceHost(rootDir)
    const tools = createCodingTools(host, {
      approveBash: () => ({ approved: false }),
      mediumBashApprovalRequired: () => gate,
    })
    const runtime = createCodeModeRuntime(tools)
    const mediumCommand = 'return await bridge(\'bash\', [\'mkdir -p made-by-gate\'])'

    const withoutGate = await runtime.run(mediumCommand)
    expect(withoutGate.ok).toBe(true)
    if (withoutGate.ok)
      expect((withoutGate.value as { status: string }).status).toBe('ok')

    gate = true
    const withGate = await runtime.run(mediumCommand)
    expect(withGate.ok).toBe(true)
    if (withGate.ok) {
      const bash = withGate.value as { status: string, tier: string, reason?: string }
      expect(bash.status).toBe('denied')
      expect(bash.tier).toBe('medium')
      expect(bash.reason).toBe('approval_required')
    }
  })

  it('names the interpreter that ran the command', async () => {
    // The model has to know which syntax it is speaking; a result that hides
    // the shell makes it retry the same failing line (HARNESS-PLAN §3.5.3 C5).
    const host = createNodeWorkspaceHost(rootDir)
    const result = await host.runCommand('echo shell-check')

    expect(result.shell).toBe(host.shell.kind)
    expect(result.stdout.trim()).toBe('shell-check')
  })

  it('declares the resolved shell in the bash description', () => {
    const host = createNodeWorkspaceHost(rootDir)
    const bashTool = createCodingTools(host).find(tool => tool.name === 'bash')

    expect(bashTool?.description).toContain(host.shell.label)
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
    await expect(host.listDir('linked-outside')).rejects.toThrow(/escapes workspace/)
  })
})

describe('workspace search', () => {
  // A file long enough to cross the 500-line signature-width threshold, so a
  // hit signature that ignored the whole-file line count would not match the
  // read projection (HARNESS-PLAN §8 item 8).
  const LONG_FILE_LINES = 600

  beforeAll(async () => {
    const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => index === 420
      ? 'export const searchNeedle = "grep-target"'
      : `export const filler${index} = ${index}`)
    await writeFile(join(rootDir, 'src', 'long-file.ts'), `${lines.join('\n')}\n`)
    await writeFile(join(rootDir, 'src', 'other.md'), 'searchNeedle lives in markdown too\n')
  })

  it('signs matched lines exactly like the read projection', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    const result = await host.grep({ pattern: 'searchNeedle', glob: '*.ts' })
    const hit = result.matches.find(match => match.path === 'src/long-file.ts')

    expect(hit).toBeDefined()
    const file = await host.readFile('src/long-file.ts')
    const projection = buildSignedFileProjection(parseTextFile(file.content).lines, { limit: LONG_FILE_LINES })
    const projected = projection.find(line => line.lineNumber === hit?.lineNumber)

    expect(hit?.signature).toBe(projected?.signature)
    expect(hit?.signature).toHaveLength(3)
    expect(hit?.content).toBe(projected?.content)
  })

  it('applies the glob filter and reports the match count', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    const onlyTs = await host.grep({ pattern: 'searchNeedle', glob: '*.ts' })
    const everything = await host.grep({ pattern: 'searchNeedle' })

    expect(onlyTs.matches.every(match => match.path.endsWith('.ts'))).toBe(true)
    expect(everything.matchCount).toBeGreaterThan(onlyTs.matchCount)
  })

  it('stops at the match cap instead of returning the whole file', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    const result = await host.grep({ pattern: 'export const filler', maxMatches: 5 })

    expect(result.matchCount).toBe(5)
    expect(result.truncated).toBe(true)
  })

  it('says so when the search runs without the ripgrep binary', async () => {
    // The degraded path must announce itself; a silent downgrade makes the
    // model conclude that code it cannot find does not exist.
    const host = createNodeWorkspaceHost(rootDir, { rgPath: null })
    const result = await host.grep({ pattern: 'searchNeedle', glob: '*.ts' })
    const hit = result.matches.find(match => match.path === 'src/long-file.ts')

    expect(result.degradedReason).toBeDefined()
    expect(hit?.lineNumber).toBe(421)
    const file = await host.readFile('src/long-file.ts')
    const projection = buildSignedFileProjection(parseTextFile(file.content).lines, { limit: LONG_FILE_LINES })
    expect(hit?.signature).toBe(projection.find(line => line.lineNumber === 421)?.signature)
  })

  it('never searches outside the workspace root', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    await expect(host.grep({ pattern: 'outside', path: '../' })).rejects.toThrow(/escapes workspace/)
  })
})

describe('guarded workspace writes', () => {
  it('accepts matching hashes and rejects stale or false-new-file expectations', async () => {
    const host = createNodeWorkspaceHost(rootDir)
    const original = await host.readFile('adapter.ts')
    const originalHash = parseTextFile(original.content).baseHash

    const matching = await host.writeFileIfUnchanged('adapter.ts', 'matching content\n', originalHash)
    expect(matching.status).toBe('written')

    const stale = await host.writeFileIfUnchanged('adapter.ts', 'stale overwrite\n', originalHash)
    expect(stale).toEqual(expect.objectContaining({ status: 'state_changed' }))
    expect((await host.readFile('adapter.ts')).content).toBe('matching content\n')

    const falseNewFile = await host.writeFileIfUnchanged('adapter.ts', 'unexpected overwrite\n', null)
    expect(falseNewFile).toEqual(expect.objectContaining({ status: 'state_changed' }))

    const newFile = await host.writeFileIfUnchanged('guarded-new.ts', 'new file\n', null)
    expect(newFile.status).toBe('written')
  })
})
