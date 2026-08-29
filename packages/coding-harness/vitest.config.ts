import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-airi/coding-harness',
    include: ['src/**/*.test.ts'],
  },
})
