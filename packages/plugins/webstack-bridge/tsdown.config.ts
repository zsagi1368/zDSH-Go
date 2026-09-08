import { defineConfig } from 'tsdown';

/**
 * Host-side bundle only (this satellite has no browser half). `ws` stays
 * external: it is the package's single declared runtime dependency and must
 * resolve to the host install at runtime, never be inlined. The cordis peer
 * is provided by the host process.
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
    neverBundle: ['ws', '@deepseek-ai/cordis'],
  },
});
