import { describe, expect, it } from 'vitest'

import { classifyTouchdown } from './touchdown'

const reference = { x: 0, y: 64, z: 0 }

describe('classifyTouchdown', () => {
  it('accepts a settled on-ground contact', () => {
    const outcome = classifyTouchdown({ position: { x: 1, y: 64, z: 0 }, onGround: true, motion: { x: 0.1, y: 0, z: 0 }, fallFlying: false }, reference)
    expect(outcome.kind).toBe('landed')
  })

  it('does not accept a still-active glide', () => {
    const outcome = classifyTouchdown({ position: { x: 1, y: 64, z: 0 }, onGround: false, motion: { x: 0, y: 0, z: 0 }, fallFlying: true }, reference)
    expect(outcome.kind).toBe('still-flying')
  })

  it('keeps a missing read unknown instead of a landing', () => {
    expect(classifyTouchdown(undefined, reference).kind).toBe('unknown')
    expect(classifyTouchdown({ onGround: true, position: undefined }, reference).kind).toBe('unknown')
  })

  it('keeps a read without onGround unknown', () => {
    expect(classifyTouchdown({ position: { x: 0, y: 64, z: 0 } }, reference).kind).toBe('unknown')
  })

  it('detects a fall when the glide stopped in the air', () => {
    const outcome = classifyTouchdown({ position: { x: 0, y: 30, z: 0 }, onGround: false, fallFlying: false }, reference)
    expect(outcome.kind).toBe('lost-flight')
  })

  it('reports water as its own outcome', () => {
    const outcome = classifyTouchdown({ position: { x: 0, y: 64, z: 0 }, onGround: true, inWater: true }, reference)
    expect(outcome.kind).toBe('water')
  })

  it('refuses a contact with too much residual speed', () => {
    const outcome = classifyTouchdown({ position: { x: 0, y: 64, z: 0 }, onGround: true, motion: { x: 0.9, y: 0, z: 0 } }, reference)
    expect(outcome.kind).toBe('unsettled')
  })

  it('refuses a contact far from the aimed point', () => {
    const outcome = classifyTouchdown({ position: { x: 40, y: 64, z: 0 }, onGround: true, motion: { x: 0, y: 0, z: 0 } }, reference)
    expect(outcome.kind).toBe('unsettled')
  })
})
