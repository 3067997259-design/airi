type JsonObject = Record<string, unknown>

const JSON_SCHEMA_TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string'])

/**
 * JSON Schema keywords reviewed skill validation understands.
 *
 * Reviewed skills run through a validator that only enforces this subset. A
 * keyword outside the set is rejected instead of ignored: a schema that looks
 * stricter than the execution boundary teaches the model a constraint that the
 * sandbox never applies. Add a keyword here only together with enforcement in
 * {@link validateValue}.
 */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  // Annotations carry no assertion; they are safe to accept and ignore.
  '$comment',
  '$id',
  '$schema',
  'default',
  'deprecated',
  'description',
  'examples',
  'readOnly',
  'title',
  'writeOnly',
  // Structure.
  'additionalProperties',
  'items',
  'properties',
  'required',
  'type',
  // Value assertions.
  'const',
  'enum',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'pattern',
  'uniqueItems',
])

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function propertyPath(path: string, key: string): string {
  return /^[a-z_$][\w$]*$/i.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`
}

function arrayPath(path: string, index: number): string {
  return `${path}[${index}]`
}

function typeLabel(type: string): string {
  if (type === 'array' || type === 'object')
    return `an ${type}`
  return `a ${type}`
}

function validateSchemaNode(value: unknown, path: string, root: boolean): string | undefined {
  if (!isObject(value))
    return `${path} must be a JSON Schema object.`

  for (const key of Object.keys(value)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key))
      return `${path}.${key} is not enforced by reviewed skill validation. Remove it or use a supported keyword.`
  }

  const type = value.type
  if (typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type))
    return `${path}.type must be one of ${[...JSON_SCHEMA_TYPES].join(', ')}.`
  if (root && type !== 'object')
    return 'tool parameters must use an object schema.'

  const properties = value.properties
  if (properties !== undefined) {
    if (type !== 'object' || !isObject(properties))
      return `${path}.properties must be an object on an object schema.`
    for (const [key, child] of Object.entries(properties)) {
      const error = validateSchemaNode(child, propertyPath(`${path}.properties`, key), false)
      if (error)
        return error
    }
  }

  const required = value.required
  if (required !== undefined) {
    if (type !== 'object' || !Array.isArray(required) || required.some(item => typeof item !== 'string'))
      return `${path}.required must be a string array on an object schema.`
    const propertyNames = new Set(Object.keys(isObject(properties) ? properties : {}))
    const missing = required.find(key => !propertyNames.has(key))
    if (missing !== undefined)
      return `${path}.required contains unknown property "${missing}".`
  }

  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean')
    return `${path}.additionalProperties must be a boolean.`

  const items = value.items
  if (items !== undefined) {
    if (type !== 'array')
      return `${path}.items is only supported on an array schema.`
    const error = validateSchemaNode(items, `${path}.items`, false)
    if (error)
      return error
  }

  const enumValues = value.enum
  if (enumValues !== undefined && !Array.isArray(enumValues))
    return `${path}.enum must be an array.`

  if (value.const !== undefined && typeof value.const === 'function')
    return `${path}.const must be JSON data.`

  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean')
    return `${path}.uniqueItems must be a boolean.`

  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'minProperties', 'maxProperties']) {
    const constraint = value[key]
    if (constraint !== undefined && typeof constraint !== 'number')
      return `${path}.${key} must be a number.`
  }

  if (value.multipleOf !== undefined && (typeof value.multipleOf !== 'number' || value.multipleOf <= 0))
    return `${path}.multipleOf must be a positive number.`

  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string')
      return `${path}.pattern must be a string.`
    try {
      const compiledPattern = new RegExp(value.pattern)
      compiledPattern.test('')
    }
    catch {
      return `${path}.pattern must be a valid regular expression.`
    }
  }

  return undefined
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right))
    return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]))
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]))
  }
  return false
}

function validateValue(schema: JsonObject, value: unknown, path: string): string | undefined {
  const type = schema.type as string
  const matches = type === 'null'
    ? value === null
    : type === 'array'
      ? Array.isArray(value)
      : type === 'object'
        ? isObject(value)
        : type === 'integer'
          ? typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type
  if (!matches)
    return `${path} must be ${typeLabel(type)}.`

  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => sameJsonValue(candidate, value)))
    return `${path} must match one of the declared values.`
  if (schema.const !== undefined && !sameJsonValue(schema.const, value))
    return `${path} must match the declared value.`

  if (type === 'object') {
    if (!isObject(value))
      return `${path} must be an object.`
    const properties = isObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!Object.hasOwn(value, key))
        return `${propertyPath(path, key)} is required.`
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find(key => !Object.hasOwn(properties, key))
      if (extra !== undefined)
        return `${propertyPath(path, extra)} is not allowed.`
    }
    const propertyCount = Object.keys(value).length
    if (typeof schema.minProperties === 'number' && propertyCount < schema.minProperties)
      return `${path} must contain at least ${schema.minProperties} propert(y|ies).`
    if (typeof schema.maxProperties === 'number' && propertyCount > schema.maxProperties)
      return `${path} must contain at most ${schema.maxProperties} propert(y|ies).`
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || !isObject(child))
        continue
      const error = validateValue(child, value[key], propertyPath(path, key))
      if (error)
        return error
    }
  }

  if (type === 'array') {
    if (!Array.isArray(value))
      return `${path} must be an array.`
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      return `${path} must contain at least ${schema.minItems} item(s).`
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      return `${path} must contain at most ${schema.maxItems} item(s).`
    if (schema.uniqueItems === true) {
      for (let index = 0; index < value.length; index++) {
        for (let other = index + 1; other < value.length; other++) {
          if (sameJsonValue(value[index], value[other]))
            return `${arrayPath(path, other)} duplicates ${arrayPath(path, index)} and uniqueItems is required.`
        }
      }
    }
    if (isObject(schema.items)) {
      for (const [index, item] of value.entries()) {
        const error = validateValue(schema.items, item, arrayPath(path, index))
        if (error)
          return error
      }
    }
  }

  if (type === 'string') {
    if (typeof value !== 'string')
      return `${path} must be a string.`
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      return `${path} must contain at least ${schema.minLength} character(s).`
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      return `${path} must contain at most ${schema.maxLength} character(s).`
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      return `${path} must match the declared pattern.`
  }

  if ((type === 'number' || type === 'integer')) {
    if (typeof value !== 'number')
      return `${path} must be a number.`
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      return `${path} must be at least ${schema.minimum}.`
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      return `${path} must be at most ${schema.maximum}.`
    if (typeof schema.multipleOf === 'number') {
      const quotient = value / schema.multipleOf
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9)
        return `${path} must be a multiple of ${schema.multipleOf}.`
    }
  }

  return undefined
}

/**
 * Checks the JSON Schema subset supported by reviewed skill calls.
 *
 * Reviewed skill parameters must be a typed object schema. Nested object and
 * array properties use the same primitive types, required fields, and
 * additional-property policy at runtime. A keyword outside
 * {@link SUPPORTED_SCHEMA_KEYWORDS} is rejected because reviewed skill
 * validation cannot enforce it.
 */
export function validateToolInputSchema(schema: unknown): string | undefined {
  return validateSchemaNode(schema, 'parameters', true)
}

/**
 * Validates one reviewed skill invocation against its approved parameters.
 *
 * @example
 * validateToolInput({ type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } }, { items: ['ok', 1] })
 * // => 'input.items[1] must be a string.'
 */
export function validateToolInput(schema: unknown, input: unknown): string | undefined {
  const schemaError = validateToolInputSchema(schema)
  if (schemaError)
    return `invalid input schema: ${schemaError}`
  return validateValue(schema as JsonObject, input, 'input')
}
