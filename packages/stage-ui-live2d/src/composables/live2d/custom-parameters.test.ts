import { describe, expect, it, vi } from 'vitest'

import { discoverCustomParameters, isSystemManagedParameter, useMotionUpdatePluginCustomParameters } from './custom-parameters'

function createCoreModel(table?: { ids: string[], min?: number[], max?: number[], def?: number[] }) {
  return {
    getModel: () => ({
      parameters: table
        ? {
            ids: table.ids,
            minimumValues: table.min ?? table.ids.map(() => -1),
            maximumValues: table.max ?? table.ids.map(() => 1),
            defaultValues: table.def ?? table.ids.map(() => 0),
          }
        : undefined,
    }),
  }
}

describe('isSystemManagedParameter', () => {
  it('flags built-in controls and physics pendulums', () => {
    expect(isSystemManagedParameter('ParamAngleX')).toBe(true)
    expect(isSystemManagedParameter('ParamEyeBallX')).toBe(true)
    expect(isSystemManagedParameter('Param_Angle_Rotation_1_ArtMesh237')).toBe(true)
    expect(isSystemManagedParameter('HairBList')).toBe(false)
    expect(isSystemManagedParameter('pupilList1')).toBe(false)
  })
})

describe('discoverCustomParameters', () => {
  it('merges core ranges with cdi display names and groups', () => {
    const catalog = discoverCustomParameters(
      {
        Parameters: [
          { Id: 'HairBList', Name: '后发发型切换', GroupId: 'Group1' },
          { Id: 'ParamAngleX', Name: '角度 X', GroupId: 'Group1' },
        ],
        ParameterGroups: [{ Id: 'Group1', Name: '发型' }],
      },
      createCoreModel({
        ids: ['HairBList', 'ParamAngleX', 'UnnamedToggle'],
        min: [0, -30, 0],
        max: [3, 30, 1],
        def: [0, 0, 0],
      }),
    )

    expect(catalog.parameters).toHaveLength(2) // ParamAngleX excluded
    const hair = catalog.parameters.find(p => p.id === 'HairBList')!
    expect(hair.name).toBe('后发发型切换')
    expect(hair.groupId).toBe('Group1')
    expect(hair.min).toBe(0)
    expect(hair.max).toBe(3)
    const unnamed = catalog.parameters.find(p => p.id === 'UnnamedToggle')!
    expect(unnamed.name).toBe('UnnamedToggle')
    expect(unnamed.groupId).toBeNull()
    expect(catalog.groups).toEqual([{ id: 'Group1', name: '发型' }])
  })

  it('falls back to heuristic ranges without a core table', () => {
    const catalog = discoverCustomParameters(
      { Parameters: [{ Id: 'earlist', Name: '耳朵切换' }] },
      createCoreModel(undefined),
    )

    expect(catalog.parameters).toEqual([
      { id: 'earlist', name: '耳朵切换', groupId: null, min: -1, max: 1, default: 0 },
    ])
  })
})

describe('useMotionUpdatePluginCustomParameters', () => {
  it('re-asserts enabled overrides and skips disabled ones', () => {
    const setParameterValueById = vi.fn()
    const store = {
      valuesFor: (modelId: string | undefined) => {
        expect(modelId).toBe('model-a')
        return {
          HairBList: { value: 2, enabled: true },
          earlist: { value: 1, enabled: false },
        }
      },
    }

    const plugin = useMotionUpdatePluginCustomParameters(store as never, 'model-a')
    plugin({ model: { setParameterValueById } } as never)

    expect(setParameterValueById).toHaveBeenCalledTimes(1)
    expect(setParameterValueById).toHaveBeenCalledWith('HairBList', 2)
  })
})
