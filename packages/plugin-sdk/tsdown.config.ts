import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/plugin-host/index.ts',
    'src/plugin-host/runtimes/node/index.ts',
    'src/plugin-host/runtimes/node/worker/bootstrap.ts',
    'src/plugin-host/runtimes/node/worker/index.ts',
    'src/plugin-host/runtimes/web/index.ts',
  ],
  dts: true,
  format: 'esm',
})
