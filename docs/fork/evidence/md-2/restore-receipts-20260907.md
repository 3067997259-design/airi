# MD-2 restore receipt regression record

Date: 2026-09-07. Scope: the Electron main-process restore coordinator, executed through its production module in Vitest Node.
HEAD: `13c8edc2164980f53f4ea86a275155f8cd3df929`. The working tree contains earlier uncommitted changes.
No commit or Electron bundle was produced in this batch.

## Inputs and boundaries

Each test uses a new temporary directory and a synthetic archive with snapshot ID `restore-test`.
The filesystem stores real archive and marker bytes. Two cases inject a rejected `writeFile` at the filesystem boundary.
The memory table entries are empty fixture bytes. These tests do not exercise DuckDB import or validate restored memory content.
Profile: temporary test profiles only. Provider/model: none. Journal range: empty fixture archive.

## Reproduction and result

The first run failed 2 of 5 tests, with exit code 1:

- A repeated completion receipt was rejected after the first receipt became durable.
- A failed completion write let a later bootstrap return `restored: true`.

The coordinator now publishes in-memory transitions after the durable write succeeds.
A repeated terminal receipt succeeds only for the same snapshot, state, and error.
Different snapshots and conflicting outcomes remain rejected.

The final targeted run passed 7 of 7 tests, exit code 0:

```sh
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project node src/main/services/airi/data-backup/profiles.test.ts
```

Coverage includes failed claim writes, failed completion writes, follower failure propagation, repeated receipts after restart, duplicate claims, and interrupted restore rejection.
The shell initially lacked pnpm on PATH. The successful runs used the existing installation outside the sandbox with the Node and pnpm directories on PATH.

Source SHA-256:

- `profiles.ts`: `E2094B82EED2E9626D738DEB300BF7C8A71868960C188F01EFDA5A6269CE9BE2`
- `profiles.test.ts`: `23D613DB75588470BE743D272003A31BBA2F07C36EFAA72B1347F1C5F36C8460` (after formatting)

Final root `pnpm typecheck` and `pnpm lint` passed, both with exit code 0.
Lint retained existing warnings. The final runs include the declaration and formatting corrections described here.

The first lint run failed with five errors. Formatting corrected one test callback, journal-host import order, and an existing inspection script chain.
The DuckDB snapshot methods moved after `getDb` to resolve two declaration-order errors without a behavior change.
The DuckDB owner tests passed 7 of 7 after this move, exit code 0:

```sh
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project node src/composables/use-duck-db.test.ts
```

## Remaining MD-2 work

Code inspection found a renderer deadlock: `importSnapshot` awaits `memory.initialize`, which awaits the gate released only after import completion.
Ordinary boot also starts plan hydration and journal replay concurrently with restore.
These paths need owner-level regression tests and a startup-order correction.
The same-day [owner follow-up](./restore-owners-20260907.md) records those corrections and their test boundaries.
The staged workspace differs from the original skill registry workspace. Restore must address this binding before it can demonstrate skill reuse.

Full non-empty plan, memory, journal, and skill relationship comparisons remain incomplete.
Packaged Electron execution now has a bounded empty-owner fixture; custom skill workspace, non-empty memory rows,
and outbox/scheduler adoption still need evidence. Agent-browser interaction was not run.
This batch does not establish MD-2 completion or observation readiness.
