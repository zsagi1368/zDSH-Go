/**
 * Version-adaptive shim framework for fork/upstream drift.
 *
 * Public entry of `@deepseek-ai/dsh-compat`: re-exports the version probe
 * primitives (`probeSymbol`/`memberOf`/`versionOf`) and the feature
 * registration guard (`guardFeature`/`getCompatRoster`) so every zDSH
 * feature package can gate its own registration against the official core
 * API shape it depends on, and auto-disable when a conflict is detected.
 * @module @deepseek-ai/dsh-compat
 */

export {
  probeSymbol,
  memberOf,
  versionOf,
} from './probe.ts'
export type {
  ProbeResult,
  ProbeReason,
} from './probe.ts'
export {
  guardFeature,
  getCompatRoster,
  consoleCompatLogger,
} from './guard.ts'
export type {
  CompatCheck,
  CompatLogger,
  FeatureVerdict,
  GuardFeatureOptions,
} from './guard.ts'
