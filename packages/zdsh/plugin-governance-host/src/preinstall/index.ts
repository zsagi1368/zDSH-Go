/**
 * Public surface of the factory preinstall module (DESIGN-intake-tech.md §1.2).
 * Re-exports the executor, the seed reader, and the result-ledger helpers so
 * the gateway imports one path.
 * @module @deepseek-ai/dsh-plugin-governance-host/src/preinstall
 */

export { SeedPreinstaller, type SeedPreinstallerConfig, type SeedPreinstallerHost } from './preinstaller.ts'
export {
  parseSeedManifest,
  seedEntryContractIssue,
  SEED_SCHEMA_VERSION,
  SUPPORTED_FAIL_POLICY,
  type SeedEntry,
  type SeedManifest,
} from './seed.ts'
export {
  emptyPreinstallResults,
  loadPreinstallResults,
  savePreinstallResults,
  toReport,
  type PersistedPreinstallResults,
} from './results.ts'
