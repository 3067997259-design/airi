---
module: stage-tamagotchi
tags: [electron, cdp, debugging, smoke-testing]
problem_type: workflow
---

# Debugging AIRI Electron with CDP (cold-start smoke recipe)

Verified on Windows 2026-08-29 during the coding-harness maintenance batch.

## Problem

Verifying renderer-side wiring (tool registration, settings pages, bridge
reachability) requires booting the real Electron app and inspecting live
renderer state. Two obstacles:

- `agent-browser` attaches to whichever window it activated last, and its
  tab switching is activation-based: when the main renderer is busy
  initializing (DuckDB, Live2D, Pinia sync), switching reports
  `tab is not responding and did not recover after activation`.
- AIRI has single-instance protection, so a stale Electron process makes a
  new launch hand its request to the old instance instead of booting fresh.

## Solution

### Launch (built app, isolated profile, CDP on)

```bash
pnpm -F @proj-airi/stage-tamagotchi build
taskkill //F //IM electron.exe   # clear stale instances (single-instance guard)
mkdir -p /d/.airi-smoke/userdata-N
cd apps/stage-tamagotchi
APP_USER_DATA_PATH='D:\.airi-smoke\userdata-N' \
APP_REMOTE_DEBUG=true APP_REMOTE_DEBUG_PORT=9250 \
SERVER_CHANNEL_PORT=6221 \
../../node_modules/.pnpm/electron@<version>_*/node_modules/electron/dist/electron.exe . \
  > /d/.airi-smoke/boot-N.log 2>&1 &
```

- `APP_USER_DATA_PATH` keeps each cold start clean and away from real user
  data (`src/main/index.ts` reads it).
- `APP_REMOTE_DEBUG`/`APP_REMOTE_DEBUG_PORT` come from
  `src/main/app/debugger.ts` (default port would be 9222).

### Inspect state (raw CDP, no activation needed)

`agent-browser` tab switching needs the window to respond to activation and
hangs on a busy renderer. For state probes use raw CDP `Runtime.evaluate`
over the page's `webSocketDebuggerUrl` — it does not require activation.
Reusable client: `D:\.airi-smoke\cdp-eval.cjs <port> <url-substring> <expr>`.

```bash
curl -s http://127.0.0.1:9250/json/list          # discover targets first
node D:\.airi-smoke\cdp-eval.cjs 9250 'synced-leader=true' \
  'JSON.stringify((document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["llm-tools"].tools||[]).map(t=>t.function.name))'
```

Pinia access pattern: `#app` element → `__vue_app__` →
`config.globalProperties.$pinia.state.value` → store id. Useful store ids:
`llm-tools` (registered tools), `llm-toolset-prompts`, `runtime-plans`,
`runtime-journal`.

### Verifying tool registration without model credentials

`useTamagotchiBuiltinToolsStore.refresh()` gates coding tools on a
`listTools()` probe of the main-process coding host. Therefore, finding
`read/write/edit/bash/code_mode` in the `llm-tools` store proves both the
registration and the renderer→main bridge end-to-end — no API key needed.

## Related findings

- Boot log flooding (`Failed to apply server channel configuration`): see
  [server-channel-enotsup.md](./server-channel-enotsup.md).
- `main..mods` dev note: stage-ui tests consume workspace package **dist**;
  run `pnpm run build:packages` after editing core-agent/i18n sources before
  trusting typecheck/test results.
