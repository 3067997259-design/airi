import { describe, expect, it } from 'vitest'

import { validateToolInput, validateToolInputSchema } from './input-validation'

// ROOT CAUSE:
//
// `validateSchemaNode` checked the type of the keywords it knew and silently
// ignored every other keyword, while `validateValue` only enforced the subset
// it implemented. A reviewed schema that declared `uniqueItems: true` was
// accepted, and `{ items: ['a', 'a'] }` still reached the sandbox. The schema
// shown to the model was therefore stricter than the execution boundary.
//
// We fixed this by declaring the supported keyword set explicitly, enforcing
// `uniqueItems`, `minProperties`, `maxProperties`, and `multipleOf`, and
// rejecting every keyword outside the set instead of ignoring it.

const uniqueItemsSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'string' }, uniqueItems: true },
  },
  required: ['items'],
}

describe('validateToolInputSchema', () => {
  it('accepts the supported subset', () => {
    expect(validateToolInputSchema(uniqueItemsSchema)).toBeUndefined()
  })

  it('accepts annotation keywords', () => {
    const schema = {
      type: 'object',
      title: 'Dedupe',
      description: 'Trim and deduplicate.',
      properties: {
        items: { type: 'array', items: { type: 'string' }, default: [], examples: [['a']] },
      },
      required: ['items'],
    }
    expect(validateToolInputSchema(schema)).toBeUndefined()
  })

  it('rejects a keyword the validator cannot enforce', () => {
    const error = validateToolInputSchema({
      type: 'object',
      properties: { name: { type: 'string', format: 'email' } },
    })
    expect(error).toContain('parameters.properties.name.format')
    expect(error).toContain('not enforced')
  })

  it('rejects a combinator keyword', () => {
    const error = validateToolInputSchema({
      type: 'object',
      properties: { name: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    })
    expect(error).toContain('oneOf')
    expect(error).toContain('not enforced')
  })

  it('rejects a non-boolean uniqueItems', () => {
    const error = validateToolInputSchema({
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'string' }, uniqueItems: 'yes' } },
    })
    expect(error).toContain('uniqueItems must be a boolean')
  })

  it('rejects a non-positive multipleOf', () => {
    const error = validateToolInputSchema({
      type: 'object',
      properties: { count: { type: 'number', multipleOf: 0 } },
    })
    expect(error).toContain('multipleOf must be a positive number')
  })
})

describe('validateToolInput', () => {
  it('rejects duplicate array entries declared by uniqueItems', () => {
    const error = validateToolInput(uniqueItemsSchema, { items: ['a', 'a'] })
    expect(error).toBe('input.items[1] duplicates input.items[0] and uniqueItems is required.')
  })

  it('accepts distinct array entries', () => {
    expect(validateToolInput(uniqueItemsSchema, { items: ['a', 'b'] })).toBeUndefined()
  })

  it('rejects null for an object schema with no required fields', () => {
    const error = validateToolInput({ type: 'object', properties: {} }, null)
    expect(error).toBe('input must be an object.')
  })

  it('rejects undefined for an object schema with no required fields', () => {
    const error = validateToolInput({ type: 'object', properties: {} }, undefined)
    expect(error).toBe('input must be an object.')
  })

  it('enforces minProperties and maxProperties', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, minProperties: 2, maxProperties: 2 }
    expect(validateToolInput(schema, { a: 'x' })).toContain('at least 2')
    expect(validateToolInput(schema, { a: 'x', b: 'y', c: 'z' })).toContain('at most 2')
    expect(validateToolInput(schema, { a: 'x', b: 'y' })).toBeUndefined()
  })

  it('enforces multipleOf', () => {
    const schema = { type: 'object', properties: { count: { type: 'number', multipleOf: 5 } }, required: ['count'] }
    expect(validateToolInput(schema, { count: 7 })).toBe('input.count must be a multiple of 5.')
    expect(validateToolInput(schema, { count: 15 })).toBeUndefined()
  })

  it('rejects an unsupported keyword through the value entry point', () => {
    const error = validateToolInput({ type: 'object', properties: { name: { type: 'string', patternProperties: {} } } }, { name: 'x' })
    expect(error).toContain('invalid input schema')
    expect(error).toContain('patternProperties')
  })
})
