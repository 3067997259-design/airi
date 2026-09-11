# Acceptance repairs and remaining runtime checks

Date: 2026-09-08. Scope: the reviewed ACC-20260907-01 failures.

## Implemented changes

These changes are implemented, not a replacement for Electron acceptance results.
The original provider, character cards, shortcuts, and main conversation bytes were not overwritten during this batch. The temporary submitted queue entry used for K02 was removed after the check; the built-in `opencode_delegate` catalog skeleton remains inert and is not an approved runtime skill. The active session pointer was restored to the original main session.

| Item | Change | Automated coverage | Remaining runtime check |
| --- | --- | --- | --- |
| R01 | The leader registers the backup owner after the restore gate. | Existing snapshot and restore-owner browser tests pass. | PASS in the current build: cold start, open settings first, enter Data, and receive an 8,079,850-byte ZIP (`PK` signature) from the follower action. |
| K02 | Settings and chat share a source-review panel. Approval includes the displayed source and self-test hashes. The settings catalog clones reactive entries before the follower-to-leader RPC. | Source changes, resubmissions, changed self-tests, the disabled/view/approve/error interaction, and the catalog submission boundary pass. | PASS for the catalog/source-review path. K03 passes with the real workspace skill; K04 fails on silent invalid-input filtering; K05–K07 pass in the same-profile runtime continuation. |
| M01–M08 runtime | Seeded recall, memory-off exclusion, explicit `reviseFact()` correction, unknown-premise refusal, character scope, dated facts, remembered-text handling, and public dreaming scope were replayed with a real provider. | Memory extraction, approval, supersede, scope, journal, stream, and idea-source assertions pass in the existing suites. | M01–M06 and the two-character part of M08 pass. M07 is partial: the same-session task and focused-mode checks pass, but a natural-language new-session recall misses the fact. V03's real visual activity and same-session continuation pass, but its new-session answer used workspace tools while `memory/retrieved` was empty; its pending extraction also has recall-turn provenance. A possible second-user M08 variant and the separate natural-language correction finding remain open. See [`runtime-memory-repair-20260908.md`](evidence/short-scenarios/ACC-20260907-01/runtime-memory-repair-20260908.md). |
| S13 | Durable decision references reconstruct recently consumed novelty keys. Equivalent new events are suppressed for 30 minutes. | Repeated IDs, changed values, and recurrence after the window pass. | PASS for same-value suppression and a real changed value in the same-profile Electron continuation. A post-window recurrence remains. |
| D05 | Approval denial and timeout close the current mutation Flow; a late decision cannot settle an expired request. | Core-agent regression covers the terminal blocked boundary; the host approval tests cover timeout and late settlement. | PASS in the same-profile Electron continuation for full timeout, late decision, and same-Flow denial retry prevention. |
| D06 | The ordinary chat composer includes the blocking `user_ask` reference, so the model can raise the existing question card before a mutation. | The Electron browser regression checks the ordinary send payload; the rebuilt runtime showed the card, answer, file write, file readback, steering output, and a second-session isolation run. | PASS for the question-card, same-session steering, and cross-session task-isolation paths. The synchronized card is still visible in the other session while the first turn waits; that presentation policy is separate. |
| L06 | A resumed long goal returns a visible acknowledgement without ordinary chat execution. A scheduled goal stays bound to the chat session that created it, even when the leader window has another session selected. | Resume routing, origin-session persistence, runtime session injection, and scheduler target selection pass in focused tests. | PASS in clean Electron runs: origin-session execution and pause → visible “continue” acknowledgement → one scheduled Flow both settled in the origin session. |
| Evidence gate | File observation, post-write readback, and test execution have distinct requirements. | File reads, readback ordering, successful execution, failed execution, and test-file-only negatives pass. | L01 passed its external-signal recovery run. L03 produced a fresh post-handoff read with a new hash and completed. The strict conversational variant also required a later read before the goal completed; the external-edit run remains the primary handoff evidence. |
| Journal persistence | A per-session journal flush now reschedules a tail event queued while the previous IPC batch is in flight. | Journal persistence regression covers batching, failed writes, replay identity, and the in-flight tail. | PASS in the rebuilt Electron run: an aborted visual turn reached disk with contiguous `seq=0..6`, `pendingCount=0`, and `complete=true`. |
| Adoption | Adoption initializes the scheduler after releasing the effect hold. Concurrent initialization installs one listener. | Held, follower, concurrent initialization, repeated initialization, and disposal pass in an isolated browser. | Adopt a restored profile with a nonempty executable goal and observe its wake without relaunch. |
| Dreaming scope | Dream inputs, existing ideas, new ideas, and idea updates carry user/character scope. | Store isolation and real DuckDB scope filtering pass. Snapshot restore retains idea ownership. | M08 through the public controls, including a role change and a second user. |

