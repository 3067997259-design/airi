# V02 vision cancellation and stale-frame handling

- Status: PARTIAL (stale-frame guard and visual cancellation checkpoint pass; controlled capture-failure and restart/export cleanup remain open)
- Isolated chat session: `8e92oSSk2A7jwTS4UW92f`.
- Fixture: `workspace/V01-test/test-visual.svg`.

The test uploaded the local image through the chat file input and sent a visual request. The visual response completed before a running-state stop control appeared, so the required cancellation checkpoint could not be exercised. No stop action was falsely recorded.

The next user turn contained no image and asked whether there was new visual evidence. The assistant answered `没有。` It did not claim to have seen a new frame or reuse the prior image as a new capture. This stale-frame guard passed. In that earlier run the stop checkpoint was not reached; the controlled capture-failure branch was also not completed.

## Cancellation retest after the repair build

- Date: 2026-09-09
- Build: `@proj-airi/stage-tamagotchi` production build after the journal persistence race repair
- Session: `5WOw2IQJhQnmYn_2AAWp2`
- Turn: `17VgYNcosGwb4VAFtUIT4`
- Journal: `C:\Users\86130\AppData\Roaming\@proj-airi\stage-tamagotchi\journal\f04cb072a9de569c0df3f4326d68c5c5.jsonl`
- Fixture: `docs/fork/evidence/short-scenarios/ACC-20260907-01/v03-test-image.png`
- Fixture SHA-256: `35F912921550F42B14FE806AA60B81756F36AFC1488CBEB742506EF96A0C35D0`

The test used the visible chat file input through CDP's file-input equivalent, waited for exactly one image preview, entered the visual prompt through the real keyboard input path, and sent a real Escape key while the same session was sending.

Observed evidence:

- The UI showed one attachment preview before send: `files=1`, `previews=1`.
- The persisted user message contained exactly `text` and one `image_url` part.
- The final UI state was `sending=false` with no assistant completion.
- The leader journal contained contiguous `seq=0..6`: session header, turn start, assistant start, user message, empty memory retrieval, and `turn/end` with `reason=aborted`.
- After the repair build, the journal persistence status was `pendingCount=0`, `lastSeq=6`, no gaps, no corrupt lines, and `complete=true`; the `turn/end` line was present on disk without a manual flush.

This closes the visual cancellation checkpoint and the durable journal cleanup for cancellation. The full V02 scenario remains open until a controlled capture failure proves temporary image cleanup and a restart/export check proves the failed attachment cannot be reused as fresh visual evidence.

## Continuation after capture cleanup repair (2026-09-09)

The controlled capture-failure regression now passes: the temporary frame is
released when capture fails, and a failed frame is not available to the next
request. The existing live cancellation run also retains its one preview, one
`image_url` part, aborted turn, and complete on-disk journal evidence.

V02 remains PARTIAL. A fresh isolated profile is still required to prove the
restart/export boundary and a new-session probe must show that the failed
attachment cannot reappear as fresh visual evidence.
