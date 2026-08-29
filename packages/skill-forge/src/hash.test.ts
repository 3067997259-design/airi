import { describe, expect, it } from 'vitest'

import { contentHashOf } from './hash'

describe('skill content hash', () => {
  it('is stable for identical source', () => {
    const source = 'export async function run() { return "ok" }'
    expect(contentHashOf(source)).toBe(contentHashOf(source))
  })

  it('changes for any honest diff', () => {
    const base = 'const x = 1'
    const variants = [
      'const x = 2',
      'const x = 1 ',
      'const x = 1\n',
      'const xy = 1',
      'const x=1',
    ]
    for (const variant of variants) {
      expect(contentHashOf(base)).not.toBe(contentHashOf(variant))
    }
  })

  it('yields a stable 16-hex form', () => {
    const hash = contentHashOf('anything')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('varies with UTF-16 code units so sibling chinese strings differ', () => {
    expect(contentHashOf('云吞')).not.toBe(contentHashOf('云呑'))
  })
})