Dreaming budgets remain profile-wide. This batch does not introduce per-character budgets.
Unowned historical ideas stay unowned and do not enter scoped prompts.
Parquet restore maps columns by name, so a newly added nullable ownership column does not depend on archive column order.

The first live L06 retest before the session-binding repair is not acceptance
evidence: the scheduler ran the goal in the leader's stale M04 session
`M2kUESOmbDKLdAlHLE6dF` while the visible acceptance session was different.
The repair preserves the origin session on the plan, routes `plan_update` with
the runtime target session, and makes the scheduler use that bound session.

## Live continuation after the code repairs

The following runs were made after the source repair and are additive evidence;
the original acceptance register is unchanged.

| Scenario | Result | Runtime evidence |
| --- | --- | --- |
| L02 workspace guard and recovery | PASS | Goal `cc4a2724-d6ab-420f-8ae8-89eecd376436`, origin `RyBGmiu6SPiWvfF0MbTnH`, leader `X4Zul2fUZ8CwinYiyAKtN`. A root mismatch produced no Flow or tool call. After restoring the bound root, Flow `mj1rdPxaDDengeSqMIsVI` / task `P6l3T6lgOmJxOXJYs0yV6` completed in the origin session. |
| L06 clean origin binding | PASS | Goal `3181af9f-2a2b-4c14-875d-110bda3ce59b`, origin `kHijnmBvEqzTGT7QhACGQ`, leader `pqrTnEMsywNf1BV9EWJrC`. Flow `ocrvHGeFwJ-LGx7mA96Ws` / task `SpOi7W2LmvMtTTD0s6mNO` ended `done`, and all goal evidence stayed in the origin session. |
| L06 pause → continue | PASS | Goal `a466a472-1dda-4613-91f5-0bb4d2fa5ed5` resumed with the visible acknowledgement and produced exactly one scheduler Flow `R50UogcAwo61K71NghAj2` / task `NOMgXwZEXl8rfvF9Hu8Vv`; the goal completed in `kHijnmBvEqzTGT7QhACGQ`. |
| L01 external signal | PASS with a recorded first wait | Flow `Ql7t3Ou-4uMozMtgGeZrS` / task `cW3G1g8ddWMbhdaW1XADu` stopped `no-progress` without writing. After the external `signal.txt` appeared, one recovery Flow `HoCOYsAGSWzJYTYPEUasR` / task `ISHnWrhWWX21o1JnLcR70` wrote and reread `result.txt`; both files contain `ACC-20260907-01-L01-RUNTIME-READY` and share SHA-256 `4FD3A7B1898BD8C2957CC98CE11F9D0C263BA21F111D42F3B236A778AEEA3584`. |
| L03 handoff and fresh read | PASS for fresh evidence; wording follow-up | First read task `HNPsPhUCuby339Mfz3T1P` recorded `status=pending` and raised `user_ask`. After the test harness interrupted that waiting turn and the external file changed, Flow `L3xbsd0UcwHgt2Qq0LjU7` / task `B0teo99q73ewvSHd0A4FB` reread `status=done` with a new base hash and then called `flow_update(done)`. |
| K03 skill reuse | PASS | In session `Nkfj7cm5dydk5NCwAit_e`, three real calls to `acc_20260907_01_dedupe` returned `['a','b']`, `[]`, and `['猫','狗']` for the three acceptance inputs. |
| K04 invalid input | FAIL | The real call with `['a',3,null]` returned `['a']` because the submitted source silently filters non-strings. The following legal call still returned `['q','r']`. No product code was changed to rewrite the artifact or hide this contract gap. |
| K05 restart reuse | PASS | Session `oQWtQkWCZufjVhZgQ1-WP` called the reviewed skill before restart and received `['x','y']`. After the same-profile/CDP restart, the queue still held equal `contentHash`/`reviewedHash` values, the runtime tool was registered, and a real call returned `['restart','ok']`. |
| K06 source mutation | PASS | Editing the approved source caused the next real call to return the product block `Skill source changed. Submit the new source for review.` The artifact error was recorded and the runtime registration disappeared. The exact original source bytes were restored through the product write path and their SHA-256 returned to `c8614bc332049bed243b99d0324aa66f25b4bc59f1fa0cd7f8eac1af7dd9c7f1`. |
| K07 quarantine, rejection, and recovery | PASS | Quarantine moved the entry to probation and removed runtime registration. Exact-hash re-approval restored it; rejection removed the queue and runtime entry; a product submit/re-approve cycle restored the reviewed executable state. A final real call returned `['final','ok']`. |
| D05 approval boundary | PASS | The original journal showed the same denied mutation reissued in the same Flow with a new request ID. The full timeout session `yVeAQYxlmwdB5djGBbjIf` waited `60,036 ms`; the denial receipt, empty stdout, absent file, and ignored late decision were recorded. After the rebuild, session `WzjzSedS1HMpNUf2Xs7EH` produced one denied bash call, then `flow/end: blocked` with no second call, `flow/step`, or approval. |
| D06 question and steering | PASS for the question-card and same-session path | After the repair, exact ordinary-chat session `MC7fN-AwKU49yt_DjCEOS` showed the `user_ask` card with `red`/`blue`, recorded answer `blue` under one request ID, preserved `choice.txt`, and wrote/read `choice-new.txt` without overwriting the original. The stale-answer cross-session variant remains. |
| S13 repeated appearance | PASS for same-value suppression | Session `RgNXYftowLkCDtGIvCSlo` used the real expression writer. Values `1` at appearance sequences 1 and 11 produced one provider turn and one decision; the second heartbeat ended `no-stimulus`. A real change to value `0` at sequence 14 produced a second provider turn and decision. |
| V02 visual cancellation | PARTIAL | Session `5WOw2IQJhQnmYn_2AAWp2` used the fixture image with exactly one UI preview and one persisted `image_url`; real Escape produced `turn/end: aborted`. Journal `f04cb072a9de569c0df3f4326d68c5c5.jsonl` persisted the complete `seq=0..6` run after the journal repair. The controlled capture-failure path must still prove temporary image cleanup and restart/export must prove that a failed frame cannot be reused. See [`V02-vision-cancel-cleanup.md`](evidence/short-scenarios/ACC-20260907-01/V02-vision-cancel-cleanup.md). |

