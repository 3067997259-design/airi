# D05 Approval variants

- Status: FAIL for the rejection retry behavior; timeout and late-approval variants BLOCKED
- Run: `ACC-20260907-01`
- Profile: `C:\Users\86130\AppData\Roaming\@proj-airi/stage-tamagotchi`
- Chat target: `9C284EDCD59152B71737308035150224`
- Session ID: `WbJLA3nXyzi97nojfJKSB`
- Approval mode: changed through Settings → 机体模块 → 编码 UI from `代替审核` to `需要审核`
- Screenshot: `D05-chat.png`

## Approved variant

The request targeted `D05/approval-ok.txt`. A real medium-risk bash approval card appeared. The first request was denied by the approval gate (`requestId: coding-approval-1`). The same request was then approved through the visible `批准` button. The command ran once, and a readback returned `ACC-20260907-01`.

- File SHA-256: `A7877A86E7B67BFA78A5EB22C70EF5E682CCB26AF0EE48B3684E77941F2F985D`
- The directory contained only the one approved output file.
- No second write occurred after approval; later tool activity was read-only.

## Rejected variant

The request targeted `D05/approval-no.txt`. The visible approval card was rejected (`requestId: coding-approval-3`), and the file remained absent. The model then automatically started another approval attempt instead of ending the task. I used the visible `停止心流` control and rejected the remaining card so no write occurred.

This fails the expected clean rejection behavior: the first write was correctly denied, but the task retried after rejection and required manual interruption. The final state was `sending=false`, with no `approval-no.txt`.

## Timeout and late variants

The request targeted `D05/approval-timeout.txt`. An approval card appeared with `requestId: coding-approval-5`, but the UI exposed no deadline or timeout countdown. After a 40-second observation, the card was still waiting. I rejected the pending card to clean up and stopped the resulting flow through the UI.

- `approval-timeout.txt` remained absent.
- No valid product timeout event was observed.
- The late-approval variant was not run because there was no product-defined timeout boundary to wait for.

## Judgement

- Approved: PASS for one approved write and one readback.
- Rejected: FAIL for automatic retry after rejection; persistence itself remained safe.
- Timeout: BLOCKED because no observable deadline or timeout event was available.
- Late approval: BLOCKED because the timeout prerequisite was unavailable.

After the variants, the approval setting was restored through the same Settings UI to the original `代替审核` mode. The workspace root remained the acceptance workspace.
