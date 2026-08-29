/**
 * Hashline content signatures (CODING-HARNESS-DESIGN §2.4).
 *
 * A signature is a short, content-derived tag for one line of a file; the
 * model references the signature instead of reproducing the line verbatim.
 * Hashing uses UTF-16 code units so behavior is identical in Node and
 * browsers without an encoder dependency.
 *
 * The signature space is sized against honest mistakes, not forgery
 * (threat model: weak-model optimism and slips, per the design doc §8.3),
 * so FNV-1a over 10-20 bits is sufficient and cheap.
 */

const BASE32_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'

const FNV_OFFSET_BASIS = 0x811C9DC5
const FNV_PRIME = 0x01000193

/** FNV-1a 32-bit over the UTF-16 code units of a string, unsigned. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME)
    hash >>>= 0
  }
  return hash
}

/**
 * Encodes the low `length` 5-bit groups of a 32-bit value with the base32
 * alphabet, least significant group first. Deterministic across engines;
 * not randomized.
 *
 * @example
 * base32Encode(3 + 2 * 32 + 3 * 32 * 32, 3) // => '545'
 */
export function base32Encode(value: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++)
    out += BASE32_ALPHABET[(value >>> (i * 5)) & 31]
  return out
}

/**
 * Signature width by file size: `< 500` lines → 2 chars (10 bit),
 * `< 4_000` lines → 3 chars (15 bit), otherwise 4 chars (20 bit).
 * Thresholds live here so calibration only touches one spot.
 */
export function signatureLengthForLineCount(lineCount: number): 2 | 3 | 4 {
  if (lineCount < 500)
    return 2
  if (lineCount < 4_000)
    return 3
  return 4
}

export interface LineSignatureOptions {
  lineCount: number
}

/**
 * Content signature for one line within a file of `lineCount` lines.
 * Line content only — insertions and deletions elsewhere never invalidate
 * the remaining signatures.
 *
 * @example
 * lineSignature('const flags = parseArgs(rawArgs)', { lineCount: 87 })
 * // => 'z9p'
 */
export function lineSignature(content: string, options: LineSignatureOptions): string {
  const length = signatureLengthForLineCount(options.lineCount)
  return base32Encode(fnv1a32(content), length)
}
