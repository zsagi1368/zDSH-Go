import { defineConfig } from 'tsdown';

/**
 * Host-side bundle only (this satellite has no browser half). Zero runtime
 * dependencies by design: the oEmbed leg rides the injected outbound fetch,
 * so nothing needs inlining. The cordis peer and the dsh-webstack peer are
 * provided by the host process and must never be bundled.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: false,
  deps: {
    neverBundle: ['@deepseek-ai/cordis', 'dsh-webstack'],
  },
});
