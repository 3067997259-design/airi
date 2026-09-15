import type { ExtensionManifestV1 } from '../../../shared/types'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileSystemLoader } from './fs'

function manifest(entrypoint: string): ExtensionManifestV1 {
  return {
    apiVersion: 'v1',
    entrypoints: { electron: entrypoint },
    id: 'absolute-entry',
    kind: 'manifest.extension.airi.moeru.ai',
    permissions: {},
  }
}

describe('file system loader', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  })

  // ROOT CAUSE:
  //
  // `loadExtensionFor` passed the resolved absolute path straight to
  // `import()`. On Windows the default ESM loader rejects `C:\...` with
  // "Only URLs with a scheme in: file, data, node, and electron are
  // supported", so no on-disk extension could load in the packaged app.
  //
  // We fixed this by converting absolute entrypoints to `file://` URLs.
  it('loads an absolute entrypoint through a file URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-fs-loader-'))
    directories.push(directory)
    const entrypoint = join(directory, 'entry.mjs')
    await writeFile(entrypoint, 'export const id = "absolute-entry"\nexport function setup() {}\n')

    const extension = await new FileSystemLoader().loadExtensionFor(manifest(entrypoint), { cwd: directory })
    expect(extension.id).toBe('absolute-entry')
  })
})
