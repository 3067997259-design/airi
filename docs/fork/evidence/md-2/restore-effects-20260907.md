# MD-2 restored profile effect hold

Date: 2026-09-07. Runtime: Vitest Node and Chromium. Provider/model: none.
HEAD: `13c8edc2164980f53f4ea86a275155f8cd3df929` with uncommitted changes.
The tests use synthetic records and browser test storage. No production profile or packaged Electron run occurred.

## Failure and correction

The startup gate previously released local initialization and remote delivery together.
A regression reproduced a restored delete operation reaching the memory host after initialization and retry.
The failing run returned exit code 1 and showed a remote removal call for `restored-fact`.

The renderer now distinguishes an active import from a restored profile's effect hold.
The main-process restore marker supplies `restored: true` on each bootstrap, including later starts after a completed import.
Local owners can initialize after the receipt. Automatic effects retain the hold.

The hold guards memory outbox delivery and retry, dreaming, chat reconciliation, immediate cloud sends, chat outbox and tombstone drains.
It also guards old Flow resumption, social heartbeats, long-goal schedule publication, wake claims, and scheduler initialization.
The hold preserves queued records instead of changing their retry timestamps or claiming successful delivery.

The adoption boundary now has an explicit `adoptRestoredProfile()` command. It
requires the durable main-process receipt before releasing the renderer hold,
so a restart cannot resume effects without the recorded adoption decision.
The renderer gate is not a replacement for the host marker. No independent
localStorage flag controls its persistence.

## Evidence

The memory regression now preserves the queued delete and its retry timestamp, with no remote removal call.
Gate tests check that local initialization completes while effects remain held and that a later restored bootstrap retains the hold.
The actual-owner browser test checks that a restored heartbeat adds no journal events after import completion.

```sh
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/stores/data-backup.browser.test.ts src/stores/chat/session-store.browser.test.ts
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/stores/modules/memory.test.ts src/services/restore-gate.test.ts src/stores/plans.test.ts src/stores/modules/life-mode.test.ts
pnpm typecheck
pnpm lint
```

Browser: 6 tests passed. Node: 55 tests passed across 4 files. Both returned exit code 0.
Final root typecheck and lint passed, exit code 0. Lint retained existing warnings.
An initial lint run reported three import-order errors, which were corrected.

Source SHA-256:

- `restore-gate.ts`: `7974A121EC67579FBDEC96F943DD9C9F4C17306A33F7974E7327875FF2C69E68`
- `modules/memory.ts`: `D51829F110DFC269B15DDC4C86813581910083552B48B0FB9171B3111B32FF4F`
- `chat/session-store.ts`: `2CBD8DFF14A657CDE94B84E3A10CC4DB99210E37205CF5F8C83D0A353033DCC6`
- `renderer/main.ts`: `C8B74A6E918DA626B87A583720449DA8A3B35B11115CFBE8251424D60638AF0D`

## Remaining boundaries

Real cloud reconnection, tombstone delivery, provider changes, and host scheduler restart need integration evidence.
The memory repository and remote host are replaced at their IO boundaries in the Node regression.
The browser restore test replaces DuckDB IO and uses the built-in skill fixture.
No test here establishes full database restoration, custom skill migration, or cross-day behavior.
MD-2 remains incomplete. No agent-browser interaction ran.
