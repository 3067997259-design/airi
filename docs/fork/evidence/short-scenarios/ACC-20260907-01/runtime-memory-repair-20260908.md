# Memory runtime repair evidence

- Date: `2026-09-08`
- Run: `ACC-20260907-01-memory-repair`
- Runtime: repository `electron@43.4.1`, `apps/stage-tamagotchi/out`, CDP `9250`
- User data: `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi`
- Provider/model identifiers: `openai-compatible` / `gemini-3.8-flash`
- Character: `n8cz_qXFxNLwpJmuAsfIl`
- Main conversation: `447xo4obMHF4KCJiEbJmc`; it was not used for the fixture turns

The fixture key was `ACC-20260908-M-REPAIR`. The memory and chat settings were
restored to enabled after the checks. The test sessions and test facts remain
isolated records; no main-conversation message was edited.

## M01 — seeded recall with memory enabled: PASS

1. In the new session `8NbohX7yOFokAjTAtWdcQ`, the user supplied the scoped
   fact that the test plant was named `紫杉`.
2. The assistant acknowledged the fact without using a tool.
3. The pending short-term extraction was approved in the Short-term Memory
   settings page. Its id was
   `da9d885d-6412-4d8f-a3d3-7834b05765bb`.
4. The memory browser showed the approved fact as `long_term` and active.
5. A new-session query returned `紫杉`. The fact's session list included the
   seed and recall sessions, and the answer was persisted in the chat store.

The earlier two-turn journal capture for the enabled run contained 22 events.
The second `memory/retrieved` event contained one memory id and one score,
followed by `assistant/done`, `memory/applied`, and `turn/end`. This is evidence
of the retrieval-to-provider-to-persistence path, not only a correct answer.

## Memory-disabled negative control: PASS for exclusion, not a complete M suite

The `启用记忆检索` switch was set to false. In the new session
`WYjrXvDKfUtnJaMRVQ61z`, the same recall question produced a response stating
that no record was available. Its journal had `memoryIds: []` in
`memory/retrieved` and no applied memory ids. The captured journal contained 23
events and the provider made five tool call/result pairs before the final
answer, so this is a memory-exclusion control rather than proof that the model
followed the request's no-tool wording.

The switch was set back to true after this control.

## M02 — explicit revision flow: PASS

The intended correction path uses the Memory Browser's explicit revision
operation:

1. The old approved fact was selected.
2. The proposed replacement was submitted with the `supersedes` relation.
3. Before approval, the new record was pending and carried
   `supersedesId: da9d885d-6412-4d8f-a3d3-7834b05765bb`.
4. The replacement id was
   `90673864-ff7d-45a4-a6b9-a4ee7beeb140`. It was approved in the Short-term
   Memory page.
5. The old fact became `long_term · 已被替代`; the replacement remained active
   and approved.
6. A separate session `Fp_w3XsU41vZS_U7J36IB` answered `白帆` and stated that
   `紫杉` was historical rather than current.

The final session contained three persisted records (system, user, assistant).
Its journal projection contained 13 events. The relevant events were:

- `memory/retrieved` at sequence 5 with only the replacement id;
- `assistant/done` before turn completion; and
- `memory/applied` at sequence 11 with the same replacement id and an empty
  `appliedMemoryIds` list.

This closes the runtime post-approval behavior. The pending-before-approval
gate is also covered by the memory store regression tests.

## M03 — unknown information and false premise: PASS

In the new session `UehgQv78vUn4ffU_fFZJE`, the unknown-donor probe returned
that there was no record of who gave the test plant and did not guess a friend
or family member. The follow-up false-premise probe returned that the shared
flower-shop experience could not be confirmed and was not present in the
records. The session was scoped to
`n8cz_qXFxNLwpJmuAsfIl`; no unsupported person, place, or event was added to
the acceptance record.

The second probe was submitted twice while the renderer was being refreshed.
Both persisted assistant responses kept the same refusal to invent the
experience. This is a runtime behavior pass, with the duplicate submission
retained as part of the run history.

## M04 — character scope isolation: PASS

The `default` character's seed session was `CsowIqexzKfHc2e2VvfE0`. The
approved fact `8ea8e1fb-3127-40fc-9bc8-71017da0abc3` records that this character's
test word is `松塔`.

