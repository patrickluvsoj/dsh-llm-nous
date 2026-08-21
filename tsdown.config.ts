import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: true,
  noExternal: [
    /^@deepseek-ai\//,
    'eventsource-parser',
  ],
})
