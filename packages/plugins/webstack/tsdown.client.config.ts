import { defineConfig } from 'tsdown';

/**
 * Browser half of the plugin: one CJS bundle (lib/client.js) that build.mjs
 * wraps into the ModuleLoader factory handshake after this build. Everything
 * from node_modules stays external — the app's module system provides react
 * and the @deepseek-ai/* platform peers (including subpath entries like
 * @deepseek-ai/dsh-client-runtime/client).
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  // Serve/ship conventions follow the ModuleLoader contract: the artifact is
  // lib/client.js (+ lib/client.d.ts for the "./client" export), not *.cjs.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  fixedExtension: false,
  dts: true,
  clean: false,
  sourcemap: false,
  deps: {
    neverBundle: true,
  },
});