### L03 strict conversational handoff continuation

The strict continuation used session `RA8t6OlzpIZ69PBuUPflp` and fixture
`L03-runtime-conv-20260908`. The first Flow
`z3lA1MUAzVsP6UrDybLiM` / task `wytx-_1y9B6r_ewMwB736` read
`status=pending`, raised a real `user_ask`, and recorded the user's answer.
It then performed a write and a new read showing `status=done` with base hash
`698f11dc`; the long goal stayed in `waiting-condition` after that Flow
because its plan evidence was not yet complete. A scheduler rerun created
Flow `f_aWFxId-9JeTmDPsAuUe` / task `K07SfXpte1s1WUSNJ_n_v`, reread the same
file, and only then completed the goal.

This closes the conversational recheck observation: a user answer alone does
not close the goal, and completion requires a later file receipt. The run let
the agent perform the handoff write after the answer, so it does not replace
the original L03 test where the fixture was changed externally. No new
permission policy for `allowedTools` is inferred from this run; the current
plan contract uses that field for evidence attribution while work turns mount
the standing work surface.

The current main renderer is restored to session `447xo4obMHF4KCJiEbJmc`,
character `n8cz_qXFxNLwpJmuAsfIl`, provider `openai-compatible`, model
`gemini-3.8-flash`, and workspace root `D:/airi`. The leader is running from
the repository build with the explicit user profile and CDP 9250.

## Checks

