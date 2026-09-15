import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertDeclarativeManifest,
  computePackageDigest,
  listPackageFiles,
  PackageDescriptorInvalidError,
  PackageDigestMismatchError,
  PackageEntrypointForbiddenError,
  parsePackageDescriptor,
  verifyPackageDigest,
} from './descriptor'

const descriptor = {
  packageVersion: 1,
  id: 'demo-pack',
  version: '1.0.0',
  tools: [{
    name: 'demo_tool',
    description: 'Demo tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    skill: { toolId: 'acc-20260909-dedupe', contentHash: 'abc123' },
  }],
}

describe('ep-2a package descriptor', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'airi-package-descriptor-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeFixture() {
    await writeFile(join(root, 'extension.airi.json'), JSON.stringify({ apiVersion: 'v1', id: 'demo-pack', kind: 'manifest.extension.airi.moeru.ai', permissions: {}, entrypoints: {} }))
    await writeFile(join(root, 'airi-package.json'), JSON.stringify(descriptor))
    await mkdir(join(root, 'skills', 'acc-20260909-dedupe'), { recursive: true })
    await writeFile(join(root, 'skills', 'acc-20260909-dedupe', 'source.mjs'), 'export const run = () => 1\n')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'assets', 'panel.html'), '<html></html>')
    await mkdir(join(root, 'data'), { recursive: true })
    await writeFile(join(root, 'data', 'state.json'), '{"private":true}')
    await writeFile(join(root, 'airi-package.lock.json'), '{"derived":true}')
  }

  it('covers only the declared surface and stays order-stable', async () => {
    await writeFixture()

    const files = await listPackageFiles(root)
    expect(files).toEqual([
      'airi-package.json',
      'assets/panel.html',
      'extension.airi.json',
      'skills/acc-20260909-dedupe/source.mjs',
    ])

    const first = await computePackageDigest(root)
    const second = await computePackageDigest(root)
    expect(second.digest).toBe(first.digest)
    expect(first.files.map(file => file.path)).toEqual(files)
  })

  it('ignores private data changes but detects approved-surface changes', async () => {
    await writeFixture()
    const approved = (await computePackageDigest(root)).digest

    await writeFile(join(root, 'data', 'state.json'), '{"private":false}')
    expect((await computePackageDigest(root)).digest).toBe(approved)

    await writeFile(join(root, 'assets', 'panel.html'), '<html>changed</html>')
    const changed = (await computePackageDigest(root)).digest
    expect(changed).not.toBe(approved)
    await expect(verifyPackageDigest(root, approved)).rejects.toBeInstanceOf(PackageDigestMismatchError)
  })

  it('rejects manifests that declare runtime entrypoints', () => {
    expect(() => assertDeclarativeManifest({ entrypoints: {} })).not.toThrow()
    expect(() => assertDeclarativeManifest({ entrypoints: { electron: './main.mjs' } }))
      .toThrow(PackageEntrypointForbiddenError)
  })

  it('parses a valid descriptor and rejects a broken one', () => {
    expect(parsePackageDescriptor(descriptor).tools).toHaveLength(1)
    expect(() => parsePackageDescriptor({ ...descriptor, tools: [] })).not.toThrow()
    expect(() => parsePackageDescriptor({ ...descriptor, id: '' })).toThrow(PackageDescriptorInvalidError)
    expect(() => parsePackageDescriptor({ packageVersion: 2 })).toThrow(PackageDescriptorInvalidError)
  })
})
