import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/stage-tamagotchi/src/main/services/airi/game-host/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
  },
})
