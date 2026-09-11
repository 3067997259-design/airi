# MD-2 non-empty memory owner restore

Date: 2026-09-07. Runtime: built Electron, Playwright over CDP. No agent-browser interaction ran.

The temporary harness intercepted an OpenAI-compatible `/embeddings` request
inside the source renderer and returned a deterministic 768-dimensional vector.
It then enabled memory capture, stored one fixture fact, exported the complete
owner archive, staged a separate restore profile, and started a second packaged
Electron process against that profile.

Source and restored owners both reported one row:

```text
content: The user prefers deterministic restore checks.
memoryType: short_term
category: preference
reviewStatus: pending
factStatus: active
scope: { userId: local, characterId: default }
embeddingProvider: openai-compatible
embeddingModel: fixture-model
embeddingDimensions: 768
embeddingInputType: document
embeddingSourceFingerprint: api:http://memory-fixture.test/v1:fixture-model
embeddingStatus: active
```

Checks passed: `captured=1`, `nonEmptySource=true`, `nonEmptyRestore=true`,
`contentRestored=true`. The row id, session id, scope, source status, and all
768 vector values were unchanged after restore. The endpoint was local request
interception; this does not measure an external provider or production memory
quality.

Together with the five-table DuckDB browser roundtrip, this proves the
non-empty memory owner path through a packaged independent restore. Custom
skill workspace artifacts and non-empty outbox/scheduler adoption remain
separate MD-2 boundaries.