- Root `typecheck` passed across 56 workspaces.
- Root `lint` passed with existing warnings only; the final full scan exited
  with code 0.
- The core-agent library was rebuilt with its existing tsdown configuration before consumer regression tests.
- Stage UI node checks: 116 tests passed across skills, memory, social stimuli, local persistence, plans, chat, and restore gates.
- Isolated browser checks: 10 tests passed across skill review, long-goal startup/resume, native DuckDB snapshots, and restore owners.
- Core-agent authority and planning checks: 58 tests passed.
- Total: 184 passing tests. These are regression checks, not 184 product acceptance scenarios.
- Final affected-file checks after the settings catalog RPC fix: root `typecheck` exit code 0, root `lint` exit code 0, and 22 affected stage-ui tests passed.
- Additional focused checks after the session-binding repair: 81 core-agent runtime tests, 22 stage-ui plan/scheduler tests, and 12 Electron plan-tool tests passed. The new cross-window scheduler case passed.
- Journal persistence regression: 11 stage-ui journal tests passed, including an event queued while the previous persistence batch was in flight.
- Current Electron run: `electron@43.4.1` from the repository build, profile `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`, CDP `9250`, active provider `openai-compatible`, active model `gemini-3.8-flash`, active character `n8cz_qXFxNLwpJmuAsfIl`. After the rebuild, the original conversation `447xo4obMHF4KCJiEbJmc` was reselected and still contained 272 messages; the workspace root was restored to `D:/airi`.
- Rebuilt Electron V02 cancellation: session `5WOw2IQJhQnmYn_2AAWp2`, turn `17VgYNcosGwb4VAFtUIT4`, UI attachment preview `1`, persisted user message parts `text + image_url`, and durable journal `turn/end` reason `aborted` with `pendingCount=0` and `complete=true`.
- The previous cold-start check opened Settings before any other renderer page; Data → Backup ZIP returned 8,079,850 bytes beginning with ZIP signature bytes `80,75,3,4`.
- K02 Electron flow: the settings catalog submission changed the queue from `0/5` to `1/5`; the source panel showed the artifact source, the approval button changed from disabled to enabled only after viewing, and approval persisted equal content/reviewed hashes. The temporary `opencode-adapter` entry was then removed. The original session `447xo4obMHF4KCJiEbJmc` was selected again and Chat loaded 272 stored messages.

Commands use `corepack pnpm` because the shell stopped resolving the standalone `pnpm` executable during this batch.
Corepack prepared the repository-selected pnpm 11.24.0 with approval. No dependency or lockfile changes were requested.

The tests use isolated browser origins. They do not prove cold-start Electron IPC routing, real provider behavior, or completion of an autonomous goal.
The Electron output was rebuilt after the final source change and relaunched with the explicit profile and CDP variables above. The current instance remains running for follow-up acceptance.
DuckDB emitted dependency sourcemap warnings. The core-agent test command reported a shutdown timeout after passing; its process exited with code 0.

Reproduction commands, from the repository root:

```powershell
corepack pnpm -F @proj-airi/core-agent build
corepack pnpm exec vitest run packages/core-agent/src/authority/gate.test.ts packages/core-agent/src/planning/evidence-gate.test.ts packages/core-agent/src/planning/flow-completion.test.ts packages/core-agent/src/authority/long-goal.test.ts
corepack pnpm -C packages/stage-ui exec vitest run src/stores/modules/memory.test.ts src/stores/modules/life-mode.test.ts src/services/memory/local-memory.test.ts src/stores/skills.test.ts src/stores/plans.test.ts src/stores/chat.contract.test.ts src/services/restore-gate.test.ts
corepack pnpm -C packages/stage-ui exec vitest run src/stores/skills.browser.test.ts src/stores/modules/long-goals.browser.test.ts src/composables/use-duck-db-snapshot.browser.test.ts src/stores/data-backup.browser.test.ts
corepack pnpm typecheck
corepack pnpm lint
```

## Evidence preservation

The lint exclusion is limited to `docs/fork/evidence/short-scenarios/**`.
This directory contains captured payloads and hash-bound sandbox artifacts, including legal sandbox top-level `return` statements.
Product code, ordinary tests, and other documentation remain subject to lint.
No original acceptance record or skill artifact was formatted or rewritten in this batch.

