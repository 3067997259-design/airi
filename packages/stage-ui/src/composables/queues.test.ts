import { describe, expect, it, vi } from 'vitest'

import { useDelayMessageQueue } from './queues'

describe('useDelayMessageQueue', () => {
  it('accepts the space form taught by the bundled prompts', async () => {
    const delayListener = vi.fn()
    const queue = useDelayMessageQueue()
    queue.onHandlerEvent('delay', delayListener)

    await queue.enqueue('<|DELAY 1|>')

    expect(delayListener).toHaveBeenCalledWith(1)
  })

  it('still accepts the legacy colon form', async () => {
    const delayListener = vi.fn()
    const queue = useDelayMessageQueue()
    queue.onHandlerEvent('delay', delayListener)

    await queue.enqueue('<|DELAY:1|>')

    expect(delayListener).toHaveBeenCalledWith(1)
  })

  it('ignores content without a delay token', async () => {
    const delayListener = vi.fn()
    const queue = useDelayMessageQueue()
    queue.onHandlerEvent('delay', delayListener)

    await queue.enqueue('plain text with no delay marker')

    expect(delayListener).not.toHaveBeenCalled()
  })
})
