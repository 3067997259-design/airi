import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: '@proj-airi/memory-pgvector',
    include: ['src/**/*.test.ts'],
  },
})