Current SHA-256 values for the original `acc-20260907-01-dedupe` artifacts:

| Artifact | SHA-256 |
| --- | --- |
| source.mjs | c8614bc332049bed243b99d0324aa66f25b4bc59f1fa0cd7f8eac1af7dd9c7f1 |
| selftest.mjs | c535ac573f3b71694df0735655f1ad157fa853b9a6ea792e733d170888dd109e |
| meta.json | 18a31ee90679150af2598ef2f0428ea9b9890552fdb49417f722ab0e16dc82df |

## Runtime verification order

### 1. Establish the instance and isolate the work

Before relaunch, record the executable, launch arguments, resolved userData directory, and build hashes.
Record provider/model identifiers and character IDs without credential values.
Confirm that the intended main conversation still exists, then use a separate acceptance session and workspace.
Do not modify the desktop shortcut or let a scheduled goal write into the main conversation.
Use the original user profile for ordinary checks; use a separate restore profile for destructive or recovery cases.

### 2. Remove the export and review prerequisites

Run R01 from a cold start with the settings window as the first destination.
Then run R02–R07 with nonempty facts, ideas, plans, journal, skills, and held delivery records.
Compare IDs, revisions, source links, and hashes before and after restore.
Provider credentials are excluded from business backups by design; missing credentials in the isolated restore profile are not evidence of original-profile loss.
Keep remote delivery held until its destination is explicit. R06 requires a healthy local backend fixture.

Run K02 through settings and chat: display both artifacts, modify the source, and attempt the old approval.
Repeat with the self-test, then submit and review the intended revision.
Continue the original K03–K07 reuse, failure, revision, retirement, and restart scenarios.

### 3. Locate empty answers before changing their pipeline

Use the same question, model, and scoped facts in paired new sessions with memory on and off.
Correlate session/turn/request IDs with retrieval start/end, `memory/retrieved`, request start, first text, finish, and persisted assistant content.
Capture empty/tool-only/error finishes separately. Redact credentials and unrelated conversation content.
This distinguishes retrieval delay, provider output, stream parsing, and display/persistence failures.
The seeded M01 pair and explicit M02 correction now have runtime evidence in [`runtime-memory-repair-20260908.md`](evidence/short-scenarios/ACC-20260907-01/runtime-memory-repair-20260908.md). The same run exposed a separate gap: ordinary chat correction text does not create a supersede relation. Keep that finding open unless natural-language correction is added to the product contract.
The M07 follow-up is recorded as partial: the Flow operation, same-session
continuity, and focused-mode checks pass, but the natural-language new-session
recall still misses the approved fact. V03 has now been run with a real fixture:
the visual activity and same-session continuation pass, while the new-session
memory retrieval is empty and the answer falls back to workspace tools. Retain
the M03 negative controls and the M04 scope assertions. M08's
two-character public-control run is recorded; add the second-user variant only
if a legitimate second account is available.

### 4. Verify goal ownership and evidence

The live continuation below records L01/L02/L03 receipts with their original
planId, stepId, intent, tool arguments, outcome, and missing-evidence reason.
Compare the step at tool dispatch with the step at tool completion. Do not reassign evidence to make a goal pass.
For L02, record root-change emission, leader refresh completion, execution entry, and actual host/tool workspace arguments.
For L06, create the goal from one session while the leader has another
conversation selected. Verify that `plan.sessionId`, `lastRun.sessionId`, the
Flow's session, the `chat.send` payload, and the target journal all use the
origin session; the leader selection must not become the target. Then pause
and explicitly resume once, counting goal/run/Flow identities through
settlement. A clean run must not reuse the pre-fix M04 session.
Then run L04/L05 restart/adoption and L07 revision-during-work cases in the isolated session.

### 5. Verify approval, social, and visual boundaries

For D05, correlate requestId, toolCallId, and Flow iteration to distinguish same-request continuation from a later Flow retry.
Wait beyond the full 60-second approval timeout, record its denial receipt, and try a late decision without executing the denied action.
For D06, compare actual tool schemas in ordinary chat and explicit work Flow before attributing the missing question card to model behavior.

