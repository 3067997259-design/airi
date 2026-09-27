# Dynamic route and rocket recipe acceptance

Date: 2026-09-27. Engineering checks are deferred at the user's request.

The committed 0.2.105 milestone remains the tier-1, frozen local route baseline. This batch does not replace its three successful flights.

## Rocket recipes

All runs use the same 203-point frozen local route and the existing strict gates. The fixture selects the actual FIREWORKS component, not a simulated duration. Native held-item and attached-entity telemetry both report grade 2 in all cadence-2 runs and grade 3 in all cadence-3 runs.

| Build | Evidence | Strict result | Observation |
| --- | --- | --- | --- |
| 0.2.105 | recipe-2-01..03 | 2/3 | The second flight refused the final approach. |
| 0.2.105 | recipe-3-01 | 0/1 | Final approach refusal; no further runs on this build. |
| 0.2.106 | cadence-2-01..03 | 2/3 | Errors on successful landings: 0.669 and 0.807 blocks. |
| 0.2.106 | cadence-3-01..03 | 2/3 | Errors on successful landings: 0.691 and 0.589 blocks. |
| 0.2.107 experiment, reverted | energy-3-01..02 | 0/2 | First run failed at launch with one budget tick. Second run passed six sections, then refused before the final turn. |

All six cadence flights recorded zero damage and zero budget-exhausted ticks. Failed flights stop measurement at route refusal; these numbers do not prove an autonomous recovery after refusal.

The native change retains the failed worker's request time slot while releasing its control prefix immediately. This prevents six quick failed searches from consuming all requests within one second. It does not resolve every entry state. In cadence-3-01, all six spaced searches still returned `no_sequence`; horizontal speed fell below 0.5 blocks/tick before the final approach. In cadence-2-02, the driver refused before the next request slot.

The independent six-run audit is retained as `cadence-all-tick-audit.json`. The committed `all-tick-audit.json` remains the original milestone audit.

The 0.2.107 experiment removed the additional 20-tick horizon from the unpowered-preference distance only. Full-duration boost screening remained unchanged. In energy-3-02 it fired at z=-171.7, but still had three estimated boost ticks at z=-230.8. Every candidate was refused on the following tick. This did not establish an improvement, so the preference change was reverted and the deployed client restored to 0.2.106. Both failed runs remain evidence, including the cold-start budget failure.

## Original bridge and dynamic planning

These runs call AIRI's normal `game_move_to` from (-1006.5, 74, 79.5) to (-842.5, 66.5, -265.5). They do not submit the frozen route. No dynamic run passed full-course acceptance.

| Evidence | Change / result |
| --- | --- |
| host-02 | Initial short leg failed before a useful continuation. Native recovery eventually reached ground away from the goal. |
| host-03 | Join independently verified startup legs at their exact shared endpoint. Three handovers and progress to the slab area, but the selected route remained too high. |
| host-04 | Half-width 12 alone still chose the bank top at y81. The collector's final bridge landing was a fixture reset; see `host-04-interruption.md`. |
| host-05 | Final height cost alone did not change the selected startup route. Refused near obsidian at (-945.0, 82.8, -116.2), then independently settled at (-936.3, 78, -120.7), health 20. |
| host-06 | Rank frontier candidates before the bounded shortlist and include covered candidates. Refused `channel_unverified` while still on the bridge. |
| host-07 | No flight: AIRI's debug port failed to bind after restart. Collector was stopped before another run. |
| host-08 | Align node clearance with the inflated body sweep. The startup route now descends into the river. Its continuation still turns and climbs too sharply; refusal at (-1001.7, 68.7, -1.1). |

Host-08's AIRI command returned cancelled while airborne, far from the course. The 180-second collector ended without confirming stable ground. Client restart after collection is cleanup, not landing evidence.

## Confirmed gaps

1. Frontier scoring occurred after progress-only candidate truncation. A better path cannot win if its endpoint has already been removed. The new shortlist uses progress minus minimum climb and excess-height cost. Both covered and open candidates participate.
2. A* used two vertical voxel layers, but a centered node plus the inflated 1.8-block body reaches a third layer. Low-route node and frontier checks now require all three layers. The final body sweep remains mandatory.
3. Exact endpoint equality proves a geometric join, not a dynamically feasible join. Host-08 joins a descending first leg to a short turn and climb. The next change must validate the join with measured/predicted velocity, heading and available energy, or reject that frontier before takeoff. More A* scoring alone is insufficient.
4. The broad unpowered preference near a stop can suppress useful energy replenishment for longer recipes. Merely reducing that distance also failed in 0.2.107. The next design must jointly account for remaining route turns, boost lifetime branches, energy and the terminal entry state. Full-duration boost screening must remain intact.
5. A safe short-horizon recovery action does not prove bounded arrival at a safe resting state. Host-08 remained airborne beyond the measurement window. This is separate from route progress.

## Checks and promotion

The next runtime work has two concrete boundaries:

- Dynamic joins: before adopting a frontier, evaluate a continuous suffix through its next bend from the predicted arrival position, velocity and attitude. If that state cannot enter the suffix, try another frontier or retain a longer shared prefix. Exact position equality and body clearance alone are insufficient. Host-08 is the retained failure case.
- Terminal energy: decide whether to replenish energy before the last viable ignition region closes. Evaluate the complete boost lifetime branches through the upcoming bend and require an admissible terminal entry state after extinction. A distance threshold cannot prove this. Cadence-3-01 retains the low-energy failure; energy-3-02 retains the residual-thrust failure. The bounded worker and its existing geometry snapshot are the natural place for this planning; do not weaken live collision or terminal checks.

Before promotion, rerun predefined three-flight recipe batches without deleting cold-start failures, then the original bridge route. Keep dynamic full-route results separate from frozen local-route results. Confirm autonomous settlement before fixture cleanup.

Only deployment builds ran. No lint, typecheck, Vitest or Java test suite ran in this batch. The added Java retry-cadence assertions are unexecuted. The prior 56/56 Java result belongs to 0.2.105.

These dynamic-route source changes remain experimental. They are retained in the later mixed-recipe milestone checkpoint, but that commit does not promote the dynamic route to PASS. The subsequent 0.2.110 mixed-recipe acceptance is documented separately in `mixed-recipes-report.md`; it does not turn these single-recipe failures into successes.
