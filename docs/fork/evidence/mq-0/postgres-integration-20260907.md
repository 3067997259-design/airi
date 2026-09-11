# MQ-0 Postgres integration run

Date: 2026-09-07.

The Docker Postgres service was reachable at `127.0.0.1:5435`. The test used the
local compose database and did not save the connection password in this file.

Command:

```powershell
$env:DATABASE_URL='postgres://postgres:<compose-password>@127.0.0.1:5435/postgres'
pnpm -F @proj-airi/memory-pgvector exec vitest run src/repository.integration.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
Duration    1.12s
```

The run covered insert, vector search, list, remove, `originId` idempotency,
delete tombstones, review and supersede propagation, and redelivery after
delete. The test used deterministic 768-dimensional vectors and cleaned its
rows after each case.

This evidence covers the Postgres repository boundary. It does not cover a
renderer profile, provider billing, network interruption, automatic outbox
retry, or packaged Electron interaction.
