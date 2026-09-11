# Acceptance repair runtime record

- Date: `2026-09-08`
- Run: `ACC-20260907-01-repair`
- Runtime: repository `electron@43.4.1`, `apps/stage-tamagotchi/out`, CDP `9250`
- User data: `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`
- Provider/model identifiers: `openai-compatible` / `gemini-3.8-flash`
- Original conversation: `447xo4obMHF4KCJiEbJmc`, character `n8cz_qXFxNLwpJmuAsfIl`
- Main conversation content was not edited. The active session pointer was restored to the original conversation after the checks.

## R01 — PASS

1. Stopped the previous Electron run.
2. Started the current build with `APP_USER_DATA_PATH`, `APP_REMOTE_DEBUG=true`, `APP_REMOTE_DEBUG_PORT=9250`, and `APP_REMOTE_DEBUG_NO_OPEN=true`.
3. Opened the Settings window before Chat or another settings module.
4. Entered `Settings -> Data` and invoked `Backup ZIP`.
5. The follower action returned `8,079,850` bytes. The first four bytes were `80,75,3,4`, the ZIP signature.

This proves that the leader backup owner is registered during cold boot. The browser download destination was not used as evidence; the returned byte payload was checked directly.

## K02 — PASS for the catalog flow; workspace continuation pending

1. Opened Settings -> Modules -> Self-authored tools in a follower window.
2. Submitted the catalog `opencode_delegate` entry. The queue changed from `0/5` to `1/5`.
3. Opened the source panel. The displayed source hash was `7b06c9e2292a8160`.
4. The approval button was disabled before viewing and enabled after viewing.
5. Approval persisted equal `contentHash` and `reviewedHash` values.
6. Removed the temporary catalog entry after the check. The original `acc-20260907-01-dedupe` entry remained reviewed.

The settings catalog now applies `toRaw` and `structuredClone` before the synced-store RPC. Without this boundary, the same click produced a `DataCloneError` for nested Vue proxies.

The real workspace artifact source and self-test are visible in the shared panel. A real source edit followed by the old approval is covered by the isolated browser regression, but the full workspace K03-K07 sequence remains pending.

## M diagnostic control — NOT A PASS for memory acceptance

Two new sessions were created so the original conversation was not used:

| Session | Memory state | Event result |
| --- | --- | --- |
| `ghu0Hr9cJHBzmgb-bHuO8` | enabled | user + assistant, assistant length 21, `assistant/done` present |
| `RoEFYvhkNDdroRGjfOKPe` | disabled | user + assistant, assistant length 21, `assistant/done` present |

Both runs used the same question, provider, model, character scope, and `maxSteps: 1`. Both journal projections contained `turn/start`, `memory/retrieved`, `assistant/chunk`, `assistant/done`, and `turn/end`; both had an empty `memoryIds` list. This confirms that the current provider and stream persistence path can produce a non-empty answer, but it does not test recall of a seeded fact or explain the historical new-session failures.

The memory setting was restored to enabled after the control. The two diagnostic sessions were not used for the main conversation.

## Follow-up memory scenarios

The seeded and reviewable runtime scenarios continued in the companion record
[`runtime-memory-repair-20260908.md`](runtime-memory-repair-20260908.md).
M01/M02 were already recorded there. The same run then completed M03 unknown
information and false-premise refusal, M04 character scope isolation, M05
date-specific recall, and M06 remembered-text injection resistance. Those
results use separate acceptance sessions and do not modify the main
conversation.

## Automated checks after the final source change

- `corepack pnpm -F @proj-airi/stage-tamagotchi build`: exit code 0
- `corepack pnpm -F @proj-airi/stage-ui exec vitest run src/stores/skills.test.ts src/stores/skills.browser.test.ts src/stores/modules/long-goals.browser.test.ts`: 22 tests passed
- `corepack pnpm typecheck`: exit code 0, 56 workspaces
- `corepack pnpm lint`: exit code 0, existing warnings only
- Original evidence artifact hashes were unchanged; see the SHA-256 table in `docs/fork/acceptance-repairs-20260908.md`.

## L06 — origin-session binding: PASS

The live diagnostic before this repair is excluded: the goal was visible in
one acceptance session, but the leader scheduled its Flow in the stale M04
session `M2kUESOmbDKLdAlHLE6dF`.

The repair now retains the origin `sessionId` for long plans, reads plan
evidence from that session, passes the runtime target into `plan_update`, and
has the scheduler select and scope-check the bound session. Focused coverage
passed in 81 core-agent runtime tests, 22 stage-ui plan/scheduler tests, and 12
Electron plan-tool tests. The browser regression uses different origin and
leader selections and asserts the scheduler start and send target.

