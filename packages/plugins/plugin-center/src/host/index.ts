/**
 * zdsh-plugin-center — host-side public surface and Cordis entry.
 *
 * v1 ships as a standalone plugin: the default export is the Cordis plugin
 * (name/inject/apply). Domain building blocks are re-exported for reuse and
 * for the future branch-integrated form.
 */
import { apply, inject, name } from './plugin.js'

export default apply
export { apply, inject, name }

export {
  CpErrorCode,
  cpOk,
  cpErr,
  normalizePluginId,
  type CpResult,
  type PlanState,
  type AuditEvent,
  type AuditOutcome,
} from '../shared/types.js'
export { assertSafeUrl, safeFetch, isHostAllowed } from '../shared/ssrc-guard.js'
export { redactRecord, redactValue, isSensitiveValue } from '../shared/redact.js'
export {
  validateCatalogEntry,
  sortEntries,
  paginate,
  searchEntries,
  isValidCommit,
  type CatalogEntry,
  type CandidateEntry,
  type EvidenceLevel,
  type CompatLevel,
} from '../shared/catalog.js'
export { nodePorts, isInsideRoot, type EnginePorts } from './ports.js'
export {
  LifecycleEngine,
  buildInstallCmd,
  buildRemoveCmd,
  buildNpmAddCmd,
  detectLifecycleScripts,
  PROFILE_FILES,
  toCpResult,
  type LifecycleConfig,
  type EngineDeps,
} from './lifecycle-engine.js'
export {
  createPlan,
  confirmationPhrase,
  PlanStore,
  CpError,
  type InstallPlan,
  type PlanAction,
} from './plans.js'
export { loadCatalog, type LoadedCatalog, type CatalogLoadInput } from './snapshot.js'
export {
  PluginCenterServices,
  normalizeConfig,
  resolveDataRoot,
  resolveProfileDir,
  bundledSeedPath,
  createRuntimeIdentity,
  PLUGIN_NAME,
  type PluginCenterConfig,
  type RuntimeIdentity,
} from './services.js'
export {
  handleApiRequest,
  ROUTES,
  API_PREFIX,
  INTENT_HEADER,
  type RouterRequest,
  type RouterResponse,
} from './api.js'
export { serveRequest, apply as cordisApply, name as cordisName } from './plugin.js'
export {
  startGuardian,
  stopGuardian,
  statusPath,
  pidPath,
  guardianDir,
  type GuardianConfig,
  type GuardianStatus,
} from './guardian.js'
export {
  RestartBudget,
  decideAction,
  type GuardianAction,
  type ProbeVerdict,
} from './restart-budget.js'
