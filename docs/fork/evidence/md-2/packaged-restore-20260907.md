# MD-2 packaged independent-profile restore

Date: 2026-09-07. Runtime: built Electron, Playwright over CDP. No agent-browser interaction ran.

## Run

The packaged renderer was rebuilt with:

```text
pnpm -F @proj-airi/stage-tamagotchi build
```

The smoke harness created a temporary source user-data directory, opened the
leader renderer, created a chat session, started plan `md2-packaged-plan`,
appended a `restore sentinel` journal message, and set
`settings/memory/compaction-threshold` to `0.91`. It exported the owner archive,
staged it with `prepareRestoreProfile`, and launched a second packaged Electron
process against the isolated restore profile.

The restored process reported:

```json
{
  "source": { "plans": 1, "journal": 2, "fragments": 0, "setting": "0.91" },
  "restored": { "plans": 1, "journal": 2, "fragments": 0, "setting": "0.91", "lastSeq": 1, "gaps": [], "corruptLines": 0, "duplicateLines": 0 },
  "checks": { "planId": true, "journalSentinel": true, "settingRestored": true }
}
```

The active chat session id stayed identical across the two profiles. The
restored profile completed the durable receipt and then accepted the explicit
adoption command. The first fixture had empty skill and outbox owners. A second
packaged run used a deterministic intercepted embedding response and restored a
non-empty memory row; see [non-empty memory evidence](./non-empty-memory-restore-20260907.md).
Custom skill artifact migration and non-empty outbox/scheduler adoption remain
open.

## Fix found by the run

The first run restored the archive setting to localStorage but left the live
memory ref at its default `0.7`. The restore path now reloads imported memory
and consciousness settings into their already-created Pinia stores. The
browser owner regression covers this path, and the packaged rerun restored
`0.91`.

## Remaining MD-2 boundary

The complete before/after semantic comparison still needs custom skill workspace
artifacts and held outbox or scheduler records. The non-empty memory owner is
now covered by the companion packaged run, but this does not claim that custom
workspace migration is complete.
