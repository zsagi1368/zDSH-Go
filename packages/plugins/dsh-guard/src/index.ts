/**
 * Catalog-scanner entry marker for the `zdsh-dsh-guard` package.
 *
 * The actual artifact of this package is the single self-contained
 * `dsh-guard.mjs` (zero dependencies, zero build — see package.json `main`
 * and the install banner's `node …/dsh-guard.mjs check --profile web` wiring).
 * It is an install-time CLI check, not a cordis plugin, so this module exports
 * nothing and the config catalog classifies the package as a plain library.
 *
 * The file exists only because the config-catalog generator walks every
 * workspace package manifest and requires a readable `<pkg>/src/index.ts`.
 * Do not import this module at runtime — nothing consumes it.
 */

export {}
