import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('bundled ripgrep resolution', () => {
  it('resolves the platform binary from the app runtime context', async () => {
    // ROOT CAUSE (C1, 2026-09-09):
    //
    // @vscode/ripgrep was bundled into the main chunk, so its internal
    // createRequire resolved from out/main and could not see the platform
    // package @vscode/ripgrep-win32-x64. grep therefore always reported
    // "search binary unavailable" and silently used the Node walk. The app
    // now declares the dependency and the main build keeps it external, so the
    // runtime import resolves from the app's own node_modules.
    const module = await import('@vscode/ripgrep')
    const rgPath = (module as { rgPath?: string }).rgPath
      ?? (module as { default?: { rgPath?: string } }).default?.rgPath

    expect(typeof rgPath).toBe('string')
    expect(existsSync(rgPath!)).toBe(true)
  })
})
