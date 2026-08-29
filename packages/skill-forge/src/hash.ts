/**
 * Review binding hashes (SELF-AUTHORED-TOOLS-DESIGN §5 contentHash).
 *
 * A double FNV-1a 32-bit (two seeds concatenated as 16 hex chars) — cheap,
 * environment-free, and sized for honest diff detection. This is not
 * adversarial cryptography: the threat model is weak-model slips, not
 * deliberate forgery (SELF-AUTHORED-TOOLS-DESIGN §9.1).
 */
export const CONTENT_HASH_SEED_A = 0x811C9DC5
export const CONTENT_HASH_SEED_B = 0x01000193

function fnv1a(input: string, seed: number): number {
  let hash = seed
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
    hash >>>= 0
  }
  return hash
}

/**
 * Content hash for review binding: any diff in the hashed source changes
 * the result with overwhelming probability for honest edits.
 *
 * @example
 * contentHashOf('const x = 1') // => 'c91c4dd1fcd7dcae'
 */
export function contentHashOf(source: string): string {
  const a = fnv1a(source, CONTENT_HASH_SEED_A).toString(16).padStart(8, '0')
  const b = fnv1a(source, CONTENT_HASH_SEED_B).toString(16).padStart(8, '0')
  return `${a}${b}`
}
