import { describe, expect, it, vi } from 'vitest'

import { applyCustomFocus } from './custom-focus'

function createWriter() {
  const values = new Map<string, number>()
  const setParameterValueById = vi.fn((id: string, value: number) => {
    values.set(id, value)
  })
  return { values, coreModel: { setParameterValueById } }
}

describe('applyCustomFocus', () => {
  it('writes axis values scaled by gain', () => {
    const { coreModel, values } = createWriter()

    applyCustomFocus(coreModel, 0.5, -0.25, [
      { id: 'ParamEyeBallX', axis: 'x', gain: 1, enabled: true },
      { id: 'ParamEyeBallY', axis: 'y', gain: 1, enabled: true },
      { id: 'ParamAngleX', axis: 'x', gain: 30, enabled: true },
      { id: 'ParamBodyAngleX', axis: 'x', gain: 10, enabled: true },
    ])

    expect(values.get('ParamEyeBallX')).toBe(0.5)
    expect(values.get('ParamEyeBallY')).toBe(-0.25)
    expect(values.get('ParamAngleX')).toBe(15)
    expect(values.get('ParamBodyAngleX')).toBe(5)
  })

  it('multiplies both axes for xy entries and honors negative gains', () => {
    const { coreModel, values } = createWriter()

    applyCustomFocus(coreModel, 0.5, 0.5, [
      { id: 'ParamAngleZ', axis: 'xy', gain: -30, enabled: true },
    ])

    expect(values.get('ParamAngleZ')).toBe(-7.5)
  })

  it('skips disabled entries', () => {
    const { coreModel, values } = createWriter()

    applyCustomFocus(coreModel, 1, 1, [
      { id: 'ParamEyeBallX', axis: 'x', gain: 1, enabled: false },
      { id: 'ParamAngleX', axis: 'x', gain: 30, enabled: true },
    ])

    expect(values.has('ParamEyeBallX')).toBe(false)
    expect(values.get('ParamAngleX')).toBe(30)
  })

  it('keeps written values within the gain envelope for extreme focus', () => {
    const { coreModel, values } = createWriter()

    applyCustomFocus(coreModel, 1, -1, [
      { id: 'ParamEyeBallX', axis: 'x', gain: 0.4, enabled: true },
      { id: 'ParamAngleZ', axis: 'xy', gain: -30, enabled: true },
    ])

    expect(values.get('ParamEyeBallX')).toBeLessThanOrEqual(0.4)
    expect(values.get('ParamEyeBallX')).toBeGreaterThanOrEqual(-0.4)
    expect(values.get('ParamAngleZ')).toBeLessThanOrEqual(30)
    expect(values.get('ParamAngleZ')).toBeGreaterThanOrEqual(-30)
  })
})
