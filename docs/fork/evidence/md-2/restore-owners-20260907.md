# MD-2 renderer owner startup regression

Date: 2026-09-07. HEAD: `13c8edc2164980f53f4ea86a275155f8cd3df929` with uncommitted changes.
Runtime: Vitest Chromium and Node. Profile: isolated browser test storage, user `local`, character `restored-card`, session `restored-session`.
Provider/model: none. Journal range: none. No Electron bundle was produced.

## Failures reproduced

The initial browser regression timed out because `importSnapshot` awaited `memory.initialize`, which awaited the restore gate.
The coordinator could release that gate only after import returned.
After removing this wait, the test exposed card runtime initialization outside component setup.
The import now writes owner data without calling memory or card runtime initialization.

Further assertions exposed two data and lifecycle defects:

- A session watcher changed the imported history and its `updatedAt` timestamp during restore.
- An imported reviewed skill entered the tool registry before startup source verification.

A separate plan test failed because `initialize` read the empty database while restore remained active.
Each failing run returned exit code 1 before its corresponding correction.

## Resulting owner order

1. Each Electron renderer closes its startup gate and asks the main process for the restore state.
2. The leader imports the archive. Followers await the host receipt.
3. The leader restores the active card before the chat owner selects the imported session.
4. The import restores plans, the skill queue, held outbox records, settings, and database entries.
5. The coordinator sends the completion receipt, then releases the renderer gate.
6. Normal boot can initialize chat and plans, arm journal replay, verify skill sources, initialize memory, and initialize the goal scheduler.

The imported skill queue retains review evidence but marks reviewed artifacts as pending verification.
The ordinary skill restore action waits for the startup gate before source verification and runtime registration.
Chat prompt refresh does not change archived history while the gate is active.

The restored profile also keeps a durable external-effect hold. After the owner
compares the restored state, `adoptRestoredProfile()` writes an adoption receipt
through the main process and releases the renderer hold; later boots read that
receipt instead of silently resuming or silently re-pausing the profile.

This order describes the corrected code path. It does not establish that all owners are durable or all external effects remain held after gate release.
Those are separate remaining checks.

## Verification

```sh
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/stores/data-backup.browser.test.ts src/stores/chat/session-store.browser.test.ts src/stores/skills.browser.test.ts
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/stores/skills.test.ts src/stores/plans.test.ts src/services/restore-gate.test.ts
```

The browser run passed 10 tests across 3 files. The Node run passed 32 tests across 3 files. Both returned exit code 0.
The new browser test uses actual Pinia stores, localStorage, IndexedDB, ZIP validation, and chat persistence.
It replaces only the DuckDB composable IO boundary. Its empty Parquet fixture bytes do not prove database content restoration.

The test checks that import returns while the startup gate remains closed.
It compares the stored chat index and messages with the archive, including identity, selection, and timestamps.
It also checks that the tool registry remains empty until explicit post-gate source verification, while the reviewed hash remains intact.
The skill fixture uses the exact built-in artifact. Custom skill workspace rebinding remains untested.

Root `pnpm typecheck` passed, exit code 0. The initial lint run found six object-formatting errors in the new test.
Those formatting errors were corrected. Final root `pnpm lint` passed, exit code 0, with existing warnings.

## Source identities

| Source | SHA-256 |
| --- | --- |
| data-backup.ts | `01E3812C7D870C860A4C44C3F67A92CF6395FE78D0ADEA779E2B5209070B1555` |
| data-backup.browser.test.ts | `C31BCE1AC62697355D94A4FD5A07E3A7E66CE53A7394949DE5430C548B58ED00` |
| chat/session-store.ts | `200C7C3EB2975E6BC565BCC83BF9093989F018CA62AECD8E1EEFEC87F37556F1` |
| plans.ts | `FEFBCEF4ED8A647E9B2BEB9ADBD2EA68D36B8D4ED8B809F6F7203B65392A6096` |
| skills.ts | `FE8341789DA792971D8AEAE05A7F2374EAA4CD4FB31C3DA5AF64CC0B0878B494` |
| renderer/main.ts | `98C06590ABED434AEA420010466ACDB53473D3D88F17EA608B267892D797C7FD` |

## Remaining acceptance

MD-2 remains open. Remaining work includes full non-empty database and journal comparisons, custom skill workspace migration, non-local identity, and persistent outbox/scheduler holds.
A later packaged Electron run restored the plan, journal sentinel, active session, and imported settings, and completed explicit adoption; its empty skill/outbox/memory fixture did not prove non-empty owner relationships. No agent-browser interaction ran.
This batch does not establish production memory quality, real cross-day behavior, or observation readiness.
