import { Worker } from 'node:worker_threads'

import { afterEach, describe, expect, it } from 'vitest'

import { createPluginContext } from './index'

describe('createPluginContext (node runtime)', () => {
  const workers: Worker[] = []

  afterEach(async () => {
    await Promise.all(workers.splice(0).map(worker => worker.terminate()))
  })

  it('creates an in-memory context and implements the node-worker branch (cp-2)', () => {
    expect(() => createPluginContext({ kind: 'in-memory' })).not.toThrow()

    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
    workers.push(worker)
    const context = createPluginContext({ kind: 'node-worker', worker })
    expect(context).toBeDefined()
  })

  it('keeps the remaining transports explicit', () => {
    expect(() => createPluginContext({ kind: 'websocket', url: 'ws://127.0.0.1:1' }))
      .toThrow(/not implemented/)
    expect(() => createPluginContext({ kind: 'web-worker', worker: {} as never }))
      .toThrow(/not available/)
  })
})