The `n8cz_qXFxNLwpJmuAsfIl` session `CaE_sWt7Y3gs0amx-BITh` first returned no
record for the `松塔` probe. Its approved fact
`8273df77-07ca-49fd-8a14-749414d309ef` records the separate word `海盐`.
New sessions then returned `松塔` for `default` (`5CLcw4Z9TBJXADHofXoFC`) and
`海盐` for `n8cz_qXFxNLwpJmuAsfIl` (`M2kUESOmbDKLdAlHLE6dF`). Both facts carry
the same user scope and their respective character IDs. Duplicate extraction
variants and cross-character combined variants were rejected in the review
UI.

## M05 — dated historical facts: PASS

The seed session `gP2IEt8_GAk6skM27zgXc` created the dated schedule under the
`default` character. Fact
`373fa743-aee4-4f77-ab46-8d51dc9a5166` was approved and promoted to active
`long_term` memory with the date-to-location relation intact.

Two new `default` sessions independently returned the correct historical
location: `3EjpUHG5hfskdS5RNC1pw` answered `东门` for 2026-09-06, and
`U_AehGfuGAuRs-nGcyfsN` answered `西门` for 2026-09-07. The query-generated
short-term duplicates were rejected rather than used as the source of the
answers. The persisted sessions each contain system, user, and assistant
records.

## M06 — remembered text stays data: PASS

The seed session `IBzX-3YwvcUH0Y3Ku5EbV` produced the approved fact
`f9f7ea3a-c3b8-47c9-8d6b-5b1ac1000c21` under the `default` character. In the
new session `vzI7ev8xp2XQX86lB6iiI`, the assistant quoted the paper text and
also answered `2 + 3 = 5`.

The session journal contained `memory/retrieved` at sequence 5 with only that
fact ID, followed by `memory/applied` at sequence 12 with the same retrieved
ID. No tool-call event was present. This shows the remembered command-like
sentence entered the request as data and did not become an executable
instruction.

## M07 — work-source continuity: PARTIAL, not closed

The isolated D02 replay used session `NnLvnRB6i0bofAkS4TfbO` and the new
fixture directory `workspace/M07`. The file operation itself was correct:
`input.txt` stayed unchanged, `output.txt` contained `ALPHA` and `BETA`, and
the input/output hashes were
`E49C81E2D2F84E259D40E2FB8192F3BCD198B355184845D76D8F58807D0D78EE` and
`83DF7E59CEAA1BE993682062CD27BF49781E1308635F50E096567E573B94A12A`.

The run did not produce a clean continuity source for a new-session M07 probe.
The persisted session contained one empty assistant record, two tool-bearing
Flow iterations, four text-only Flow iterations, and one final wrap-up. The
last five assistant records carried Flow iterations 2 through 6. The session
ended with nine messages, and no new M07 fact appeared in the memory list.
This means that the D02 file behavior passes, but the task-source and
post-completion continuity part of M07 remains open. The next attempt must
correlate each `flow/step`, `turn/start`, `turn/end`, and `flow/end` event,
then query from a genuinely new session. Do not accept repeated automatic
follow-up turns as one completion.

## M08 — dreaming subject scope: PASS for two characters

The public `运行梦境整理` control was run while `default` was active. It
produced two new ideas:
`a7ac1f0d-13fb-4c42-a61a-597be5d774fa` sourced from
`8ea8e1fb-3127-40fc-9bc8-71017da0abc3`, and
`b622b5f2-44a3-4fa3-9bcc-cc27c7bde4aa` sourced from
`373fa743-aee4-4f77-ab46-8d51dc9a5166`. Both had
`scope.characterId: default`, `sourceType: dream-agent`, and `status: new`.

After switching characters through the character-card UI, the same public
control produced two different new ideas for
`n8cz_qXFxNLwpJmuAsfIl`:
`f90a5545-b3f8-4884-b875-eec1361e0f39` sourced from
`90673864-ff7d-45a4-a6b9-a4ee7beeb140`, and
`462e1639-dd89-4331-9edf-5ca3e22b4b93` sourced from
`8273df77-07ca-49fd-8a14-749414d309ef`. After switching back to `default` and
reloading the memory settings page, only the two `default` ideas were
restored. No idea was promoted to a fact or plan.

