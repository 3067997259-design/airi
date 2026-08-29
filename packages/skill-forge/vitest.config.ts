import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-airi/skill-forge',
    include: ['src/**/*.test.ts'],
  },
})
