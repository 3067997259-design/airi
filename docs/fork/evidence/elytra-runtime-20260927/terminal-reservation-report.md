# Terminal reservation, runout and startup cost — 2026-09-27

No commits. Lint, typecheck and Vitest remain skipped. This work covers the frozen local route before the wool gates through the cave platform. It does not certify the original bridge-to-cave AIRI dynamic route.

## Findings and changes

### A local policy failure is not proof that a terminal sequence is impossible

At ordering-1-03 tick 2663, the 20-tick unpowered policies all hit predicted terrain. The powered policy passed its 32-tick screen, then failed later while boost prevented terminal adoption. Replaying with the measured route cursor is essential: an initial replay incorrectly started at cursor zero and is excluded from conclusions.

The same measured state had clear shorter prefixes. From the straight PULL_UP policy, an eight-tick prefix led to a terminal sequence in the offline bounded search. A twelve-tick prefix did not. These are static-snapshot counterfactuals, not real flight. The exploration allowed 1500 ms; the production worker remains limited to 300 ms.

Version 0.2.97 added a narrow fallback. If the regular search has no usable glide, the snapshot is complete, no boost remains, and a worker can start now, it evaluates at most five extra PULL_UP prefixes. They have a 16-tick screen and an eight-tick reservation. Execution requires successful reservation and live prefix verification. The regular 40-policy search and all extra work share the same 12 ms deadline. No global horizon was shortened. Unaccepted prefixes cannot become actions.

Evidence: `ignition-decisions-cursor.txt`, `ignition-prefix-matrix.txt`, `ignition-ready-before.txt`, `ignition-ready-after.txt`. The before replay uses archived pre-change classes. The fixture uses the same integer steering offsets. `ignition-decisions.txt` has the incorrect cursor; `ignition-prefix-results.txt` followed a compile failure and used an older class. Neither is acceptance evidence.

This fallback is insufficient for every entry state. In prefix-1-02, all five prefixes failed and the normal powered action remained selected. The new unpowered state already had predicted contact as early as tick two. This requires earlier trajectory control, not an unconditional late fire ban. Accepted eight-tick bridging is supported by offline replay and focused tests; the successful live flights in the intermediate batches used normal twelve-tick reservations.

### Failed workers must release their reservations early

In prefix-1-03 the worker returned no_sequence in 179 ms, but the controller kept its climbing prefix until tick twelve. Version 0.2.98 consumes failed or exceptional results immediately and returns to measured-state control. Successful plans still wait for their exact adoption tick. A changed measured boost invalidates the origin before either result is considered.

The regression failed before this change and passed afterward. In early-1-03, the first worker failed in 140 ms. By the third reserved tick, the controller processed the failure instead of waiting twelve ticks. A subsequent request found a plan, and the bot landed strictly inside the goal. See `early-planning-events.json`.

### Slow ground motion is not a settled position

Early-1-01 passed all sections and landed without damage or budget exhaustion, but its settled 3D error was 1.029, outside the unchanged radius of one block.

The landing verifier stopped runout as soon as speed fell below 0.05 blocks/tick. This omitted residual motion. A focused boundary test reproduced false acceptance before the fix. Version 0.2.99 evaluates all 24 bounded runout ticks before checking the final radius. Collision, support, friction and speed requirements remain in force. This fixes a proven model error; it does not establish that every runtime landing discrepancy had that one cause.

### Startup preparation and query costs

Runout-1-01 still exceeded the budget on its first controlled tick: about 30 ms. The existing warm-up called only partial prediction methods and queried the caller's live world.

Version 0.2.100 warms the complete decision path in an isolated synthetic session before launch. It runs at most eight preparatory decisions and cannot write player input or query the live world. The real session keeps its own state, counters and 12 ms budget. No first-flight samples are excluded. The construction test changed from 444 live reads to zero.

Warm-1-01 still exceeded the budget at the first tick (reported 12 ms, candidate phase 11.601 ms). Warm-1-02 passed. Version 0.2.101 additionally avoids redundant registry and collision queries for native air and avoids a second hash lookup on non-null cell-cache hits. Cached unknown cells remain unknown. Fluid and non-air collision checks remain unchanged. These changes reduce work; they do not guarantee real-time scheduling under arbitrary machine load.

## Validation and limits

Focused Java tests on the final code: 54/54 (`fast-query-tests.txt`). Red/green evidence includes early worker release, residual runout and isolated warm-up. Low-resource single-version builds succeeded. A test exposed failure-result versus boost-change precedence during development; that ordering was corrected and the failed output is retained.

Intermediate live results:

| Build | Runs | Eight sections | Target landing | Strict local pass | Budget ticks |
| --- | --- | --- | --- | --- | --- |
| 0.2.97 | prefix-1-01..03 | 1/3 | 1/3 | 1/3 | 0, 0, 0 |
| 0.2.98 | early-1-01..03 | 3/3 | 2/3 | 2/3 | 0, 0, 0 |
| 0.2.99 | runout-1-01..03 | 3/3 | 3/3 | 2/3 | 1, 0, 0 |
| 0.2.100 | warm-1-01..02 | 2/2 | 2/2 | 1/2 | 1, 0 |

Every intermediate run had zero damage. Failures remain in the batch totals. The one-block goal sphere, eight passage gates and all-owner budget counting were not relaxed. Resetting the bot after a refusal is not autonomous landing evidence.

Remaining scope includes other firework recipes, the original dynamic route, and entry states where immediate loss of thrust already leaves no safe ordinary glide. New ignition screening still uses a nominal recipe duration; reservation expiry-branch checks do not certify every future ignition lifetime.

## Final deployed build: 0.2.101

| Run | Eight sections | Damage | Budget ticks | Target error | Stable ground | Strict local pass |
| --- | --- | --- | --- | --- | --- | --- |
| fast-1-01 | 8/8 | 0 | 0 | 0.961 | 21 ticks | Yes |
| fast-1-02 | 8/8 | 0 | 0 | 1.038 at refusal | Not verified | No |
| fast-1-03 | 7/8 | 0 | 0 | 0.970 | 20 ticks | No |

Same build, frozen route and tier-one recipe: strict local pass **1/3**, no damage **3/3**, zero budget exhaustion **3/3**. The first run was after a client restart; its first controlled decision took 11 ms. It was not excluded as warm-up. The other first decisions took 1 and 2 ms. These three observations do not guarantee future real-time performance.

Fast-1-02 refused with `landing_unconfirmed sequence=rejected:landing_changed`. The stated error is the measured refusal position, not a settled landing. Fast-1-03 crossed the lower-wool section at y=74.090016, above the unchanged 74.05 ceiling. Both remain failures.

Independent route-trajectory audit found zero contacts and zero missing ticks in all three. Maximum per-tick yaw remained 25 degrees and attached boost count never exceeded one. No accepted eight-tick reservation occurred in this final batch. See `fast-audit.txt`, `fast-final-diagnostics.json`, the raw JSONL files and `manifest-101.json`.

Next priority is a planning margin rather than a wider acceptance gate: measure prediction-versus-native residuals at the wool section and landing, then constrain the planned trajectory and settled target inside their allowed envelopes. Full runout removed a proven truncation error, but final live replanning can still approach the boundary. The runtime must retain the full collision, support and terminal checks. The original dynamic route and other recipes remain separate acceptance tasks.

Final probe: bot grounded at (-1006.5, 74, 79.5), health 20, not gliding. Server and both MCP bridges remain running. Client is 0.2.101; no commits were created.
