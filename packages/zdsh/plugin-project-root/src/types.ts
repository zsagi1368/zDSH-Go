/**
 * Shared types for the project plugin root layer (S-43 M1 + M2a).
 *
 * Trust is a property of the project root, assigned by the discoverer: a
 * discovered file never self-reports trust. Every value in this module is a
 * server-side (host) construction; the UI renders it, it never infers it.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import type { PluginManifest, PluginSandboxConfig } from '@deepseek-ai/dsh-plugin-governance'
import type { ProjectPluginRuntimeTier } from './clamp.ts'

/** A project plugin entry as discovered from `<root>/.dsh/plugins/<id>/`. */
export interface DiscoveredProjectPlugin {
  /** Canonical manifest id (`namespace/name`), the ledger and roster key. */
  id: string
  /** Manifest semver version. */
  version: string
  /** Manifest display name. */
  name: string
  /** Absolute project root that owns this plugin. */
  projectRoot: string
  /** Absolute realpath of the plugin package directory. */
  pluginDir: string
  /** Parsed, integrity-checked manifest snapshot (the guarded object). */
  manifest: PluginManifest
  /** Content hash (sha256) of the raw manifest.json bytes; pins the guard snapshot. */
  manifestHash: string
  /** Absolute entry module path (`<pluginDir>/index.js`). */
  entryFile: string
  /** Trust origin — always 'project' for this layer. */
  source: 'project'
}

/** A discovered candidate after host clamping; what `gate` accepts for mounting. */
export interface ProjectPluginCandidate extends DiscoveredProjectPlugin {
  /** Host-clamped effective sandbox (manifest declares, host grants). */
  clampedSandbox: PluginSandboxConfig
}

/** One row of the gate report; every verdict is visible to roster and authors. */
export interface GateReportEntry {
  /** Absolute project root path. */
  root: string
  /** Canonical plugin id. */
  id: string
  /** Manifest version. */
  version: string
  /** 'rejected' never reaches the mount list; 'mount-failed' is isolated at mount. */
  verdict: 'rejected' | 'warned' | 'mounted' | 'mount-failed'
  /** Machine-readable check name (clamp / guard check / capability / ...). */
  check: string
  /** Author-facing message, including the project root and plugin id+version. */
  message: string
}

/** Immutable origin carried with one mounted project entry. */
export interface ProjectPluginOrigin {
  /** Loader-generated entry id inside the root entry tree. */
  entryId: string
  /** Canonical manifest id; the roster and ledger key. */
  manifestId: string
  /** Manifest version. */
  version: string
  /** Absolute project root path. */
  projectRoot: string
  /** Absolute realpath plugin package directory. */
  pluginDir: string
  /** Content hash of the guarded manifest snapshot. */
  manifestHash: string
  /** Host-clamped effective sandbox. */
  clampedSandbox: PluginSandboxConfig
  /**
   * Actual runtime tier: 'in-process' for inline entries (M2a behavior), or
   * 'subprocess' for process/worker entries (M2b — the entry runs in a child
   * process or worker thread with an OS boundary).
   */
  runtimeTier: ProjectPluginRuntimeTier
  /** Epoch millis of the successful mount. */
  mountTime: number
  /** Gate verdict that admitted this entry. */
  guardVerdict: 'allowed' | 'warned'
}