For S13, repeat the same appearance value under new event IDs, then change the value and test recurrence after the novelty window.
For S20, delay a genuine speak decision until after user input; check for stale publication after the user turn ends as well as during it.
Do not use a silence decision as proof of the late-speak race.
Rerun S07 with autonomous mode actually enabled during a running Flow.
Use isolated fixtures for quiet hours, focused work, real speech playback, no-session startup, scoped memories, corrected memories, and stale stimuli.
Do not delete the main session to produce S10 or edit old evidence to create S18.

For V01, use known text and shapes in the same captured frame and distinguish OCR/model failure from a missing image.
For V02, interrupt between capture and consumption, then confirm stale frames cannot enter the next request.
V03 now has a real visual-activity record and shares the new-session recall
diagnosis above; the memory-backed source and retrieval checks remain open.

New runs get separate evidence files and explicit PASS/FAIL/BLOCKED results.
The original register remains unchanged. An old PASS without the required runtime conditions does not close its retest.

## Remaining runtime verification plan

| Item | Verification procedure | Pass condition |
| --- | --- | --- |
| K04–K07 | First decide the reviewed tool contract for invalid JSON-schema input. Then rerun invalid input, legal recovery, same-profile restart, source/self-test mutation, re-review, rejection/quarantine, and two-window duplicate decisions. | Invalid input produces an explicit contract failure without transformed success; legal input still works; old hashes and retired entries cannot execute. |
| M07/V03 | M07 still needs an approved fact created by the Flow itself, with `flow/start`, `turn/start/end`, `memory/retrieved`, provider request/first text/finish, source context, and a genuinely new-session probe correlated. V03's real fixture, image upload, visual description, user choice, and same-session continuation are recorded; repeat only the memory-backed part after the source contract is fixed. | M07 retrieves the Flow-owned fact when memory is enabled and excludes it when disabled. V03's new session retrieves the activity fact without workspace fallback, and the fact points to the original activity rather than the recall question. |
| D05/D06 | D05 is now covered by the full 60-second timeout and late-decision run plus a post-rebuild denial retest. D06 has exact ordinary-chat question-card, same-session steering, and second-session isolation evidence. | D05 has no post-denial mutation retry and late approval cannot execute. D06 keeps the question and answer correlated to the original request/task, and answering an old card cannot advance a different session's task. |
| S13/S20 | S13 now has same-value and changed-value evidence. Run one post-window recurrence. For S20, delay a genuine `speak` decision until after user input. | Equivalent changes make no second model call; real changes and post-window recurrence do; a stale late `speak` is not published. |
| V02 | The cancellation checkpoint now has a rebuilt Electron pass with one image preview, one image part, an aborted turn, and a complete on-disk journal. Run a controlled image-capture failure, inspect temporary attachment/blob cleanup, restart, and try a new-session probe. | Cancellation stops the active turn; failed capture leaves no reusable attachment; restart/export retains the failure boundary and does not present the stale frame as new evidence. |
| Adoption | Restore a nonempty profile with an executable goal while restore effects are held. Trigger adoption through the real backup path, observe the `backupAdopted` callback, and wait for one scheduler wake without relaunching. Repeat adoption and inspect listener count. | The scheduler starts only after adoption, wakes the restored goal once, and repeated adoption does not install duplicate listeners or duplicate work. |
| R02–R07 and L04–L07 | Use isolated restore profiles and dedicated fixture roots. Compare pre/post IDs, hashes, activeRun/lastRun, Flow boundaries, and side-effect counts; inject crashes only after a run is visibly active. | Restore and crash recovery preserve evidence and do not repeat completed writes; revision/cancel/competition cases settle to one current owner. |
| M08 second user | Only if a real second account is available, repeat public dreaming after switching user and character through normal UI. | Ideas and source memories never cross user or character scope; otherwise record BLOCKED rather than substituting a store user id. |

## 2026-09-09 continuation: repair results and remaining acceptance work

This section is additive. It does not replace the earlier FAIL, PARTIAL, or
BLOCKED records in this document or in the original scenario register.

### Repairs closed by code and regression evidence

