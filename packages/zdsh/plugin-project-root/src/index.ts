/**
 * @deepseek-ai/dsh-plugin-project-root — project-level plugin root.
 *
 * Exports the S-43 M1 discovery + M2a host clamping, gating, trust ledger,
 * post-boot mounting, origin, and RunGuard wiring.
 *
 * Trust is a property of the project root, assigned by the discoverer: a
 * discovered file never self-reports trust. Every value across this module is a
 * server-side (host) construction; the UI renders it, it never infers it.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

export { clampProjectPluginSandbox } from './clamp.ts'
export type { ClampRejection, ProjectPluginClamp, ProjectPluginRuntimeTier } from './clamp.ts'

export { gate } from './gate.ts'

export { discoverProjectPlugins, PROJECT_PLUGINS_DIRNAME, PROJECT_PLUGIN_MANIFEST_FILENAME, PROJECT_PLUGIN_ENTRY_FILENAME } from './discover.ts'
export type { DiscoverOptions } from './discover.ts'

export { findProjectRoot } from './find-project-root.ts'

export { resolveProjectPluginEnabled, PROJECT_PLUGINS_ROW_ID } from './resolve.ts'

export {
  emptyProjectTrusts,
  loadProjectTrusts,
  saveProjectTrusts,
  trustProjectRoot,
  decideProjectPlugin,
  shouldMountProjectPlugin,
  projectRootKey,
  projectTrustsDataDir,
  projectTrustsPath,
  PROJECT_TRUSTS_FILENAME,
  type ProjectTrusts,
  type ProjectRootTrust,
  type ProjectPluginDecision,
} from './ledger.ts'

export { mountProjectPlugins, createProjectPluginLayer, type ProjectPluginLayer, type MountResult } from './plugin.ts'

export { projectToolWrapper } from './tool-guard.ts'

export { cwdHitsProjectRoot, wireSessionScope, type SessionScopeWiring, type SessionAgentLike, type SessionAgentsServiceLike } from './session-scope.ts'

export {
  createSubprocessRuntime,
  SubprocessTimeoutError,
  SubprocessToolError,
  type SubprocessRuntime,
  type SubprocessRuntimeOptions,
} from './subprocess-runtime.ts'

export type {
  DiscoveredProjectPlugin,
  ProjectPluginCandidate,
  GateReportEntry,
  ProjectPluginOrigin,
} from './types.ts'