The clean Electron retest is recorded below. It created a goal in one session,
selected another session in the leader, and correlated the plan, run, Flow, send
payload, and journal event session IDs through settlement. The prior M04 session
did not receive the run.

## Still pending

M07 and V03 still require their task-source/continuity and real visual-activity
checks. The two-character public-dreaming scope check is recorded; a second
user variant remains conditional on a legitimate second account. The remaining
unverified procedures and the original acceptance register remain in
`docs/fork/acceptance-repairs-20260908.md`; live L01–L03 and K03–K04 results are
appended below.

## Live continuation after the source repairs

These entries are additive to the original record. They preserve the earlier
pre-fix failures and do not rewrite the acceptance register.

### L02 — workspace guard and recovery: PASS

- Origin session: `RyBGmiu6SPiWvfF0MbTnH`
- Leader-selected session: `X4Zul2fUZ8CwinYiyAKtN`
- Goal: `cc4a2724-d6ab-420f-8ae8-89eecd376436`
- First wake: the coding root differed from the goal root. The goal moved to
  `waiting-condition` with `The current workspace root does not match the goal scope.`
  No Flow or tool call was created for that rejected wake.
- Recovery: after restoring the goal root, Flow
  `mj1rdPxaDDengeSqMIsVI` and task `P6l3T6lgOmJxOXJYs0yV6` ran in the origin
  session and completed after reading `brief.txt`.

### L06 — clean origin binding and pause/resume: PASS

The clean cross-window run created goal `3181af9f-2a2b-4c14-875d-110bda3ce59b`
in origin session `kHijnmBvEqzTGT7QhACGQ` while the leader selected
`pqrTnEMsywNf1BV9EWJrC`. Flow `ocrvHGeFwJ-LGx7mA96Ws` / task
`SpOi7W2LmvMtTTD0s6mNO` ended `done`; the goal's `lastRun.sessionId`, Flow
session, tool results, and plan updates all stayed in the origin session.

The pause/resume run used goal `a466a472-1dda-4613-91f5-0bb4d2fa5ed5` in the
same origin session. The explicit `继续` message persisted the visible
long-goal acknowledgement and did not create an ordinary model turn. One
scheduled Flow `R50UogcAwo61K71NghAj2` / task `NOMgXwZEXl8rfvF9Hu8Vv` then
completed the goal. The leader selection did not become the execution target.

### L01 — external signal and recovery: PASS with first-wait evidence

Goal `l01-runtime-20260908` ran in origin session `csmgDTbXhbGlcFDBhALfd` while
the leader selection was `0olxg7bacXFH2NKuOiA9H`. The first Flow
`Ql7t3Ou-4uMozMtgGeZrS` / task `cW3G1g8ddWMbhdaW1XADu` observed that
`signal.txt` was absent and ended `no-progress` without creating a file. The
goal remained waiting rather than claiming completion.

After the external signal appeared, the recovery Flow
`HoCOYsAGSWzJYTYPEUasR` / task `ISHnWrhWWX21o1JnLcR70` listed the directory,
read the signal, wrote `result.txt`, and reread it. Both files contain exactly
`ACC-20260907-01-L01-RUNTIME-READY`, with SHA-256
`4FD3A7B1898BD8C2957CC98CE11F9D0C263BA21F111D42F3B236A778AEEA3584`.

### L03 — human handoff and fresh read: PASS for fresh evidence

The first task `HNPsPhUCuby339Mfz3T1P` read `decision.txt` as
`status=pending` and raised a `user_ask` at journal sequence 72. The waiting
turn was interrupted during test cleanup. After the test-side external change
to `status=done`, the next Flow `L3xbsd0UcwHgt2Qq0LjU7` / task
`B0teo99q73ewvSHd0A4FB` issued a new `read` at sequence 87; its result at
sequence 88 showed `status=done` and base hash `698f11dc`, instead of the
first read's `4d2e3329`. Only then did it call `flow_update(done)` and end.

This proves that the second completion used a new read and not the pending
receipt.

### L03 — conversational handoff continuation: PASS for the recheck boundary

The strict conversational variant ran in session `RA8t6OlzpIZ69PBuUPflp`.
Flow `z3lA1MUAzVsP6UrDybLiM` / task `wytx-_1y9B6r_ewMwB736` first read
`status=pending` at sequence 11, raised `user_ask` at sequence 14, and
received the text answer at sequence 16. After the answer, the Flow did not
settle from the old pending receipt: it wrote `status=done` at sequence 31,
then read the file again at sequence 33 and observed the new base hash
`698f11dc`. The first Flow ended `done`, but the long goal correctly remained
`waiting-condition` because its step had not yet been verified by the plan
projection.

