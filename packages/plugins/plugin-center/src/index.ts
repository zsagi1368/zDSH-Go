/**
 * zDSH plugin center host entry.
 *
 * Re-exports the cordis plugin shell (src/host/plugin.ts) together with the
 * programmatic surface used by embedders: service configuration
 * (src/host/services.ts), the pure HTTP router (src/host/api.ts), install
 * planning (src/host/plans.ts) and catalog validation/ordering
 * (src/shared/catalog.ts).
 */
export { apply, serveRequest, name, inject } from './host/plugin.js'
export type { HostContextLike, RouteRegistrar, WebContextLike } from './host/plugin.js'
export {
  PLUGIN_NAME,
  PluginCenterServices,
  bundledSeedPath,
  normalizeConfig,
  resolveDataRoot,
  resolveProfileDir,
} from './host/services.js'
export type { PluginCenterConfig, RuntimeIdentity } from './host/services.js'
export { API_PREFIX, handleApiRequest, INTENT_HEADER, ROUTES } from './host/api.js'
export type { RouterRequest, RouterResponse } from './host/api.js'
export { CpError, confirmationPhrase, createPlan, PlanStore } from './host/plans.js'
export type { InstallPlan, PlanAction } from './host/plans.js'
export { isValidCommit, paginate, sortEntries, validateCatalogEntry } from './shared/catalog.js'
export type { CatalogEntry } from './shared/catalog.js'
