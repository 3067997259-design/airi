import { describe, expect, it } from 'vitest'

import { base32Encode, fnv1a32, lineSignature, signatureLengthForLineCount } from './signature'

describe('hashline signature', () => {
  it('is deterministic for the same content', () => {
    const content = 'const flags = parseArgs(rawArgs)'
    expect(fnv1a32(content)).toBe(fnv1a32(content))
    expect(lineSignature(content, { lineCount: 87 })).toBe(lineSignature(content, { lineCount: 87 }))
  })

  it('depends on line content, not on position', () => {
    const a = lineSignature('export async function run() {', { lineCount: 87 })
    const b = lineSignature('export async function run() {', { lineCount: 200 })
    // Same content, different file sizes may differ only in width — not in the
    // content digest itself.
    const digestA = fnv1a32('export async function run() {')
    const digestB = fnv1a32('export async function stop() {')
    expect(digestA).not.toBe(digestB)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
  })

  it('distinguishes lines that differ only in whitespace', () => {
    expect(fnv1a32('const a = 1')).not.toBe(fnv1a32('const a = 1 '))
    expect(fnv1a32('a\nb')).not.toBe(fnv1a32('a\nc'))
  })

  it('adapts width to file size: 2 / 3 / 4 chars', () => {
    expect(signatureLengthForLineCount(499)).toBe(2)
    expect(signatureLengthForLineCount(500)).toBe(3)
    expect(signatureLengthForLineCount(3_999)).toBe(3)
    expect(signatureLengthForLineCount(4_000)).toBe(4)
    expect(lineSignature('x', { lineCount: 4_200 })).toHaveLength(4)
  })

  it('emits only base32 alphabet characters', () => {
    for (let i = 0; i < 200; i++) {
      const signature = lineSignature(`line ${i} with some body`, { lineCount: 87 })
      expect(signature).toMatch(/^[2-7a-z]+$/)
    }
  })

  it('encodes precise bit groups, least significant first', () => {
    // value 0b00011_00010_00011: groups 3, 2, 3 → alphabet[3]='5', [2]='4', [3]='5'
    expect(base32Encode(3 + 2 * 32 + 3 * 32 * 32, 3)).toBe('545')
    expect(base32Encode(0, 3)).toBe('222')
  })
})