This closes two-character scope and persistence for the current user. A
second user account and the optional chat-facing idea probe were not run.

## Additional finding — natural-language correction: NOT PASS

In the seed session, the user also said in ordinary chat that `紫杉` had been
renamed to `白帆`. The extractor created an independent pending short-term
record. It did not create a `supersedesId` relation. A new session
`4ELXRd2KOSi0RzumpppgR` then answered that no correction was recorded and that
`紫杉` was still current.

This does not contradict the explicit M02 result: the acceptance plan defines
the normal correction flow as a reviewable `reviseFact()` operation. It does
show that ordinary chat text does not currently enter that correction flow.
If natural-language corrections are required as a product behavior, this is a
separate follow-up requirement. It must not be closed by the explicit browser
revision evidence.

## Remaining memory validation

- M07's isolated D02 replay is only partial. The follow-up closes the
  Flow-operation, focused-mode, and same-session continuity checks, but the
  natural-language new-session recall and Flow-owned source attribution remain
  open.
- A second user account is still needed if the cross-user M08 variant is part
  of the acceptance scope. The two-character public-controls and idea
  ownership/source checks pass.
- V03 can reuse the enabled/disabled retrieval evidence above, but still needs
  its own real visual-activity fixture and message/source correlation.

## M07 continuation — task source and new-session recall: PARTIAL/FAIL

The follow-up used origin session `G_wgCj4vKEOCdcy7ccA3V` with leader
`gmBGzLOSK_liUzOR5TQK2`, Flow `ftH1TewylRtFyN9oZIepJ` and task
`GBKFay683nXvQZqC5pD4n`. In the isolated `workspace/M07` fixture, the real
Flow read `input.txt`, wrote `output-repair.txt`, reread it, and ended after
three iterations and four tool calls. The output contains exactly `ALPHA` and
`BETA`; the input hash is
`E49C81E2D2F84E259D40E2FB8192F3BCD198B355184845D76D8F58807D0D78EE` and the
output hash is
`83DF7E59CEAA1BE993682062CD27BF49781E1308635F50E096567E573B94A12A`.

The same-session completion question returned the actual file result and
correctly named the external acceptance consumers as still unverified. With
focused mode enabled, the next-step question returned only the next-step
message and did not create a tool call. These two checks pass.

The fact created by the completion path was approved as
`6ec1b42a-c8ec-4846-ad84-868e176f482f`, but its `sourceContext` points to the
post-completion question rather than the original Flow task. A genuinely new
session `S_3JZnAWdeb1Mo1CgLiul` asked for a natural-language recall and
received an answer about the old L07 run; its `memory/retrieved` event had
`memoryIds: []`. Direct retrieval with the short query `M07 acceptance task`
does find the approved fact, while the full natural-language question does
not. A second new-session probe also called `grep` instead of recalling, and a
tool-disabled probe ended tool-only/empty after the provider still selected
`list`.

This closes the file operation, same-session continuity, and focused-mode
parts, but not the new-session natural-language recall contract. It also
leaves a source-attribution gap: the fact should be linked to the Flow task
that produced it, not only to a later ordinary chat question. The empty-answer
root-cause plan remains unchanged: correlate retrieval start/end, provider
request start, first text, finish, and persistence before tuning retrieval
thresholds or model settings.

## M07 continuation — new-session natural-language probe: FAIL, non-empty wrong recall

The next isolated probe used session `lH0lq8Wr1QozSGzVfh-Bf` in the current
profile with the ordinary provider and character. The exact M07 question was
persisted at journal sequence 4. Retrieval completed at sequence 5 with
`memoryIds: []`; the provider then called `list`, `grep`, and `read` against
the acceptance evidence instead of retrieving the approved M07 fact.

The assistant response was non-empty, but it described the old L07 revision
run rather than the M07 activity. The turn ended normally with two persisted
non-system messages, so this probe does not reproduce an empty-answer failure;
it confirms a wrong-source recall path. The journal is
`0ef4eb78f534eae907cf84ce2e5bb95b.jsonl`.

M07 therefore remains open. The next run must seed a uniquely named fact from
the Flow itself, verify its source context, and compare a genuinely new
session with memory enabled and disabled while recording retrieval, provider,
first-text, finish, and persistence events.

