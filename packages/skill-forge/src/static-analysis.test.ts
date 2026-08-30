import type { StaticFindings } from './static-analysis'

import { describe, expect, it } from 'vitest'

import { analyzeSkillSource, classifyToolRisk, validateDeclaration } from './static-analysis'

function findings(overrides: Partial<StaticFindings> = {}): StaticFindings {
  return {
    networkEgress: false,
    workspaceWrites: false,
    subprocess: false,
    readOnlySubprocess: false,
    credentialedAccess: false,
    destructiveOps: false,
    ...overrides,
  }
}

describe('tool risk classification', () => {
  it('marks pure computation as low', () => {
    expect(classifyToolRisk(findings())).toBe('low')
  })

  it('marks workspace writes and read-only subprocess as medium', () => {
    expect(classifyToolRisk(findings({ workspaceWrites: true }))).toBe('medium')
    expect(classifyToolRisk(findings({ subprocess: true, readOnlySubprocess: true }))).toBe('medium')
  })

  it('marks network, credentials, destructive ops and arbitrary subprocess as high', () => {
    expect(classifyToolRisk(findings({ networkEgress: true }))).toBe('high')
    expect(classifyToolRisk(findings({ credentialedAccess: true }))).toBe('high')
    expect(classifyToolRisk(findings({ destructiveOps: true }))).toBe('high')
    expect(classifyToolRisk(findings({ subprocess: true, readOnlySubprocess: false }))).toBe('high')
  })

  it('high wins over medium when both apply', () => {
    expect(classifyToolRisk(findings({ workspaceWrites: true, networkEgress: true }))).toBe('high')
  })
})

describe('declaration validation', () => {
  it('accepts a declaration matching the findings', () => {
    const check = validateDeclaration(
      findings({ workspaceWrites: true }),
      { workspaceWrites: true },
    )
    expect(check.consistent).toBe(true)
    expect(check.mismatches).toEqual([])
  })

  it('rejects capabilities found but not declared', () => {
    const check = validateDeclaration(
      findings({ networkEgress: true }),
      { networkEgress: false },
    )
    expect(check.consistent).toBe(false)
    expect(check.mismatches).toEqual(['networkEgress: found by static analysis but not declared'])
  })

  it('rejects capabilities declared but not found', () => {
    const check = validateDeclaration(
      findings(),
      { subprocess: true },
    )
    expect(check.consistent).toBe(false)
    expect(check.mismatches).toEqual(['subprocess: declared but not found'])
  })

  // ROOT CAUSE:
  //
  // Omitted declaration axes were skipped. A tool with network egress could
  // therefore submit an empty declaration and enter the review queue.
  it('treats omitted capabilities as denied', () => {
    const check = validateDeclaration(
      findings({ networkEgress: true }),
      {},
    )
    expect(check.consistent).toBe(false)
    expect(check.mismatches).toEqual(['networkEgress: found by static analysis but not declared'])
  })
})

describe('analyzeSkillSource', () => {
  it('flags network egress on fetch/http call sites', () => {
    const result = analyzeSkillSource('export async function run(input) { return await fetch(\'https://api.example.com/x\', { headers: { authorization: \'Bearer mytoken\' } }) }')
    expect(result.networkEgress).toBe(true)
    expect(result.workspaceWrites).toBe(false)
  })

  it('flags workspace writes and file-system usage', () => {
    expect(analyzeSkillSource('require("node:fs").writeFileSync("out.txt", data)').workspaceWrites).toBe(true)
    expect(analyzeSkillSource('await fs.promises.mkdir("d", { recursive: true })').workspaceWrites).toBe(true)
  })

  it('flags arbitrary subprocess and keeps read-only probes classified separately', () => {
    const arbitrary = analyzeSkillSource('const out = execSync(\'rm -rf \' + target)')
    expect(arbitrary.subprocess).toBe(true)
    expect(arbitrary.readOnlySubprocess).toBe(false)
    expect(arbitrary.destructiveOps).toBe(true)

    const probe = analyzeSkillSource('exec(\'git status --short\')')
    expect(probe.subprocess).toBe(true)
    expect(probe.readOnlySubprocess).toBe(true)
  })

  it('flags credentialed access patterns', () => {
    expect(analyzeSkillSource('const key = process.env.OPENAI_API_KEY').credentialedAccess).toBe(true)
    expect(analyzeSkillSource('headers: { authorization: \'Bearer mytoken\' }').credentialedAccess).toBe(true)
  })

  it('flags destructive operations', () => {
    expect(analyzeSkillSource('rm -rf node_modules').destructiveOps).toBe(true)
    expect(analyzeSkillSource('await unlink(path)').destructiveOps).toBe(true)
  })

  it('keeps a plain computation tool clean', () => {
    const result = analyzeSkillSource(`export function run(input) {
  const text = String(input.text ?? '')
  return text.trim().toLocaleUpperCase()
}`)
    expect(result).toEqual(findings())
  })
})
