# Mixed-recipe flight closeout — 2026-09-27

The final local flight passed every strict gate on native build `0.2.110+1.21.1`. Engineering checks then ran serially: lint, Vitest, desktop typecheck, and native Java tests.

## Final flight

`mixed-final-01.jsonl` records eight controlled section crossings, zero damage, zero budget overruns, and a verified target landing. The landing error was 0.9128600538 blocks. Ground contact remained stable for 20 ticks. Independent auditing found no contacts or missing samples across 211 controlled ticks; maximum yaw change was 25 degrees per tick.

The raw SHA-256 is `9b514b525ac2e2554bb4d1a91ba6c747223fd926a8575145a0cfb57514199dae`. See `mixed-final-01-summary.json` and `mixed-final-all-tick-audit.json`. This pass follows the three strict `mixed-window-01..03` passes on the same build. After measurement, the fixture reset the bot to the original bridge with health 20; that reset is not landing evidence.

## Engineering checks

| Check | Scope | Result |
| --- | --- | --- |
| ESLint, zero warnings allowed | Entire game-host directory, four runtime evidence scripts, and scoped Vitest config | PASS |
| Vitest | All 69 game-host test files | 978 passed, 3 skipped; 66 files passed, 3 skipped |
| Typecheck | Entire `@proj-airi/stage-tamagotchi` package | PASS, `vue-tsc --noEmit` |
| JUnit | MCPFabric `:1.21.1:test` | 154 passed, zero failures/errors/skips |

Commands, from the respective repository roots:

```powershell
pnpm exec eslint --max-warnings 0 apps/stage-tamagotchi/src/main/services/airi/game-host docs/fork/evidence/elytra-runtime-20260927/audit-all-ticks.mjs docs/fork/evidence/elytra-runtime-20260927/collect-host.mjs docs/fork/evidence/elytra-runtime-20260927/fly-terminal.mjs docs/fork/evidence/elytra-runtime-20260927/prepare-host.mjs docs/fork/evidence/elytra-runtime-20260927/vitest.config.ts
.\node_modules\.bin\vitest.cmd run --config docs/fork/evidence/elytra-runtime-20260927/vitest.config.ts --reporter=verbose
pnpm -F @proj-airi/stage-tamagotchi typecheck
.\gradlew.bat :1.21.1:test --max-workers=1 --no-daemon '-Dorg.gradle.jvmargs=-Xmx768m -XX:ActiveProcessorCount=2'
```

Java used JDK 21. Final outputs are retained in `closeout-lint-final.log`, `closeout-vitest-final.log`, `closeout-typecheck.log`, and `closeout-java.log`. Lint ran again after the test-only corrections and config addition. These are scoped engineering results, not whole-monorepo lint or test acceptance.

## Corrections found during checks

- Evidence scripts needed entry functions and lint formatting. `collect-host.mjs` and `prepare-host.mjs` now report rejected entry promises through a nonzero exit code.
- The real long-route receipt test exceeded Vitest's default five-second deadline. It now uses the same 60-second allowance as real channel-planning tests. It passed in 6.077 seconds.
- The channel fake clock advanced only 50 ms for every requested sleep. Production polls request 500 ms, so the fake multiplied polls and repeated terrain searches before a stall by ten. It now advances by the requested delay. The loiter regression passed in 45.248 seconds without changing production deadlines or assertions.
- Initial runs were interrupted while default output remained silent. Silence did not establish a runner hang. Verbose output exposed the timeout and slow fake-clock case. The final complete suite exited zero in 229.89 seconds. Earlier output remains in `closeout-vitest-verbose.log`.

No production flight code changed during this closeout. The real flight therefore tests the same production implementation that passed the completed engineering checks. Native implementation remains commit `0715593`; the prior AIRI milestone is `7fdb8abee`.

## Acceptance boundary

This closes the mixed-recipe local-route milestone and its deferred engineering checks. It does not accept the original bridge-to-cave dynamic route, backpack-only recipe selection, or every possible random boost expiry. Those limits remain in `mixed-recipes-report.md` and `dynamic-recipes-report.md`.
