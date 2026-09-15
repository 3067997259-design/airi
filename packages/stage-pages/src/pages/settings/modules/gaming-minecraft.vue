<script setup lang="ts">
// Minecraft settings for the MCPFabric game-host bridge (MC-0a/MC-0c). The
// component reads the stage-ui game-host store, which the desktop app shell
// wires to the main-process bridge; web builds show the desktop-only notice.

import { GamingMinecraft } from '@proj-airi/stage-ui/components'
</script>

<template>
  <GamingMinecraft />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.gaming-minecraft.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