An explicit scheduler rerun created Flow `f_aWFxId-9JeTmDPsAuUe` / task
`K07SfXpte1s1WUSNJ_n_v`. It read `status=done` at sequence 89, declared the
Flow complete only afterward, and the goal reached `completed` at sequence
129. This confirms the user answer alone does not close the goal and that a
later read is required. Because this variant let the agent perform the
handoff write after the user's answer, it is evidence for the recheck boundary,
not a replacement for the original externally edited L03 run.

### K03/K04 — real reviewed-skill calls

With the coding root set to the acceptance workspace, session
`Nkfj7cm5dydk5NCwAit_e` made three real calls to
`acc_20260907_01_dedupe`. The results were `['a','b']`, `[]`, and `['猫','狗']`,
matching the K03 inputs.

The K04 input `['a',3,null]` returned `['a']` rather than a contract error.
The submitted source silently ignores non-string values. A following legal
call returned `['q','r']`, so the failure did not poison later execution. This
is a real K04 contract failure, not evidence against the K02 source-review
hash binding. The artifact was not modified during the run.

### K05–K07 — restart, artifact invalidation, and lifecycle recovery: PASS

The lifecycle continuation used session `oQWtQkWCZufjVhZgQ1-WP` and the same
profile and CDP instance described at the top of this record. Before the
restart, a real call to `acc_20260907_01_dedupe` returned `['x','y']`. The
Electron process was then closed and relaunched from the repository build with
the same `APP_USER_DATA_PATH` and CDP `9250`. After startup, the queue still
showed `reviewed` with equal source and reviewed hashes, the runtime tool was
registered, and a real call returned `['restart','ok']`.

For K06, the source was changed after approval. The next real execution was
blocked with `Skill source changed. Submit the new source for review.` The
queue retained the old reviewed hash but recorded the artifact error, and the
runtime registration was removed. The original source bytes were restored
through the product write path with its base hash. The source length was 409
bytes, used LF line endings, had no final newline, and returned to SHA-256
`c8614bc332049bed243b99d0324aa66f25b4bc59f1fa0cd7f8eac1af7dd9c7f1`; the
self-test hash remained
`c535ac573f3b71694df0735655f1ad157fa853b9a6ea792e733d170888dd109e`.

For K07, quarantine moved the tool to `probation`, recorded
`compatibility_mismatch`, and removed its runtime registration. Clearing the
quarantine and approving the exact source and self-test hashes restored the
reviewed state and runtime registration. Rejecting the entry removed both the
queue entry and runtime tool. The entry was then submitted and approved again
through the product lifecycle so the acceptance workspace ended in its
original reviewed, executable state. A final real call returned `['final','ok']`.

This closes the restart, stale-artifact, quarantine, rejection, and recovery
boundaries. K04 remains a separate FAIL because the submitted artifact still
filters non-string values instead of returning an explicit input-contract
error; no product code was changed to hide or rewrite that artifact behavior.

### D05 — approval denial, timeout, and late decision: PASS

The original rejection evidence was checked against the persisted journal
`34bd2993c384a8b5cdf33451f58a7e0c.jsonl`. The rejected bash call at sequence
330 received approval request `coding-approval-3` at sequence 331 and a denied
tool result at sequence 334. The same Flow
`0FDU2PXQs5c5CO1TO_9UM`, task `JHGeFBm0mYdrlP1RTCRck`, and next iteration then
issued the identical mutation again at sequence 349 with a new request ID
`coding-approval-4`. That is the original same-Flow retry failure.

The full timeout run used session `yVeAQYxlmwdB5djGBbjIf` and request
`coding-approval-1`. After `60,036 ms`, the host returned
`status=denied`, `reason=approval_required`, and an empty stdout; the target
file was absent. A late decision for the same request ID was ignored by the
host, and the file stayed absent. This run also recorded the pending card
being removed and the approval decision in the journal.

After rebuilding core-agent and the Electron renderer, the live rejection
retest used session `WzjzSedS1HMpNUf2Xs7EH`, Flow
`O8mg4gb6DpDkXP76eAQjn`, and task `3Ct-bUjwaThDGDXzjxjVW`. The denied bash
call appeared once at sequence 8, approval `coding-approval-1` was denied at
sequence 10, and the Flow ended `blocked` at sequence 20. There was no second
`tool/call`, `flow/step`, or approval request, and the target file was absent.
The existing core-agent regression now marks denial and timeout as a terminal
blocked boundary and blocks mutation tools until that boundary settles.

