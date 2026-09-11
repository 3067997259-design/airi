# R01 Non-empty business backup and consistency gate

- Status: FAIL at the product export gate; R02-R07 remain blocked
- Run: `ACC-20260907-01`
- Profile: `C:\Users\86130\AppData\Roaming\@proj-airi/stage-tamagotchi`
- Settings target: `80B441BF9D0C683C13A63D93DB4EAECA`
- UI route: `#/settings` → `Data`
- Screenshot: `R01-data-settings.png`

## UI operation

Opened Data through the settings UI and clicked the visible `Backup ZIP` button. The product displayed this error in the Data page:

`Store "data-backup" does not expose synced action "exportSnapshot" in the leader.`

No business ZIP was downloaded. The Downloads directory had no new `airi-backup-*.zip` artifact after the click. No profile data was deleted or overwritten.

## Judgement

- Answer: no model answer required.
- Behavior: FAIL; the visible business-backup action cannot reach its leader action.
- Persistence: NOT VERIFIED; there is no export artifact or manifest to inspect.

The required M02, K02, and L01 non-empty business-data preconditions were not yet complete, so this is an export-gate failure record, not a claim that the full R01 consistency matrix passed. R02-R07 cannot start without a valid R01 ZIP and are blocked.

The source path explains the boundary: `use-data-maintenance.ts` calls `useDataBackupStore().exportSnapshot()`, while `stores/data-backup.ts` exposes `exportSnapshot` as a synced action. The current leader boot in `apps/stage-tamagotchi/src/renderer/main.ts` does not instantiate that store during normal leader startup, so the follower settings window cannot route the action to the leader.
