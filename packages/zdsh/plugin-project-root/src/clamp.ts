/**
 * Host clamp for project plugin sandbox declarations (S-43 M2a + M2b, R-S43 A).
 *
 * The plugin's manifest sandbox section is an APPLICATION; the host clamp
 * produces the EFFECTIVE sandbox, rejecting or narrowing declared values that
 * exceed the project-plugin boundary. The clamp runs BEFORE LoadGuard.preLoad
 * in the gate pipeline, so the guard sees the clamped config.
 *
 * M2b runtime tier: a plugin that DECLARES a subprocess tier (`process` or
 * `worker`) is granted that tier — the effective `type` takes it over and
 * `runtimeTier` is `'subprocess'`, the roster/UI display field. A plugin that
 * declares `inline` (or nothing) keeps the M2a in-process runtime unchanged
 * (`runtimeTier: 'in-process'`), preserving M2a behavior for plugins that do
 * not opt into an OS boundary.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { resolve } from 'node:path'
import type { PluginSandboxConfig } from '@deepseek-ai/dsh-plugin-governance'

/** One clamp rejection or warning row. */
export interface ClampRejection {
  /** Machine-readable check name. */
  check: string
  /** Author-facing message naming the declared value vs the clamped bound. */
  message: string
}

/** Actual OS-boundary tier a project plugin runs under (roster display field). */
export type ProjectPluginRuntimeTier = 'in-process' | 'subprocess'

/** Clamp output: the effective sandbox plus diagnostics. */
export interface ProjectPluginClamp {
  /** Host-clamped effective sandbox (the granted config, not the declared one). */
  effective: PluginSandboxConfig
  /**
   * Actual runtime tier the effective sandbox maps to: `'in-process'` for
   * inline entries (no OS boundary, M2a behavior), `'subprocess'` for process
   * and worker entries (the entry runs in a child process / worker thread).
   */
  runtimeTier: ProjectPluginRuntimeTier
  /** Error-level rejections — the caller must reject the candidate. */
  rejections: ClampRejection[]
  /** Warning-level narrowing notes — the candidate is accepted but narrowed. */
  warnings: ClampRejection[]
}

/** M2a runtime tier constant — in-process, kept for the inline fallback path. */
export const M2A_RUNTIME_TIER = 'in-process' as const

/** M2b runtime tier constant — subprocess (process/worker OS boundary). */
export const M2B_RUNTIME_TIER = 'subprocess' as const

/** The host-level cap every project plugin is clamped to. */
export const PROJECT_PLUGIN_HOST_CAPS = {
  maxMemoryLimitMb: 512,
  maxTimeoutMs: 60_000,
} as const

/** Default deny-all sandbox for project plugin sections. */
const DENY_ALL_SANDBOX: PluginSandboxConfig = {
  type: 'inline',
  resources: { memoryLimitMb: 256, cpuLimit: 50, timeoutMs: 30_000, maxOutputBytes: 10_000 },
  filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
  network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
  environment: { whitelist: [], blacklist: [], clear: false },
  process: { spawn: false, exec: false, allowedCommands: [] },
}

/**
 * Clamp the declared sandbox of a project plugin candidate into the host-
 * granted effective sandbox. The clamp runs BEFORE LoadGuard.preLoad, so the
 * guard always sees the clamped (host-authorised) values.
 *
 * @param declared - the manifest-declared sandbox (may be partial — clamp fills
 *   defaults for every missing section).
 * @param pluginDir - realpathed absolute plugin package directory, used as the
 *   default allowedPath.
 * @param hostCaps - host-level caps (memory, timeout).
 * @returns the clamp result — effective sandbox plus rejections and warnings.
 */