- R01 now registers the leader-owned backup store before the settings window
  can call export. K02 now exposes the reviewed source and self-test and binds
  approval to the inspected source hash.
- S13 now deduplicates equivalent novelty across heartbeat rounds. S20 has a
  deterministic delayed-`speak` race regression. The evidence gate separates
  file observation, write readback, and test execution.
- L06 has one scheduler-owned resume path. Adoption starts the long-goal
  scheduler after restore and remains idempotent. A persisted running goal is
  now rebound by `goalId`, `planId`, `stepId`, `flowId`, `taskId`, and session
  on renderer restart.
- Flow tool-result attribution now remembers the step selected when a tool
  call was emitted. This covers the provider case where `plan_update focus`
  and a work call are emitted together and their results settle out of order.
- V02 capture failure now releases the temporary frame and does not reuse a
  failed frame. K04 input validation rejects malformed or non-object tool
  input before execution.

Regression evidence is green: core-agent orchestration and authority tests
passed 91/91; long-goal browser tests passed 4/4; stage-ui focused social,
mirror, skills, and plan tests passed 39/39; Electron scheduler and coding
host tests passed 12/12. Serial workspace typecheck passed 56/56 workspaces.
The final root lint passed with existing warnings only. No product commit was
created.

### Latest runtime results

- **M07: PASS for the Flow-owned source chain.** Flow session
  `eyKL_Wzbi4C99RdQR6gRj` used Flow `n8KqJ1Et6J7o6Tk7y3cSw` and task
  `iY28hrVIdZ3ZjLnWFu_XE` to create `workspace/M07-flow-memory-20260909/marker.txt`.
  The approved fact `17edcfbe-6195-4369-a2de-d37f9623afca` points to the task
  source. The enabled-memory query `ihapa7PsW4DmImuDX9xvW` retrieved it; the
  disabled-memory control `Z8zjfXAZEPHtkWBFFr-T1` recorded `memoryIds: []`.
  Earlier natural-language recall failures remain preserved as historical
  evidence.
- **V03: PASS for the fresh source/retrieval chain.** Activity
  `coFoM_lKu2TXnC__ZyGTh` and fresh recall `SRKUxO_1l_Kj3SPpC76u-` were run
  with the checked-in image fixture. The approved fact
  `4c211389-4f6a-45d1-91ee-571a592624c2` has `sourceType: chat`, and the fresh
  retrieval returned that memory ID. Earlier no-retrieval results remain
  preserved.
- **L04: PARTIAL, with the restart recovery boundary demonstrated.** In the
  scheduler-owned run `qL906jeE8-UjN2alkiEhn / 8092EfV5Jo6TW1p_A9VPT`, the
  foreground `sleep 120` returned a failure after the Electron restart. The
  same run then issued one write of `CRASH-RECOVERY-V4-20260909` and one
  readback. The old build's final evidence gate still marked step 3
  `unverified`; the new attribution regression passes, but a clean live
  completion retest is still required.
- **S13: PASS under controlled post-window evidence.** Same-value repeats are
  suppressed, changed values remain eligible, and a fake 31-minute clock
  advance allows recurrence. A real 30-minute wait was not performed.
- **S20: PASS in the deterministic delayed-speak regression.** The live
  silence branch also passed; a live provider-delayed speak run remains open.
- **V02: PARTIAL.** Cancellation, durable aborted journal persistence, and
  controlled capture failure cleanup pass. Restart/export cleanup and a
  fresh-session stale-frame probe remain open.
- **K04: PASS at the input-contract and regression boundary.** K05–K07 still
  need the full UI review, mutation, rejection, retirement, and duplicate
  two-window run.
- **D05/D06: code and focused regression coverage are ready, but the old live
  FAIL records remain open.** D05 still needs the full 60-second timeout and
  late-decision boundary. D06 still needs a real ordinary-chat versus
  explicit-Flow tools comparison and a question-card/answer correlation run.
- **Adoption: PASS for initialization and listener idempotence in regression
  tests; live wake remains open.** The live wake requires a non-empty
  executable restored goal and a provider request.
- **R02/R03/R07:** existing UI/packaged restore evidence is retained as
  passing. R04 and R06 remain environment-blocked; R05 has restore-content
  coverage but its provider/skill/embedding acceptance is not closed.

