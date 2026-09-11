# ACC-20260907-01 interim seven-dimension summary

This is an interim result. It is not a claim that the seven batches are complete.

| Dimension | Current result | Evidence |
| --- | --- | --- |
| B baseline and connection | B01 PASS after the preserved initial failure; B02 PASS after a preserved blocked attempt and UI retest | [B01](B01-build-identity.md), [B02](B02-profile-provider-smoke.md) |
| D execution and approval | D01-D04 PASS; D05 FAIL on rejection retry with timeout/late BLOCKED; D06 FAIL at question-card gate; D07 PASS; D08 PASS with same task/flow projection across chat and settings | D01-D08 evidence files and register |
| M memory and identity | M01/M02 extracted visible fragments but failed to produce valid new-session answers; M03 passed unknown/false-premise isolation; M04 role isolation passed but role-scoped recall failed; M05-M07 failed on new-session response/retrieval; M08 BLOCKED | [M01](M01-memory-recall.md), [M02](M02-memory-correction.md), [M03](M03-unknown-and-false-premise.md), [M04](M04-role-and-user-isolation.md), [M05](M05-historical-dates.md), [M06](M06-memory-data-not-command.md), [M07](M07-shared-experience-and-mode.md), [M08](M08-dreaming-isolation.md) |
| L long goals and recovery | L01 retest completed the file path in an isolated session, but the plan left step-1 unverified; L02 observed a UI workspace switch but the long-goal run used its stale root; L03 correctly waited for manual file change and re-read the result, but retained unverified plan flags; L04-L05 are blocked by the failed R01 prerequisite; L06 persisted pause but failed to produce a scheduler-owned resume/settlement; L07 received a mid-run revision but had already written the old output and did not settle its evidence projection; the original L01 run was invalidated after session-isolation breach | [L01](L01-wait-and-wake.md), [L02](L02-workspace-change.md), [L03](L03-manual-handoff.md), [L06](L06-pause-resume-cancel.md), [L07](L07-revision-and-competition.md) |
| S social stimuli | S01-S02 PASS; S03 BLOCKED because no public scheduled-heartbeat path enters quiet hours; S04-S07 PASS; S08-S10 BLOCKED; S11-S12 PASS; S13 FAIL on repeated-stimulus deduplication; S14-S15 PASS; S16-S18 BLOCKED; S19-S20 PASS | [S01-S03](S01-S03-social-trigger-gate.md), [S04-S05](S04-S05-social-gates.md), [S06](S06-streaming-busy.md), [S07-S20](S07-S20-social-stimuli.md), and register |
| V vision | V01 FAIL: image upload and shape recognition worked, but the visible marker text was missed; V02 stale-frame guard passed but stop checkpoint was unavailable; V03 visual activity passed but new-session recall failed | [V01](V01-vision-shapes.md), [V02](V02-vision-cancel-cleanup.md), [V03](V03-vision-shared-activity.md), and register |
| K skills | K01 PASS with retained failed submissions; K02 BLOCKED because the settings page does not expose source/self-test; K03-K07 blocked by K02 | [K01](K01-skill-submit.md), [K02](K02-skill-review-ui.md) |
| R backup and restore | R01 FAIL at `Backup ZIP`; R02-R07 BLOCKED | [R01](R01-business-backup.md) and screenshot |

## Current blockers

1. The first B02 request produced no token or persisted user/assistant message during the ordinary-response diagnostic window. A fresh UI session later completed both B02 probes with the same provider/model, so B02 is now PASS with the initial failure retained.
2. The Data settings `Backup ZIP` action fails before producing an archive because the `data-backup` store does not expose its synced `exportSnapshot` action in the leader.
3. New-session memory probes can extract visible fragments, but the provider/runtime path sometimes returns an empty assistant message or no recalled fact. M01 and M05-M07 are recorded as failures with their exact sessions.
4. M04 did not leak identifiers between roles, but the custom-role probe could not recall its expected existing identifier. The full role-isolation case therefore remains FAIL.
5. The L01 file operation works in an isolated session, but the plan evidence state leaves `step-1` unverified. The original L01 attempt was invalidated after it selected the restored session; no further goal run is allowed to target that session.
6. L03 correctly re-read a manually changed file, but its completed plan still retained `unverifiedSteps`; the long-goal evidence gate needs a fix before L01/L03 can be full passes.
7. L02 showed that the Coding UI can switch roots, but a long-goal run can retain the root captured at plan creation; the environment-change gate is therefore FAIL.
8. S03 still lacks a compliant public scheduled-heartbeat path inside quiet hours. The appearance-change trigger is available through the normal Live2D tool surface; S01-S02, S04-S07, S11-S12, S14-S15, and S19-S20 have valid runs.
9. S08-S10 and S16-S18 remain blocked by missing public runtime prerequisites. S13 shows that a repeated appearance change can still reach another social consideration even though no duplicate speech was published.
10. V01 missed visible text in an uploaded image, and V03 could complete the visual activity but failed new-session recall.
11. The skills review page shows the queue entry but not its source or self-test, so the source-binding gate cannot be completed through UI.
12. L07 accepted a revised output path, but an already-started write to the old path was not retracted or prevented. Its plan projection also remained stuck on missing verification evidence.

## Closure status

- A1 compile/build finding: closed by B01 evidence.
- A2 dreaming: not evaluated; M08 has no valid run.
- A3 restore adoption: not evaluated; no R01 archive.
- A4 long-goal settlement: not evaluated; L04-L06 have no valid run.
