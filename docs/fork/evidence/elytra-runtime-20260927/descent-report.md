# Terminal descent and repeatability — 2026-09-27

Client: 0.2.94+1.21.1. No commits. Lint, typecheck and Vitest remain skipped at the user's request.

## Result

The final three runs used the same frozen local route, client build and tier-one rocket recipe. All three landed on the target platform without damage. Only one passed every strict local gate.

| Run | Sections passed | Damage | Budget ticks | Stable ground ticks | Target error | Strict local pass |
| --- | --- | --- | --- | --- | --- | --- |
| descent-1-01 | 7/8 | 0 | 2 | 21 | 0.925 | No |
| descent-1-02 | 8/8 | 0 | 0 | 20 | 0.861 | Yes |
| descent-1-03 | 8/8 | 0 | 1 | 21 | 0.906 | No |

Independent native-tick geometry audit found zero contacts and zero missing ticks in all three runs. Maximum per-tick yaw remained 25 degrees. See `descent-audit.txt` and the raw JSONL files. A sample of three does not establish a reliable success rate.

This is the route from the natural ground before the wool gates to the cave platform. It is not the original bridge-to-cave route through AIRI's dynamic planner. The fixture's `fullCoursePass` field refers only to this local test.

## Changes retained

- `permitsStopDescent` now requires a continuous clear body corridor from the predicted endpoint to the goal. Support under both endpoints alone cannot authorize low descent through an intervening wall or bend. Actual touchdown still needs its separate support, speed and runout checks.
- Support friction reads are cached within a geometry-check epoch. Every native tick refreshes them. The probe reduced 20 callbacks over four cells to four callbacks; this is not a claim of an 80% CPU reduction.
- The old long-burn regression now explicitly selects a tier-two rocket. It previously depended on the removed universal 35-tick default. Its collision assertion remains unchanged. This test does not prove safety for every random rocket lifetime.

Focused Java tests: 49/49. The descent-wall and friction-cache regressions failed before their fixes. See `descent-before.txt`, `friction-before.txt`, and `descent-focused-verified.txt`. Build evidence: `build-094.log`.

## Rejected experiment

Version 0.2.93 screened all near-terminal candidates through the same longer horizon. In `approach-1-01`, this rejected the remote bend before the terminal planner could take over: five gates passed, no damage, three budget ticks, no target landing. That change was reverted. Its raw evidence remains available.

## Entry-state evidence

`entry-counterfactual-results.txt` compares successful and failed measured entry states in the production planner. For two failed states, adding three blocks of altitude alone or raising horizontal speed to 1.6 alone found no plan. Combining both found a plan. This bounded offline search used a 1500 ms budget, not the production 300 ms budget. Failure to find a plan does not prove physical impossibility.

## Remaining work

1. Instrument stage timings for normal candidate generation, terminal checks, snapshot capture and reservation validation. The remaining budget failures are not confined to terminal-sequence execution: descent-1-01 had 29 ms at launch and 12 ms near the second roof; descent-1-03 had 12 ms before the lower wool gate. Keep the 12 ms budget and count every session owner. See `descent-diagnostics.json`.
2. Reproduce the lower-wool height failure. Run 01 crossed at y=74.230, above the unchanged 74.05 gate ceiling. Audit found no physical contact, but the acceptance gate still failed. Compare launch and rocket-expiry states before changing control or fixture geometry. Do not widen the gate merely to pass this run.
3. After those changes, repeat three same-build local runs. Then check other rocket recipes and reconnect the original bridge-to-cave dynamic route. Three zero-damage landings do not discharge those gates.
4. New-fire candidate prediction still uses nominal recipe duration with a maximum screening horizon. Existing reservation checks cover all expiry ticks in their prefix; that does not certify all future ignition lifetime branches.

Final probe: bot at (-1006.5, 74, 79.5), grounded, not gliding, health 20. Client remains running on 0.2.94.
