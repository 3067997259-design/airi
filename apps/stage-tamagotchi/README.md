# AIRI desktop

This app runs AIRI in Electron. The main process owns desktop services, filesystem access, and window lifecycles.
Vue renderers consume shared business stores from `packages/stage-ui` and pages from `packages/stage-pages`.
Eventa contracts in `src/shared` connect the processes.

## Use

Run commands from the repository root after workspace installation.

```sh
pnpm -F @proj-airi/stage-tamagotchi dev
pnpm -F @proj-airi/stage-tamagotchi build
pnpm -F @proj-airi/stage-tamagotchi build:unpack
```

`build` writes the Electron source bundle. `build:unpack` also creates an unpacked application with Electron Builder.
Use `build:win`, `build:mac`, or `build:linux` for platform packages.

## Checks

```sh
pnpm -F @proj-airi/stage-tamagotchi typecheck
pnpm exec vitest run --config apps/stage-tamagotchi/vitest.config.ts --project node
pnpm lint
```

The Vitest browser project covers renderer behavior. Node tests replace Electron and external service boundaries where required.
Passing these checks does not establish packaged application behavior.

## Ownership

- `src/main/services`: desktop services and persistence owners.
- `src/renderer/bridges`: renderer clients for main-process contracts.
- `src/renderer/pages`: desktop routes.
- `src/shared/eventa`: IPC contracts.
- `src/main/services/airi/data-backup`: isolated restore staging and durable startup receipts.

Use this app for desktop windows, local workspace tools, and Electron integrations.
Use `apps/stage-web` for browser delivery and `apps/stage-pocket` for mobile delivery.
Place reusable business logic in its owning shared package.

## Restore status

The restore host stages each archive in a new profile. Followers wait for a durable receipt from the leader.
A repeated receipt must match the snapshot and outcome. A failed marker write does not publish completion to followers.
An interrupted owner import requires a new isolated profile.

Full restore acceptance remains tracked in [the execution record](../../docs/fork/observation-readiness-execution.md).
