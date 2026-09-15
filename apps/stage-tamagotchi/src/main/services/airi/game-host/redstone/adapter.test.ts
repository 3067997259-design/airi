import { describe, expect, it } from 'vitest'

import { createUnavailableBlueprintAdapter, LITEMATICA_ADAPTER_TOOLS } from './adapter'

describe('litematica adapter boundary', () => {
  it('reports adapter_unavailable without throwing', async () => {
    const adapter = createUnavailableBlueprintAdapter('no litematica build installed')
    await expect(adapter.capability()).resolves.toEqual({ status: 'adapter_unavailable', reason: 'no litematica build installed' })
  })

  it('returns a typed refusal from every blueprint call', async () => {
    const adapter = createUnavailableBlueprintAdapter('missing')
    await expect(adapter.loadBlueprint({ fileName: 'sugarcane.litematic' })).resolves.toEqual({ status: 'adapter_unavailable', reason: 'missing' })
    await expect(adapter.readProjection({ projectionId: 'p' })).resolves.toEqual({ status: 'adapter_unavailable', reason: 'missing' })
    await expect(adapter.removeProjection({ projectionId: 'p' })).resolves.toEqual({ status: 'adapter_unavailable', reason: 'missing' })
  })

  it('documents the exact tools a litematica build must implement', () => {
    const names = LITEMATICA_ADAPTER_TOOLS.map(tool => tool.name)
    expect(names).toEqual(['blueprint_load', 'projection_create', 'projection_status', 'projection_remove'])
    const load = LITEMATICA_ADAPTER_TOOLS.find(tool => tool.name === 'blueprint_load')
    expect(load?.parameters).toMatchObject({ required: ['fileName'], additionalProperties: false })
  })
})
