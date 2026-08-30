import { describe, expect, it, vi } from 'vitest'

import { createWorkspaceTriggerProvider } from './workspace-trigger-provider'

describe('createWorkspaceTriggerProvider', () => {
  it('lists the token directory and filters by its basename', async () => {
    const listDir = vi.fn(async () => [
      { name: 'components', kind: 'dir' as const },
      { name: 'chat.ts', kind: 'file' as const },
      { name: 'other.ts', kind: 'file' as const },
    ])
    const provider = createWorkspaceTriggerProvider(listDir, kind => kind)

    const sections = await provider.getSections('src/c')

    expect(listDir).toHaveBeenCalledWith('src')
    expect(sections[0]?.items).toEqual([
      expect.objectContaining({ label: 'components/', replacement: '@src/components/', continueInput: true }),
      expect.objectContaining({ label: 'chat.ts', replacement: '@src/chat.ts ' }),
    ])
  })

  it('uses the workspace root for a token without a slash', async () => {
    const listDir = vi.fn(async () => [{ name: 'README.md', kind: 'file' as const }])
    const provider = createWorkspaceTriggerProvider(listDir, kind => kind)

    await provider.getSections('read')

    expect(listDir).toHaveBeenCalledWith('.')
  })
})
