---
module: server-runtime
tags: [electron, networking, retry, enotsup, pinia]
problem_type: root-cause-analysis
---

# server-channel ENOTSUP: watcher rollback ping-pong flooded every renderer

Root-caused and fixed 2026-08-29 during the maintenance-batch cold-start smoke.

## Symptom

On hosts where the channel server cannot bind (`listen ENOTSUP` on
`127.0.0.1:6121` — suspected TUN/proxy adapter breaking loopback binds,
previously misread as "non-fatal" in MODS.md), a cold start floods the log
with bind errors (~13/second, 6908 lines in 3 minutes), burns 500+ CPU
seconds, and makes **every renderer intermittently unresponsive** — even
raw CDP `Runtime.evaluate` times out, and `agent-browser` reports
`tab is not responding`.

## Root cause (two stacked defects in the renderer settings store)

`apps/stage-tamagotchi/src/renderer/stores/settings/server-channel.ts`
watches `tlsConfig/hostname/authToken` and applies changes to the main
process:

1. **Boot sync triggered a pointless apply.** `refreshServerChannelConfig()`
   moves the refs off their localStorage defaults (a fresh profile gets a
   main-process-generated auth token). The watcher fired even though the
   server already runs exactly that config — a re-apply of the accepted
   state. On healthy hosts it was idempotent and invisible; on ENOTSUP
   hosts it failed.
2. **Failure rollback restored the wrong baseline.** The catch block reset
   the refs to the watcher's *previous-flush* values, which differ from the
   last server-accepted snapshot. Restoring them re-fired the watcher:
   apply → fail → rollback → apply, forever.

## Fix

- The watcher dedupes against `appliedConfig` (the last accepted snapshot)
  instead of the previous flush: a boot sync of an already-accepted config
  applies nothing, and a genuine rollback can no longer re-trigger.
- The failure rollback restores `appliedConfig` (or the prior values only
  when no snapshot exists yet).
- Regression test:
  `apps/stage-tamagotchi/src/renderer/stores/settings/server-channel.test.ts`
  — a boot-time apply failure must produce zero apply attempts and settle.

## Workaround for smoke tests on ENOTSUP hosts

None needed after the fix, but `SERVER_CHANNEL_PORT` does not bypass the
broken loopback bind (any port fails). For CDP debugging see
[electron-cdp-smoke.md](./electron-cdp-smoke.md).

## Removal condition

The watcher dedupe and snapshot rollback are correct regardless of
environment and stay. If the loopback bind issue is resolved (TUN adapter
excluded from LSP processing), this note remains as the record of why the
error flood was misread as harmless for so long.
