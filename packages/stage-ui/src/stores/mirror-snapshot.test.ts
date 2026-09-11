import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureMirrorSnapshot } from './mirror-snapshot'
import { installStageCapture } from './stage-capture'

describe('captureMirrorSnapshot', () => {
  afterEach(() => {
    installStageCapture(undefined)
    vi.restoreAllMocks()
  })

  it('degrades to no image when the stage capture surface rejects', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installStageCapture(async () => {
      throw new Error('stage surface was disposed')
    })

    await expect(captureMirrorSnapshot()).resolves.toBeNull()
    expect(warning).toHaveBeenCalledWith('[Mirror] Failed to capture the temporary frame.', expect.any(Error))
  })
})
