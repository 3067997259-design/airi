---
module: memory-pgvector
tags: [pgvector, postgres, docker, memory, walkthrough]
problem_type: runbook
---

# Long-term memory (pgvector) walkthrough runbook

Verified end-to-end 2026-08-29: schema creation, insert, vector search,
list, and removal against the real database. A regression bug found and
fixed during this walkthrough is noted at the bottom.

## 1. Start the database

```bash
# Docker Desktop must be running; the CLI lives per-user:
export PATH="$PATH:/c/Users/86130/AppData/Local/Programs/DockerDesktop/resources/bin"

cd server
docker compose up -d db     # starts ONLY the db service (not redis/caddy)
docker inspect --format '{{.State.Health.Status}}' proj-airi-backend-db-1
# wait until "healthy" (pg_isready probe every 5s)
```

The image is `ghcr.io/tensorchord/vchord-postgres:pg18-v1.0.0` (bundles the
`vector` extension) bound to `127.0.0.1:5435`. Credentials live in
`server/docker-compose.yaml`.

Stop / start later with `docker compose stop db` / `docker compose start db`
(run inside `server/`).

## 2. Verify the repository against the real database

An integration test exercises the full round trip and skips itself when
`DATABASE_URL` is unset:

```bash
# read the password out of the compose file instead of pasting it
PW=$(grep 'POSTGRES_PASSWORD' server/docker-compose.yaml | sed 's/.*: *//' | tr -d ' ')
DATABASE_URL="postgresql://postgres:${PW}@127.0.0.1:5435/postgres" \
  pnpm -F @proj-airi/memory-pgvector exec vitest run src/repository.integration.test.ts
```

## 3. Wire the app UI

Launch the desktop app, open Settings → Memory → Long-Term Memory, paste

```
postgresql://postgres:<password-from-compose>@127.0.0.1:5435/postgres
```

into the connection field and press Connect. The status callout flips to
"Connected". From then on, fragments the short-term layer promotes
(`promoteEligible`) are mirrored into Postgres together with a 768-d
embedding computed in the renderer; failure only degrades the status shown,
it never blocks the local memory layer.

## 4. What lives where

| Piece | Location |
|---|---|
| DDL (idempotent, auto-applied on configure) | `packages/memory-pgvector/src/repository.ts` `ensureMemorySchema` |
| Repository (search/insert/promote/list) | same file, `connectMemoryRepository` |
| Main-process owner of the connection | `apps/stage-tamagotchi/src/main/services/airi/memory-host/` |
| Eventa contracts | `apps/stage-tamagotchi/src/shared/eventa` (`memoryHost*`) |
| Renderer port + promotion mirroring | `packages/stage-ui/src/stores/modules/memory.ts` (`MemoryHostPort`, `installMemoryHostPort`) |
| Headless fallback connection string | `MEMORY_DATABASE_URL` env var |

## Bugs found by this walkthrough (fixed)

1. `search()` bound the embedding as a raw JS array; postgres.js serializes
   that as a Postgres array literal, which `vector <=>` cannot compare. The
   embedding is now bound as the pgvector string form with an explicit
   `::vector` cast.
2. No DDL existed anywhere in the repository — `ensureMemorySchema`
   (idempotent `CREATE EXTENSION/CREATE TABLE/CREATE INDEX`) was added and
   runs on every configure.
