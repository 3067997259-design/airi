# Candidate timing and terminal ignition — 2026-09-27

No commits. Lint, typecheck and Vitest remain skipped. Client 0.2.96 is installed.

## Results

| Run | Build | Eight sections | Damage | Budget ticks | Stable target landing | Strict local pass |
| --- | --- | --- | --- | --- | --- | --- |
| timing-1-01 | 0.2.95 | Yes | 0 | 1 | 21 ticks, error 0.967 | No |
| ordering-1-01 | 0.2.96 | Yes | 0 | 2 | 20 ticks, error 0.998 | No |
| ordering-1-02 | 0.2.96 | Yes | 0 | 0 | 20 ticks, error 0.933 | Yes |
| ordering-1-03 | 0.2.96 | No | 0 | 0 | No | No |

Final same-build batch: strict local pass 1/3; target landing 2/3; no damage 3/3. Independent geometry audit found no contacts or missing samples. Failed runs remain failures. These are local frozen-route trials, not the original bridge-to-cave dynamic route.

## Implemented

- Native tick telemetry now records microseconds for planning preparation, candidate ordering, candidate simulation, selection and initial reservation validation. These are stage measurements, not a complete decomposition of total tick time. In particular, terminal-sequence execution and intermediate bookkeeping are not separately timed.
- Candidate ordering uses exact `CandidateSpec` records for deduplication instead of formatting every candidate into a decimal string. The current integer-offset fixture retains the same candidate set and order. Distinct fractional offsets no longer merge after rounding.
- The new public-behavior regression evaluates eight policies for offsets 0 and 0.04, while removing an exact duplicate. Old code evaluated four. Evidence: `ordering-before.txt` and `ordering-after.txt`.

Java focused tests: 50/50. The first diagnostic test run had one failure in a continuation test using the real 12 ms default, during client startup (`timing-focused.txt`). This failure is preserved; the final run passed without changing its assertion or budget. Do not infer that runtime timing is reliable from the final unit-test result.

Builds: `build-095.log`, `build-096.log`. Raw trials, summaries, stage reports and `ordering-diagnostics.json` are adjacent.

## What the timing evidence says

Version 0.2.95's first flight exceeded the budget at its first controlled tick: total 22 ms, measured stages about 8.4 ms. Candidate-order construction was outside those initial stage measurements.

After record-based deduplication, version 0.2.96 still exceeded the budget twice in its first flight: first tick 20 ms (ordering 2.71 ms, candidates 5.19 ms), then candidates 11.93 ms five ticks later. Thus formatting was an avoidable cost, not a proven complete cause. Both later trials had zero budget ticks. Cold initialization, unmeasured bookkeeping and scheduling remain hypotheses; no warm-up exclusion or budget relaxation was added.

## Terminal failure, independent of budget

In ordering-1-03, tick 2663 fired at (-867.85, 70.80, -221.84), cursor 162. The chosen fire policy had a 32-tick screening horizon. At tick 2677, the client refused all final actions near (-864.34, 70.29, -242.31), with 13 estimated boost ticks remaining. The terminal worker only starts with at most 12 remaining ticks and cannot adopt a powered terminal sequence.

The trace's `waiting_boost_expiry` text is stale at this point: `consider` returns early for boost >12 without refreshing that string. Use the actual boost telemetry and source gate for attribution. The worker had not returned a plan (`result=none`).

This exposes the boundary between normal ignition screening and terminal entry feasibility. A screened fire candidate can leave the pilot powered while the unpowered terminal planner cannot yet accept its state. The record does not establish that simply suppressing this rocket is safe: the selection policy already prefers viable glides near the stop.

## Next work

1. Replay the tick-2663 measured state with the preceding orientation. Compare no-fire and fire branches through actual expiry, including recipe lifetime alternatives. Preserve collision, speed and descent gates. Determine whether an earlier glide/altitude action avoids the late ignition or a bounded powered approach sequence is needed.
2. Make terminal entry feasibility part of the ignition decision, rather than declaring fire safe from a local horizon alone. Do not impose a distance-only fire ban or expand a constant-policy horizon across bends; the earlier 0.2.93 experiment already failed that approach.
3. Complete total-tick timing around bookkeeping and terminal-sequence execution. Repeat a fresh-client first flight as well as warmed flights; all budget failures must still count.
4. Keep the lower-wool gate unchanged. This batch did not reproduce the height failure, so it is not fixed by this performance change.

Final probe: bot grounded at (-1006.5, 74, 79.5), health 20, not gliding. Reset after the refused run does not count as a verified autonomous landing.
