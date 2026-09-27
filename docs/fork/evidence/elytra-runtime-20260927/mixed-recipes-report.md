# Per-ignition rocket recipe selection

Date: 2026-09-27. Engineering checks remain deferred by request.

**Final local acceptance: 0.2.110 passed all three predefined runs, mixed-window-01..03.** Each used a fixed grade-1 launch and stocked grades 1, 2 and 3. All eight sections passed, with zero damage and budget ticks. The independent geometry audit found zero contacts and gaps; maximum yaw change was 25 degrees per tick and at most one boost entity was attached.

| Run | Route-controlled ignition grades | Landing error | Stable ground ticks |
| --- | --- | --- | --- |
| mixed-window-01 | 3 → 2 → 1 | 0.709 | 22 |
| mixed-window-02 | 3 → 2 | 0.670 | 20 |
| mixed-window-03 | 3 → 3 | 0.709 | 20 |

Every planned ignition grade matched the actual item used. These sequences came from runtime selection, not a prescribed sequence in the fixture. See `mixed-110-summary.json` for raw-file hashes and ignition coordinates, and `mixed-110-all-tick-audit.json` for independent geometry results.

## Implemented boundary

The native route controller now enumerates recipes that can be used from the offhand or hotbar. Each powered candidate carries its recipe through prediction, selection and execution. The actuator selects the exact source and refuses a missing recipe instead of substituting another one. Backpack-only stacks still require staging.

Native samples distinguish `plannedRocketFlightDuration`, `firedRocketFlightDuration`, and the existing attached-entity `boostFlightDuration`. The older `rocketFlightDuration` describes the default hand; it is not proof of the recipe actually fired. Launch-macro ignitions do not populate the two new route-controller fields; use attached-entity evidence for those.

The 12 ms tick deadline, turn limits, collision checks and prohibition on overlapping boosts remain unchanged. Three available recipes expand the bounded candidate cap from 40 to 80. A deadline overrun still fails strict acceptance.

In mixed mode, powered candidates are checked beyond the common quality horizon, through their recipe-dependent screening window. Progress and tracking quality are compared at the same horizon. When quality ties, cruise candidates prefer a longer usable boost; near a stop they prefer shorter duration. This is explicit model-based selection, not reinforcement learning.

The internal thrust rollout still uses the recipe's nominal lifetime. Extending the screening window to its maximum lifetime is not an exhaustive proof over all random expiry times. The existing reservation expiry checks remain separate. Do not describe this batch as complete stochastic flight verification.

## Retained experiments

| Build | Runs | Strict result | Interpretation |
| --- | --- | --- | --- |
| 0.2.108 | mixed-01 | 0/1 | Exact recipe execution worked, but the short horizon kept selecting grade 1. Two budget ticks; refused before the final turn. |
| 0.2.109 | mixed-02..04 | 2/3 | All three passed eight sections and landed without damage. Third run had one budget tick. Launch recipes varied. |
| 0.2.109 | mixed-fixed-01..03 | 0/3 | Fixed grade-1 launch exposed later turn/terminal failures. Zero measured damage and budget ticks; collection stops on route refusal, so recovery is not accepted. |
| 0.2.110 | mixed-window-01..03 | 3/3 | Fixed grade-1 launch, per-recipe stop preference; all strict local gates passed. |

Successful 0.2.109 landing errors were 0.610 and 0.805 blocks. The third landing error was 0.865 blocks, but its budget tick prevents PASS. Independent geometry auditing found no contacts or missing ticks in these three runs. See `mixed-all-tick-audit.json`.

Mixed-03 provides actual route-controlled mixing: grade 3 at z=-109.11, then grade 2 at z=-170.18. Planned and actual ignition grades match, and attached entities report both grades. Mixed-fixed-02 also selected grade 3 then grade 1, but failed later; selection capability is not equivalent to course acceptance.

The first report of a grade-1 launch in mixed-02 was incorrect. The offhand held grade 1, but the launch macro used another slot. Attached telemetry reports grade 2 for mixed-02 and grade 3 for mixed-03. The fixture now normalizes the selected slot to grade 1 before launch. Earlier raw logs remain unchanged.

## Per-recipe stopping window

0.2.109 used the shortest stocked recipe to determine a global unpowered-preference window. This let a long recipe use a short recipe's stopping distance. The 0.2.110 change assigns that preference to each candidate's own maximum duration. Long ignitions are deferred before short ones; they remain eligible if ordinary candidates cannot continue safely. Validation results follow below.

## Validation scope

Only single-worker deployment builds ran, with tests excluded. No lint, typecheck, Vitest or Java test suite ran. A Java regression for explicit recipe selection was added but remains unexecuted. This batch does not accept the original bridge dynamic route.

Commit-time exception: AIRI's pre-commit hook attempted `moeru-lint --fix`, but command-line length prevented it from running successfully. Nano-staged reported restoring the original files. The commit then used a command-local disabled hook path under the user's explicit check-deferral authorization; repository hook configuration was not changed. This is not a passing lint result.

The user authorized immediate milestone commits after three strict passes even with engineering checks deferred. Earlier unsuccessful experiments remain in the evidence set. The original dynamic-route changes are still unaccepted, as described in `dynamic-recipes-report.md`.

Native implementation commit: `0715593` in MCPFabric. The bot was reset after measurement to the original bridge, health 20. Fixture cleanup is not part of landing acceptance.
