const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const target = targets.find(item => item.type === 'page' && item.url.includes('synced-leader=true'))
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let messageId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
}
async function evalJs(expression) {
  const id = ++messageId
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  const message = await new Promise(resolve => pending.set(id, resolve))
  if (message.result?.exceptionDetails)
    return `EXC: ${message.result.exceptionDetails.exception?.description ?? 'eval failed'}`
  return message.result?.result?.value
}

await evalJs(`location.hash = '#/devtools/game-host'; 'ok'`)
await new Promise(resolve => setTimeout(resolve, 1500))

const status = await evalJs(`(async () => { try { return JSON.stringify(await window.__AIRI_GAME_HOST_SMOKE__.getStatus()) } catch (error) { return 'err: ' + String(error) } })()`)
console.log('status:', String(status).slice(0, 500))

const config = await evalJs(`(async () => { try { return JSON.stringify(await window.__AIRI_GAME_HOST_SMOKE__.getConfig()) } catch (error) { return 'err: ' + String(error) } })()`)
console.log('config:', String(config).slice(0, 500))

console.log('reapplying config to force a reconnect...')
const applied = await evalJs(`(async () => { try { const config = await window.__AIRI_GAME_HOST_SMOKE__.getConfig(); return JSON.stringify(await window.__AIRI_GAME_HOST_SMOKE__.applyConfig(config)) } catch (error) { return 'err: ' + String(error) } })()`)
console.log('applyConfig:', String(applied).slice(0, 500))
await new Promise(resolve => setTimeout(resolve, 3000))

const after = await evalJs(`(async () => { try { return JSON.stringify(await window.__AIRI_GAME_HOST_SMOKE__.getStatus()) } catch (error) { return 'err: ' + String(error) } })()`)
console.log('status after:', String(after).slice(0, 500))
ws.close()
