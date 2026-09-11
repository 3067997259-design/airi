# Stage UI

Shared core for stage

This package owns shared business stores, composables, and scenario components for the desktop, web, and mobile apps.
Use it for chat, plans, memory, and skill review behavior shared across stage surfaces.
Keep Electron filesystem and IPC implementations in the desktop app. Keep general UI primitives in `packages/ui`.

## Data restore ownership

The data-backup store imports validated owner data before ordinary runtime initialization.
Chat, plan, memory, and skill startup wait for the shell's restore gate. The Electron shell releases that gate after a durable completion receipt.
The import preserves review evidence and requires source verification before skill registration.
Restored profiles keep automatic delivery and execution paused after local initialization. The shell supplies this state from its durable restore marker on every startup.
Full restore acceptance and pending work are tracked in [the execution record](../../docs/fork/observation-readiness-execution.md).

```sh
pnpm -F @proj-airi/stage-ui typecheck
pnpm exec vitest run --config packages/stage-ui/vitest.config.ts
```

## Button analytics

Register the shared plugin once in each Vue application:

```ts
import { trackButtonPlugin } from '@proj-airi/stage-ui/directives/track-button'

createApp(App)
  .use(trackButtonPlugin)
  .mount('#app')
```

Buttons that represent a product-analysis click intent can then declare a
typed event without wrapping their business handler:

```vue
<Button
  v-track-button="{ name: 'update_check_clicked', channel: selectedChannel }"
  @click="checkForUpdates()"
/>
```

Keep async outcomes, confirmed state changes, impressions, and lifecycle events
in their owning business flows instead of attaching them to the initial click.

## Histoire (UI storyboard)

https://histoire.dev/

```shell
pnpm -F @proj-airi/stage-ui run story:dev
```

### Project structure

1. If a story is bound to a specific component, it can be placed beside the component in the `src` folder. e.g., `MyComponent.story.vue`
2. If a story is not bound to a specific component, then it should be placed in the `stories` folder. e.g., `MyStory.story.vue`
