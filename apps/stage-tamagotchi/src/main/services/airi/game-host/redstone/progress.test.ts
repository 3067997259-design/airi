import { describe, expect, it } from 'vitest'

import { armControlSession, assertProjectionOwnership, createProgress, pauseProgress, ProjectionOwnershipError, recordVerifiedStep, registerTemporarySupport, resumeProgress } from './progress'

describe('construction progress', () => {
  it('removes a verified step from the pending list', () => {
    const progress = createProgress({ projectionId: 'proj', taskId: 'task', blueprintContentDigest: 'd', pending: [{ x: 1, y: 0, z: 0 }] })
    const updated = recordVerifiedStep(progress, { position: { x: 1, y: 0, z: 0 }, blockId: 'minecraft:stone' }, 100)
    expect(updated.pending).toEqual([])
    expect(updated.completed['1,0,0']).toEqual({ blockId: 'minecraft:stone', at: 100 })
  })

  it('releases the control session on pause but keeps the projection identity', () => {
    const armed = armControlSession(createProgress({ projectionId: 'proj', taskId: 'task', blueprintContentDigest: 'd' }), 'session-1')
    const paused = pauseProgress(armed, 500)
    expect(paused.lastControlSessionId).toBeUndefined()
    expect(paused.pausedAt).toBe(500)
    expect(paused.projectionId).toBe('proj')
  })

  it('resumes from the site and does not repeat a still-matching step', () => {
    const progress = registerTemporarySupport(
      recordVerifiedStep(createProgress({ projectionId: 'proj', taskId: 'task', blueprintContentDigest: 'd' }), { position: { x: 0, y: 0, z: 0 }, blockId: 'minecraft:stone' }, 1),
      { position: { x: 0, y: 1, z: 0 }, blockId: 'minecraft:dirt', forStep: { x: 0, y: 2, z: 0 } },
    )
    const report = resumeProgress(progress, {
      observed: new Map([['0,0,0', { blockId: 'minecraft:stone' }]]),
      temporarySupports: [{ x: 0, y: 1, z: 0 }],
    })
    expect(report.retained).toEqual(['0,0,0'])
    expect(report.dropped).toEqual([])
    expect(report.progress.pending).toEqual([])
    expect(report.missingSupports).toEqual([])
  })

  it('returns a changed step to pending and reports a missing support', () => {
    const progress = registerTemporarySupport(
      recordVerifiedStep(createProgress({ projectionId: 'proj', taskId: 'task', blueprintContentDigest: 'd' }), { position: { x: 0, y: 0, z: 0 }, blockId: 'minecraft:stone' }, 1),
      { position: { x: 0, y: 1, z: 0 }, blockId: 'minecraft:dirt', forStep: { x: 0, y: 2, z: 0 } },
    )
    const report = resumeProgress(progress, { observed: new Map([['0,0,0', { blockId: 'minecraft:cobblestone' }]]) })
    expect(report.dropped).toEqual(['0,0,0'])
    expect(report.progress.pending).toEqual([{ x: 0, y: 0, z: 0 }])
    expect(report.missingSupports).toEqual([{ x: 0, y: 1, z: 0 }])
  })

  it('rejects work on a projection this task does not own', () => {
    const progress = createProgress({ projectionId: 'proj-a', taskId: 'task', blueprintContentDigest: 'd' })
    expect(() => assertProjectionOwnership(progress, 'proj-b')).toThrow(ProjectionOwnershipError)
  })
})
