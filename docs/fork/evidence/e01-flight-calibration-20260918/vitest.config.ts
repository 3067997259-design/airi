import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['docs/fork/evidence/e01-flight-calibration-20260918/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
  },
})
