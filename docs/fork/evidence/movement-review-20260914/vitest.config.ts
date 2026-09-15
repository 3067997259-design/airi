import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['docs/fork/evidence/movement-review-20260914/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
  },
})
