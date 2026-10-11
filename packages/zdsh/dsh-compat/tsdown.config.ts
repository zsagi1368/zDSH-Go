import { defineConfig } from 'tsdown'

/**
 * Build each published entry as a self-contained file admitted by the package
 * whitelist. probeSymbol's variable dynamic import (`await import(specifier)`)
 * would otherwise make rolldown split shared modules (e.g. guard.ts) into
 * hashed chunks that the webworker packer's `files` whitelist cannot ship.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
  {
    entry: ['lib/types/invariant.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
])