The later wrap-up turn (sequences 21–34) contained no mutation tool call. The
provider received a user-facing completion after the blocked Flow, so the
retest closes the original “fresh approval request in the same Flow” failure.

### S13 — repeated appearance value and real change: PASS

The live check used isolated session `RgNXYftowLkCDtGIvCSlo` and the real
Live2D expression write path for `liuhan`. The first write of value `1`
created `appearance/changed` sequence 1. Its manual heartbeat emitted one
consideration, one provider turn at sequence 3, and one silence decision at
sequence 10 with source reference `appearance:1`.

A second write of the same value created a new event at sequence 11. Its
heartbeat ended with `outcome=no-stimulus` at sequence 13. No second provider
turn or life decision appeared. This proves that the durable novelty key
suppresses an equivalent recent event, even when the event ID is new.

The next real change to value `0` created sequence 14. Its heartbeat emitted a
second provider turn at sequence 16 and a second silence decision at sequence
22 with source reference `appearance:14`. The changed value therefore remains
eligible for consideration. The expression was left at its default value, and
Life Mode was restored to `off` after the run.

### D06 — ordinary-chat question card and steering: PASS after tool-surface repair

The source diagnosis compared the tool names resolved for two real requests.
An ordinary chat request resolved `[]`, while an explicit work request resolved
the work surface plus `user_ask`. The ordinary Electron composer did not pass
that reference, even though the built-in executor was registered. The repair
adds the blocking question reference to the ordinary composer request and
keeps the executor unchanged.

The exact Chinese D06 request ran through the rebuilt Electron chat window in
session `MC7fN-AwKU49yt_DjCEOS`, using the original profile, provider
`openai-compatible`, model `gemini-3.8-flash`, and character
`n8cz_qXFxNLwpJmuAsfIl`. The persisted journal is
`2d9dac2560b75b9753504c77c0734b64.jsonl`. It recorded `user_ask` at sequence
7, `user/asked` at sequence 8 with choices `red` and `blue`, and
`user/answered` at sequence 9 with the same request ID and answer `blue`.
The UI displayed the question card and its two choices before the answer.

An earlier isolated pass created `workspace/D06/choice.txt` with a real
`bash` write and readback. The exact-text pass then confirmed that file with
the product `read` tool after the existing file's hash caused a safe
`state_changed` write result; the file remained `blue`.

The follow-up steering request in the same session read `brief.txt` and
`input.txt`, wrote `workspace/D06/choice-new.txt`, and reread both the new and
old output. The write result was `ok`; the new file contains
`project=ACC-20260907-01-D06` and `input_lines=2`, while the original
`choice.txt` remains `blue`. The steering flow used task
`miIc-IfS_M2yUN39Xqvli`; no answer from another session was used. The coding
workspace root was restored to `D:/airi` through the chat UI and its
`setWorkspaceRoot` result was recorded at sequences 391–393.

The question-card gate, same-session steering, and cross-session task
isolation now pass. The synchronized card's presentation policy remains a
separate UI question.

### D06 — cross-session stale-answer isolation: PASS

The isolation run used two fresh sessions in the same original profile. Session
`hrDOm1lJ2OOeVSQLr3fdR` raised the question with request ID
`a978d1f1-b460-40d5-9121-abddbe19de4f` at journal sequence 8. The chat window
then switched to session `x-4qvCBonGtxCkyp-thJ3`, sent an independent message,
and left that message queued while the first turn was waiting.

The answer button was clicked while session B was visible. The answer was
recorded in session A with the same request ID at sequence 9. Session A's Flow
`gEzZmZeJvl__uZdZfCg_i` / task `GZdw7XHOvwdJJyqsngU9L` then wrote and reread
`workspace/D06-cross-session-a/choice.txt` as `red`. Session B's queued message
later started its own Flow `nJFD2I5S_X39n8r9gDvd3` / task
`OGdcTB1oDRpgXKzsg8Kqt`, wrote and reread
`workspace/D06-cross-session-b/marker.txt` as `B-only`, and had no
`user/answered` event or tool result carrying the answer from session A.

The old answer therefore did not advance session B's task. The synchronized
question card is still rendered in B while A is waiting because the pending
question store is window-shared; that is a separate presentation-policy choice,
not a cross-session task mutation observed in this run.
