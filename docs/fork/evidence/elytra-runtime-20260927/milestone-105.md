# Three consecutive strict local cave landings

Date: 2026-09-27. Client: 0.2.105+1.21.1. Native commit: `69a35a6` in `3067997259-design/mcpfabric` (`main`).

## Acceptance

The first three flights on this build passed the unchanged strict local gate. No warm-up flight was excluded.
All used the same frozen 203-point route, natural-ground start, and tier-one firework recipe.

| Evidence | Sections | Damage | Budget ticks | Settled 3D error | Stable ground | Strict result |
| --- | --- | --- | --- | --- | --- | --- |
| bridge-1-01 | 8/8 | 0 | 0 | 0.5712 | 21 ticks | PASS |
| bridge-1-02 | 8/8 | 0 | 0 | 0.9090 | 21 ticks | PASS |
| bridge-1-03 | 8/8 | 0 | 0 | 0.8329 | 20 ticks | PASS |

The independent voxel audit found zero contacts and zero missing route ticks in all three flights.
Maximum yaw change stayed at 25 degrees per tick. Attached rocket count never exceeded one.
The full raw JSONL, summaries, `bridge-audit.txt`, `all-tick-audit.json`, and `bridge-planning-events.jsonl` preserve the evidence.

This milestone covers the local course from natural ground before the wool gates through the slabs to the cave platform.
It does not certify the original bridge-to-cave dynamic AIRI route, other firework recipes, or reliability beyond these three runs.

## Changes in this batch

The terminal planner now requires a predicted landing inside radius 0.8. Runtime acceptance remains radius 1.
This leaves a planning reserve for the allowed adoption error and native runout differences.
It is an engineering margin, not a proof that all model errors fit inside 0.2 blocks.

Candidate quality now measures distance to the nearby 3D route polyline.
The old horizontal distance to a future waypoint rewarded forward travel again and could override height tracking.
The progress equivalence band, swept geometry, rotation limits, and firework rules remain active.
The local segment search uses the existing passed-plane range to exclude remote bends.
Hold prediction retains its existing reference ranking.

Two public-decision regressions reproduce the old ranking errors.
A straight route previously selected an unnecessary lateral turn; another case climbed 1.22 blocks above the level route.
The corrected cases stay on the centerline and within about 0.12 blocks of the requested height.
`polyline-before.txt` uses a reconstructed old comparator against the same current dependencies; both tests fail.
`polyline-tests.txt` passes all 56 focused Java cases.

Short reservations now require their own lead length plus four continuation ticks, rather than the normal lead length.
The eight-tick handoff therefore screens twelve controls. Actual reserved prefixes still receive full geometry and expiry checks.
The readiness, zero-boost, deadline, and per-tick live verification rules remain unchanged.
`short-window-before.txt` reproduces the old length rejection; `short-window-tests.txt` passes 56/56.

The final three flights used normal twelve-tick reservations. They do not demonstrate live adoption of the short reservation.
The second flight released a failed worker result and successfully adopted a later plan.
These observations do not isolate which change caused the three successful flights.

## Retained failures and intermediate builds

| Build | Batch | Strict pass | Observations |
| --- | --- | --- | --- |
| 0.2.102 | margin-1-01..03 | 0/3 | One target landing; one wool-height failure; two refusals before the last roof. Zero damage and budget ticks. |
| 0.2.103 | Offline only | Not tested live | Point-distance ranking did not correct the flat-route examples. Superseded by polyline distance. |
| 0.2.104 | polyline-1-01..03 | 1/3 | All wool sections passed. Two later refusals; four budget ticks in the first run. Zero damage. |
| 0.2.105 | bridge-1-01..03 | 3/3 | First three flights on the final build; all strict gates passed. |

No raw failure file was rewritten or promoted to PASS. Earlier reports remain historical evidence.
The final single-version build succeeded with one worker and a 768 MB Gradle heap.
Lint, typecheck and Vitest were skipped under the user's explicit resource constraint and milestone commit authorization.

The bot was reset after measurement and is grounded at (-1006.5, 74, 79.5), health 20.
Resetting is fixture cleanup and does not count as autonomous landing.

## Next acceptance scope

Preserve this build as the local baseline. Next verify the original dynamic route and other rocket recipes separately.
Longer repeat batches, cold-start timing, and failed-entry recovery remain useful follow-up work.
The three-run milestone is not a claim of universal flight safety or complete end-to-end AIRI acceptance.