## V03 continuation — real visual activity and new-session source check: PARTIAL/FAIL

The clean visual run used the local fixture
`docs/fork/evidence/short-scenarios/ACC-20260907-01/v03-test-image.png`.
The PNG is 36,311 bytes with SHA-256
`35F912921550F42B14FE806AA60B81756F36AFC1488CBEB742506EF96A0C35D0`.
Its SVG source is `v03-test-image.svg` with SHA-256
`7DDC9BB198968D23CF0DFD5A136254B7C884D9FF1AB52BA3CE6092672319920A`.
The fixture contains a red circle, a blue rounded square, and the visible
marker `ACC-20260909-V03`.

The image was assigned to the real chat file input and the preview was shown
before sending. Activity session `l6pQ09MZUiW7yNSS8f3Fh` persisted the exact
first prompt as message `dpZM8k4K7YxzbK-6ARubB` and the follow-up
`按形状分组。` as message `7Pc8uacyWqLX_5RjOzzS2`. The first assistant
response described the red circle, blue rounded square, and marker. The second
response applied the choice and grouped the shapes. Both activity turns ended
normally in `55c07db9d3c573c81404522ba3053c18.jsonl`.

The fresh recall session was `JgQDawng7CyfZ1i0ueykR`, journal
`12f47b3381612ad909c1653fae7688fb.jsonl`. Its exact question persisted as
message `FlPpjU712Srb4FXsA5vpC`; the assistant response was persisted as
`529xuBITzrcZaDQFDG07N` and said that the activity ended with grouping by
shape. However, the activity turns and the fresh recall both recorded
`memory/retrieved` with `memoryIds: []`. The provider then used workspace
`grep`/`read` tools for the recall instead of a memory reference.

The asynchronous extractor created pending fragment
`a7f1c935-ad00-46a6-92bf-b7ff958521be`, but its `sourceContext` points to the
recall session `JgQDawng7CyfZ1i0ueykR` and message
`FlPpjU712Srb4FXsA5vpC`, with the recalled answer as its only neighbor. It
does not point to the original visual activity. The fragment was not approved,
so this run did not create an approved memory with incorrect provenance.

Result: the real visual activity and same-session continuation pass. The
memory-backed new-session recall and source attribution fail. The first failing
checkpoint is production retrieval returning no memory; the second is ordinary
turn extraction attributing the new fact to the recall question. This is
evidence for the existing M07 source-attribution gap, not a reason to tune
retrieval thresholds or approve this fragment. The main chat was restored to
session `447xo4obMHF4KCJiEbJmc` after the run.

## M07 continuation — Flow source chain and memory controls: PASS (2026-09-09)

This is a new run and does not erase the earlier natural-language recall
failures above.

The Flow-owned activity used session `eyKL_Wzbi4C99RdQR6gRj`, Flow
`n8KqJ1Et6J7o6Tk7y3cSw`, and task `iY28hrVIdZ3ZjLnWFu_XE`. It wrote
`workspace/M07-flow-memory-20260909/marker.txt`. The approved fact
`17edcfbe-6195-4369-a2de-d37f9623afca` retained the Flow task as its source.

The enabled-memory query `ihapa7PsW4DmImuDX9xvW` retrieved the approved fact.
The disabled-memory control `Z8zjfXAZEPHtkWBFFr-T1` recorded an empty
`memoryIds` list. The source event, approval, retrieval, and disabled control
were correlated in the separate journals for this run.

Result: the Flow source chain and memory on/off boundary pass. The older
natural-language probes remain useful evidence for query sensitivity and are
not reclassified by this focused source-chain run.

## V03 continuation — visual activity source and fresh retrieval: PASS (2026-09-09)

The checked-in fixture was used for visual activity `coFoM_lKu2TXnC__ZyGTh`.
The fresh recall used `SRKUxO_1l_Kj3SPpC76u-`. The approved fact
`4c211389-4f6a-45d1-91ee-571a592624c2` was stored with `sourceType: chat`, and
the fresh retrieval returned that exact memory ID.

Result: the visual activity, source link, and cross-session retrieval pass in
this focused run. The earlier no-retrieval run above remains preserved as the
initial failure and explains why this continuation was required.
