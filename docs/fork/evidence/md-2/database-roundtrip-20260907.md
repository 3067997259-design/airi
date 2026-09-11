# MD-2 database snapshot comparison

Date: 2026-09-07. HEAD: `13c8edc2164980f53f4ea86a275155f8cd3df929` with uncommitted changes.
Runtime: Chromium through Vitest browser mode, with the actual DuckDB-Wasm owner and Parquet import/export.
Profile: temporary browser test origin. Provider/model: none. Journal range: no journal host in this test.

## Data and checks

The test now fills all five snapshot tables. Earlier coverage contained one tag row only.

| Table | Fixture and preserved relationships |
| --- | --- |
| memory_fragments | Superseded fact, corrected active fact, and skill muscle record; scope, origin, source context, review status, vector values and embedding metadata |
| memory_tags | Chinese tag linked to the corrected fact; timestamp `9007199254740993` |
| memory_episodic | Episode linked to the corrected fact, participants, and location |
| memory_long_term_goals | Goal and session IDs, stored specification and state JSON, constraint version and previous-run references |
| memory_short_term_ideas | Dream proposal linked to the source fact |

The test reads every column of every seeded row before export and after import plus database close/reopen.
The sorted per-table JSON rows match exactly. A separate assertion checks the large timestamp as a native bigint.
This verifies storage preservation of the JSON fields; it does not validate their behavior through the plan or memory domain APIs.

The test also rejects import into a nonempty database.
After clearing this temporary fixture, it corrupts the goal Parquet entry and attempts an import.
All five tables remain empty after that failure, including tables processed before the damaged entry.
The original snapshot then imports successfully and survives database close/reopen.

## Run

```sh
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts --project browser src/composables/use-duck-db-snapshot.browser.test.ts
```

Result: 1 test passed, exit code 0. Test time: 4.78 seconds. Total run: 6.95 seconds.
DuckDB emitted dependency source-map warnings. No database or worker mocks were used.
Root `pnpm typecheck` and `pnpm lint` passed, both with exit code 0. Lint retained existing warnings.
Test source SHA-256: `780561155F680416D869B1BA93CC3E8EC482F7D872EFFA2B47163650E3B56F8A`.

## Remaining scope

The source and target are successive states in one temporary test origin. This is not a second Electron profile or a process restart.
The skill registry, source files, journal archives, and cloud outbox are outside these five tables.
Their cross-owner relationship closure still needs a combined restored-profile comparison.
Packaged Electron, real provider behavior, and agent-browser interaction were not run. MD-2 remains open.