export function clampProjectPluginSandbox(
  declared: Partial<PluginSandboxConfig>,
  pluginDir: string,
  hostCaps: { maxMemoryLimitMb: number; maxTimeoutMs: number } = PROJECT_PLUGIN_HOST_CAPS,
): ProjectPluginClamp {
  const rejections: ClampRejection[] = []
  const warnings: ClampRejection[] = []

  // --- type: M2b grants the declared subprocess tier; inline stays inline ---
  // The declared type may be 'process' or 'worker' — those are granted as the
  // effective type and the entry runs in a subprocess (M2b). Declared 'inline'
  // (or nothing) keeps the M2a in-process runtime: no OS boundary, no warning,
  // full M2a compatibility for plugins that do not opt in.
  const declaredType = declared.type
  const effectiveType: 'process' | 'worker' | 'inline' =
    declaredType === 'worker' || declaredType === 'process' ? declaredType : 'inline'
  const runtimeTier: ProjectPluginRuntimeTier =
    effectiveType === 'inline' ? M2A_RUNTIME_TIER : M2B_RUNTIME_TIER

  // --- resources: memory, timeout ---
  const declaredResources = declared.resources
  let memoryLimitMb = declaredResources?.memoryLimitMb ?? DENY_ALL_SANDBOX.resources.memoryLimitMb
  let timeoutMs = declaredResources?.timeoutMs ?? DENY_ALL_SANDBOX.resources.timeoutMs

  if (memoryLimitMb > hostCaps.maxMemoryLimitMb) {
    warnings.push({
      check: 'memory-limit',
      message: `memoryLimitMb ${memoryLimitMb} exceeds host cap ${hostCaps.maxMemoryLimitMb}; clamped to ${hostCaps.maxMemoryLimitMb}`,
    })
    memoryLimitMb = hostCaps.maxMemoryLimitMb
  }
  if (memoryLimitMb < 1) {
    warnings.push({
      check: 'memory-limit',
      message: `memoryLimitMb ${memoryLimitMb} is below minimum 1; raised to 1`,
    })
    memoryLimitMb = 1
  }
  if (timeoutMs > hostCaps.maxTimeoutMs) {
    warnings.push({
      check: 'timeout',
      message: `timeoutMs ${timeoutMs} exceeds host cap ${hostCaps.maxTimeoutMs}; clamped to ${hostCaps.maxTimeoutMs}`,
    })
    timeoutMs = hostCaps.maxTimeoutMs
  }
  if (timeoutMs < 1) {
    warnings.push({
      check: 'timeout',
      message: `timeoutMs ${timeoutMs} is below minimum 1; raised to 1`,
    })
    timeoutMs = 1
  }

  // --- filesystem: allowedPaths = [pluginDir] ∩ declared ---
  // Scope-intersection semantics (B-02): a declared path survives only when it
  // lives inside pluginDir; pluginDir itself is allowed when a declared path
  // covers it (the declared path is pluginDir or one of its ancestors). An
  // empty intersection is fail-closed (path-guard denies everything).
  const declaredFilesystem = declared.filesystem
  const declaredPaths = declaredFilesystem?.allowedPaths ?? []
  // Case-folded keys on Windows (path-guard uses the same convention).
  const keyOf = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  // Strip a trailing separator so a drive root like `C:\` still prefix-matches
  // `C:\repo\...` after appending a fresh separator.
  const stemOf = (p: string): string => keyOf(p).replace(/[\\/]+$/u, '')
  const pluginDirKey = stemOf(pluginDir)
  const withinPluginDir = (candidate: string): boolean =>
    keyOf(candidate) === pluginDirKey
    || keyOf(candidate).startsWith(pluginDirKey + '/')
    || keyOf(candidate).startsWith(pluginDirKey + '\\')
  const coversPluginDir = (candidate: string): boolean =>
    keyOf(candidate) === pluginDirKey
    || pluginDirKey.startsWith(stemOf(candidate) + '/')
    || pluginDirKey.startsWith(stemOf(candidate) + '\\')
  const safePaths = declaredPaths
    .map(p => resolve(p))
    .filter(withinPluginDir)
  const declaredCoversPluginDir = declaredPaths.some(p => coversPluginDir(resolve(p)))
  if (declaredCoversPluginDir && !safePaths.some(p => keyOf(p) === pluginDirKey)) {
    safePaths.push(pluginDir)
  }
  const dropped = declaredPaths.filter(p => !withinPluginDir(resolve(p)) && !coversPluginDir(resolve(p)))
  if (dropped.length > 0) {
    warnings.push({
      check: 'allowed-paths',
      message: `declared allowedPaths ${JSON.stringify(dropped)} lie outside [${pluginDir}]; dropped (effective: ${JSON.stringify(safePaths)})`,
    })
  }
  if (safePaths.length === 0) {
    warnings.push({
      check: 'allowed-paths',
      message: 'allowedPaths intersection is empty — all filesystem access will be denied (fail-closed)',
    })
  }

  // --- network: forced 'none' + allowLocal false ---
  const declaredNetwork = declared.network
  if (declaredNetwork?.access !== undefined && declaredNetwork.access !== 'none') {
    rejections.push({
      check: 'network',
      message: `network.access '${declaredNetwork.access}' is not allowed for project plugins; only 'none' is permitted (B-03)`,
    })
  }
  if (declaredNetwork?.allowLocal === true) {
    warnings.push({
      check: 'network-allow-local',
      message: 'network.allowLocal is forced to false for project plugins',
    })
  }

  // --- process: fullyAuthorized undefined, spawn/exec false ---
  const declaredProcess = declared.process
  if (declaredProcess?.fullyAuthorized === true) {
    rejections.push({
      check: 'fully-authorized',
      message: 'process.fullyAuthorized is not allowed for project plugins; must be undefined or false (B-01)',
    })
  }
  if (declaredProcess?.spawn === true) {
    rejections.push({
      check: 'process-spawn',
      message: 'process.spawn is not allowed for project plugins; must be false',
    })
  }
  if (declaredProcess?.exec === true) {
    rejections.push({
      check: 'process-exec',
      message: 'process.exec is not allowed for project plugins; must be false',
    })
  }

  // --- environment: keep declared whitelist/blacklist/clear as-is ---
  const declaredEnv = declared.environment

  // Build the effective sandbox.
  const effective: PluginSandboxConfig = {
    type: effectiveType,
    resources: {
      memoryLimitMb,
      cpuLimit: declaredResources?.cpuLimit ?? DENY_ALL_SANDBOX.resources.cpuLimit,
      timeoutMs,
      maxOutputBytes: declaredResources?.maxOutputBytes ?? DENY_ALL_SANDBOX.resources.maxOutputBytes,
    },
    filesystem: {
      access: declaredFilesystem?.access ?? DENY_ALL_SANDBOX.filesystem.access,
      allowedPaths: safePaths,
      deniedPatterns: declaredFilesystem?.deniedPatterns ?? DENY_ALL_SANDBOX.filesystem.deniedPatterns,
    },
    network: {
      access: 'none',
      allowedHosts: [],
      deniedHosts: [],
      allowLocal: false,
    },
    environment: {
      whitelist: declaredEnv?.whitelist ?? DENY_ALL_SANDBOX.environment.whitelist,
      blacklist: declaredEnv?.blacklist ?? DENY_ALL_SANDBOX.environment.blacklist,
      clear: declaredEnv?.clear ?? DENY_ALL_SANDBOX.environment.clear,
    },
    process: {
      spawn: false,
      exec: false,
      allowedCommands: [],
    },
  }

  return { effective, runtimeTier, rejections, warnings }
}
