import { describe, expect, it } from 'vitest'

import { applyHashlineEdit } from './edit'
import { lineSignature } from './signature'

function fixture(lines: string[]): { lines: string[], signature: (line: string) => string } {
  const sign = (line: string) => lineSignature(line, { lineCount: lines.length })
  return { lines, signature: sign }
}

describe('hashline edit', () => {
  it('applies a whole-line replacement by signature', () => {
    const { lines, signature } = fixture([
      'export async function run() {',
      '  const flags = parseArgs(rawArgs)',
      '}',
    ])
    const target = lines[1]!
    const outcome = applyHashlineEdit({
      lines,
      signature: signature(target),
      expectedPrefix: '  const flags',
      newLineContent: '  const flags = parseArgs(rawArgs, { strict: false })',
    })
    expect(outcome.result).toEqual({ status: 'applied', lineNumber: 2, signature: signature(target) })
    expect(outcome.lines[1]).toBe('  const flags = parseArgs(rawArgs, { strict: false })')
    expect(outcome.lines[0]).toBe(lines[0])
    expect(outcome.lines[2]).toBe(lines[2])
  })

  it('keeps other lines\' signatures valid after an edit (content-based, not position-based)', () => {
    const before = [
      'export async function run() {',
      '  const flags = parseArgs(rawArgs)',
      '  if (flags.help) return printHelp()',
      '}',
    ]
    const { signature: signBefore } = fixture(before)
    const sigOfLine1 = signBefore(before[0]!) // 2-char sig from the 4-line file

    const result = applyHashlineEdit({
      lines: before,
      signature: signBefore(before[2]!),
      expectedPrefix: '  if (flags.help)',
      newLineContent: '  if (flags.help) return printHelp(true)',
    })
    expect(result.result.status).toBe('applied')

    // Insertion happened above line 1; line 1's content is unchanged, and a
    // re-read with the NEW line count still matches line 1's content
    // signature — the signature belongs to content, not to a row.
    const after = result.lines
    const sigAfter = (line: string) => lineSignature(line, { lineCount: after.length })
    expect(sigAfter(after[0]!)).toBe(sigOfLine1)
  })

  it('rejects with state_changed and current candidates when the signature is gone', () => {
    const { lines, signature } = fixture([
      'export async function run() {',
      '  const flags = parseArgs(rawArgs)',
      '}',
    ])
    const outcome = applyHashlineEdit({
      lines,
      signature: 'zz',
      expectedPrefix: '  const flags',
      newLineContent: 'x',
    })
    expect(outcome.result.status).toBe('state_changed')
    if (outcome.result.status === 'state_changed') {
      expect(outcome.result.candidates.map(candidate => candidate.signature)).toContain(signature(lines[1]!))
    }
    expect(outcome.lines).toBe(lines)
  })

  it('rejects ambiguous matches instead of guessing', () => {
    const duplicated = [
      '  repeat = true',
      '  repeat = true',
      '}',
    ]
    const { signature } = fixture(duplicated)
    const outcome = applyHashlineEdit({
      lines: duplicated,
      signature: signature(duplicated[0]!),
      expectedPrefix: '  repeat',
      newLineContent: '  repeat = false',
    })
    expect(outcome.result).toEqual({ status: 'ambiguous', lineNumbers: [1, 2] })
    expect(outcome.lines).toBe(duplicated)
  })

  it('rejects prefix mismatch, returning the surviving signature', () => {
    const { lines, signature } = fixture([
      'export async function run() {',
      '  const flags = parseArgs(rawArgs)',
      '}',
    ])
    const target = lines[1]!
    const outcome = applyHashlineEdit({
      lines,
      signature: signature(target),
      expectedPrefix: '  const FLAGS', // the signed line exists but no longer starts like this
      newLineContent: 'x',
    })
    expect(outcome.result).toEqual({
      status: 'prefix_mismatch',
      lineNumber: 2,
      currentSignature: signature(target),
    })
    expect(outcome.lines).toBe(lines)
  })

  it('matches case-sensitively on the prefix', () => {
    const { lines, signature } = fixture(['seed'])
    const outcome = applyHashlineEdit({
      lines,
      signature: signature('seed'),
      expectedPrefix: 'SEED',
      newLineContent: 'changed',
    })
    expect(outcome.result.status).toBe('prefix_mismatch')
  })

  it('requires a non-empty expected prefix', () => {
    const { lines, signature } = fixture(['seed'])
    expect(() => applyHashlineEdit({
      lines,
      signature: signature('seed'),
      expectedPrefix: '',
      newLineContent: 'changed',
    })).toThrow(/expectedPrefix/)
  })

  it('handles unicode line content in signatures and replacement', () => {
    const { lines, signature } = fixture(['参数：云吞', '其它'])
    const outcome = applyHashlineEdit({
      lines,
      signature: signature(lines[0]!),
      expectedPrefix: '参数',
      newLineContent: '参数：云吞（已修复）',
    })
    expect(outcome.result.status).toBe('applied')
    expect(outcome.lines[0]).toBe('参数：云吞（已修复）')
  })
})
