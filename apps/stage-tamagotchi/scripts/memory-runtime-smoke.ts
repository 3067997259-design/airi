import process from 'node:process'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

interface SmokeOptions {
  appDirectory: string
  launch: boolean
  port: number
  timeoutMs: number
}

function optionsFromArgs(): SmokeOptions {
  const args = new Set(process.argv.slice(2))
  const valueAfter = (name: string, fallback: string) => {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
  }
  return {
    appDirectory: resolve(valueAfter('--app-directory', join(import.meta.dirname, '..'))),
    launch: args.has('--launch'),
    port: Number(valueAfter('--port', '9250')),
    timeoutMs: Number(valueAfter('--timeout-ms', '30000')),
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function waitForCdp(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok)
        return await response.json() as Record<string, unknown>
    }
    catch {
      // The process can take several seconds to create its first window.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Electron CDP endpoint did not become ready: ${url}`)
}

async function main(): Promise<void> {
  const options = optionsFromArgs()
  const requiredFiles = [
    join(options.appDirectory, 'out', 'main', 'index.js'),
    join(options.appDirectory, 'out', 'renderer', 'index.html'),
  ]
  for (const path of requiredFiles) {
    if (!existsSync(path))
      throw new Error(`Missing build artifact: ${path}. Run the stage-tamagotchi build first.`)
  }

  console.info(JSON.stringify(requiredFiles.map(path => ({
    path,
    bytes: statSync(path).size,
    sha256: sha256(path),
  }))))
  if (!options.launch)
    return

  const electronPath = join(options.appDirectory, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(electronPath))
    throw new Error(`Electron executable not found: ${electronPath}`)

  const userDataPath = mkdtempSync(join(tmpdir(), 'airi-memory-smoke-'))
  const child = spawn(electronPath, [requiredFiles[0], `--remote-debugging-port=${options.port}`, `--user-data-dir=${userDataPath}`], {
    cwd: options.appDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stderr: string[] = []
  child.stderr?.on('data', chunk => stderr.push(String(chunk)))
  try {
    const cdp = `http://127.0.0.1:${options.port}/json/version`
    const version = await waitForCdp(cdp, options.timeoutMs).catch((error) => {
      const detail = stderr.join('').trim()
      throw new Error(`${errorMessageFrom(error) ?? 'Electron CDP probe failed'}${detail ? `\nElectron stderr:\n${detail}` : ''}`)
    })
    console.info(JSON.stringify({
      pid: child.pid,
      cdp,
      browser: version.Browser,
      userData: userDataPath,
      note: 'This checks packaged renderer startup and CDP reachability; it does not prove provider-backed dreaming behavior.',
    }))
  }
  finally {
    child.kill()
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null) {
        resolvePromise()
        return
      }
      child.once('exit', () => resolvePromise())
    })
    try {
      rmSync(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
    catch (error) {
      console.warn(`Temporary smoke userData was left for manual cleanup: ${userDataPath}`, error)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'Memory runtime smoke failed')
  process.exitCode = 1
})