### Remaining work and exact verification order

1. Restore provider balance or use an explicitly approved healthy test
   endpoint. The current provider returned HTTP 403 for the latest scheduler
   attempts, so no new model-call result should be treated as a product
   failure until that external condition is fixed.
2. In a fresh isolated profile, rerun V02 with a capture failure between frame
   creation and consumption. Inspect the temporary frame/attachment store,
   restart, export, and make a new-session probe. The pass condition is no
   reusable failed frame, no stale image part in the next request, and a
   persisted failure boundary.
3. Build a non-empty backup containing one executable long goal, restore with
   effects held, adopt through the real UI, and observe exactly one scheduler
   wake without relaunch. Repeat adoption and compare listener and Flow
   counts. This closes the live adoption item.
4. Re-run R04/R05 with the same isolated restore profile: adopt only after the
   receipt, configure the provider through settings, verify reviewed skill
   source/hash and embedding migration, and confirm no credential bytes enter
   the archive. Prepare a dedicated Postgres/sync fixture before R06; record
   outbox ID, attempt count, backoff, reconnect, and restart behavior.
5. Re-run L04 with unique plan and step IDs after the provider is healthy. Kill
   Electron only while the scheduler-owned tool call is visibly pending. On
   restart, correlate the same run IDs, confirm one write and one readback,
   and require a green evidence gate. Then run L05 by changing the workspace
   or removing its input before restart; expect visible waiting/failed state
   and no duplicate side effect. Run L07 by changing the requirement while a
   write is pending; assert the new constraint version owns the only accepted
   write.
6. Re-run L01–L03 with unique plan and step IDs. For L02, record the root
   change, leader refresh completion, execution entry, and actual host/tool
   path. For L03, change the file manually and verify the readback is linked
   to the same step. For both, require no stale-root argument and no
   `unverified` step.
7. Re-run D05 after waiting the complete 60 seconds, then submit a late
   approval and inspect request, tool-call, and Flow iteration IDs. Re-run D06
   by comparing the actual tools request in ordinary chat and explicit work
   Flow, then answer the visible question card and verify that only the
   originating task advances.
8. For M-series empty answers, pair the same question with memory enabled and
   disabled and correlate retrieval start/end, provider request, first text,
   finish, and persisted assistant content. Do not tune retrieval thresholds
   from a tool-only or wrong-source response.
9. Run M08 only with a legitimate second account. Without one, keep it
   BLOCKED rather than substituting a store-level user identifier.

The current Electron instance is restored to the original main session
`447xo4obMHF4KCJiEbJmc`, character `n8cz_qXFxNLwpJmuAsfIl`, workspace
`D:/airi`, the configured provider/model, and CDP `9250`. There is no active
Flow. The live provider blocker is recorded above; it is not a reason to
change the provider implementation.

### 2026-09-09 continuation: backup restore and bad-archive retest

The R01 export gate now has a rebuilt Electron result: the Data page produced
an 11,096,415-byte archive with 138 entries, all seven business domains,
credentials excluded, outbox held, and the legacy journal included. The
archive then passed the R02 isolated staging and relaunch path. The new
profile reached a durable `complete` marker with `effectsHeld: true`, and the
first restored renderer loaded two characters and 102 sessions. A second boot
confirmed that the session payloads and original-user index were persisted,
but the unauthenticated `local` UI could not select that original owner index.
The original profile was reopened afterward with its provider configuration
and main conversation intact.

The first restore attempt found and fixed a schema gap for persisted AIRI
`role: "error"` messages. The focused restore suite passes 3/3. Two R07 bad
archive variants were rejected by the real Data page without creating another
restore profile or changing the original active chat. Detailed evidence is in
[`R01-R02-R07-retest-20260909.md`](evidence/short-scenarios/ACC-20260907-01/R01-R02-R07-retest-20260909.md).

R02's full data-visibility condition and R03's normal-UI semantic comparison
remain partial until the restore contract decides whether P' requires normal
re-authentication or remaps the owner scope safely. R04 adoption and live
wake, R05 provider/skill/embedding checks, and R06 sync-backend behavior also
remain open. Provider balance is still an external blocker for model-dependent
checks.
