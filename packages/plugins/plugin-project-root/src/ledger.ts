/**
 * Project trust ledger (S-43 M2a, C-02): durable root × plugin enable/disable
 * decisions, reusing the approvals.json narrowing + fail-closed precedent
 * (plugin-governance-host/src/index.ts approvals ledger).
 *
 * Data model (`data/project-trusts.json` under the persistence data dir):
 *   { version: 1, roots: { "<abs project root>": {
 *       trustedAt: number, plugins: { "<canonical id>": { decidedAt, enabled } }
 *   } } }
 *
 * - Keys are project-root absolute paths (case-folded like the preset-root
 *   merge on Windows) × canonical plugin ids (`normalizePluginId`).
 * - A missing or corrupt ledger is read as empty (fail closed: every root is
 *   untrusted, so nothing mounts until the operator records a decision).
 * - Project plugins never enter the registry.json persistedDecisions mechanism
 *   (single-keyed); this ledger is their sole decision store.
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizePluginId, resolveBranchStorageRoot } from '@deepseek-ai/dsh-plugin-governance'

/** The ledger file name under the persistence data directory. */
export const PROJECT_TRUSTS_FILENAME = 'project-trusts.json'

/** Per-plugin enable/disable decision. */
export interface ProjectPluginDecision {
  /** Epoch millis of the recorded decision. */
  decidedAt: number
  /** Whether the plugin mounts on boot. */
  enabled: boolean
}

/** One trusted project root and its per-plugin decisions. */
export interface ProjectRootTrust {
  /** Epoch millis of the root trust confirmation. */
  trustedAt: number
  /** Per-plugin decisions, keyed by canonical plugin id. */
  plugins: Record<string, ProjectPluginDecision>
}

/** The durable ledger document. */
export interface ProjectTrusts {
  version: 1
  roots: Record<string, ProjectRootTrust>
}

/**
 * Empty ledger — the fail-closed default for missing/corrupt files.
 * @returns an empty v1 ledger with no trusted roots.
 */
export function emptyProjectTrusts(): ProjectTrusts {
  return { version: 1, roots: {} }
}

/**
 * Case-fold a project root key (Windows paths are case-insensitive), matching
 * the preset-root merge convention.
 * @param projectRoot - the raw project root path.
 * @returns the canonical (resolved, case-folded on Windows) root key.
 */
export function projectRootKey(projectRoot: string): string {
  const resolved = resolve(projectRoot)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Resolve the persistence data directory used for the ledger, delegating to
 * the authoritative `resolveBranchStorageRoot` chain (`DSH_BRANCH_HOME` →
 * `<DSH_HOME>/zdsh` → `~/.dsh-zdsh-go`), then `data/`.
 * @param env - the environment used to resolve the storage root; defaults to `process.env`.
 * @returns the absolute data directory path.
 */
export function projectTrustsDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveBranchStorageRoot(env), 'data')
}

/**
 * The ledger file path under `dataDir`.
 * @param dataDir - the absolute data directory.
 * @returns the full ledger file path.
 */
export function projectTrustsPath(dataDir: string): string {
  return join(dataDir, PROJECT_TRUSTS_FILENAME)
}

/** Narrow one parsed JSON document to a valid ledger; anything else is empty. */
function narrowProjectTrusts(value: unknown): ProjectTrusts {
  if (typeof value !== 'object' || value === null) return emptyProjectTrusts()
  const doc = value as Record<string, unknown>
  if (doc.version !== 1) return emptyProjectTrusts()
  if (typeof doc.roots !== 'object' || doc.roots === null) return emptyProjectTrusts()
  const roots: Record<string, ProjectRootTrust> = {}
  for (const [root, trust] of Object.entries(doc.roots)) {
    if (typeof trust !== 'object' || trust === null) continue
    const trustRecord = trust as Record<string, unknown>
    if (typeof trustRecord.trustedAt !== 'number' || !Number.isFinite(trustRecord.trustedAt)) continue
    const plugins: Record<string, ProjectPluginDecision> = {}
    if (typeof trustRecord.plugins === 'object' && trustRecord.plugins !== null) {
      for (const [pluginId, decision] of Object.entries(trustRecord.plugins as Record<string, unknown>)) {
        if (typeof decision !== 'object' || decision === null) continue
        const decisionRecord = decision as Record<string, unknown>
        if (typeof decisionRecord.decidedAt !== 'number' || !Number.isFinite(decisionRecord.decidedAt)) continue
        if (typeof decisionRecord.enabled !== 'boolean') continue
        plugins[normalizePluginId(pluginId)] = {
          decidedAt: decisionRecord.decidedAt,
          enabled: decisionRecord.enabled,
        }
      }
    }
    roots[projectRootKey(root)] = { trustedAt: trustRecord.trustedAt, plugins }
  }
  return { version: 1, roots }
}

/**
 * Read the project trust ledger from `dataDir`. Missing or corrupt files read
 * as empty (fail closed: no root is trusted).
 * @param dataDir - the persistence data directory.
 * @returns the ledger document.
 */
export function loadProjectTrusts(dataDir: string): ProjectTrusts {
  const path = projectTrustsPath(dataDir)
  if (!existsSync(path)) return emptyProjectTrusts()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    // Corrupt or half-written ledger: no decisions worth keeping; every root
    // reverts to untrusted (fail closed), same as the approvals ledger.
    return emptyProjectTrusts()
  }
  return narrowProjectTrusts(parsed)
}

/**
 * Write the project trust ledger under `dataDir`, creating the directory on
 * first use. Throws on failure so the caller can compensate.
 * @param dataDir - the persistence data directory.
 * @param trusts - the ledger document to persist.
 */
export function saveProjectTrusts(dataDir: string, trusts: ProjectTrusts): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(projectTrustsPath(dataDir), JSON.stringify(trusts, null, 2))
}

/**
 * Record (or update) one root's trust confirmation. The root becomes trusted;
 * existing per-plugin decisions are preserved.
 * @param trusts - the in-memory ledger to mutate.
 * @param projectRoot - absolute project root path.
 * @param at - decision epoch millis (defaults to now).
 * @returns the mutated ledger.
 */
export function trustProjectRoot(trusts: ProjectTrusts, projectRoot: string, at = Date.now()): ProjectTrusts {
  const key = projectRootKey(projectRoot)
  const existing = trusts.roots[key]
  trusts.roots[key] = {
    trustedAt: existing?.trustedAt ?? at,
    plugins: existing?.plugins ?? {},
  }
  return trusts
}

/**
 * Record (or update) one plugin's enable/disable decision under a trusted root.
 * @param trusts - the in-memory ledger to mutate.
 * @param projectRoot - absolute project root path.
 * @param pluginId - raw manifest plugin id (normalized before storage).
 * @param enabled - the enable/disable decision.
 * @param at - decision epoch millis (defaults to now).
 * @returns the mutated ledger.
 */
export function decideProjectPlugin(
  trusts: ProjectTrusts,
  projectRoot: string,
  pluginId: string,
  enabled: boolean,
  at = Date.now(),
): ProjectTrusts {
  const key = projectRootKey(projectRoot)
  const root = trusts.roots[key]
  if (root === undefined) {
    // Recording a decision implicitly trusts the root (the trust command and
    // the per-plugin decision are written together after confirmation).
    trusts.roots[key] = { trustedAt: at, plugins: {} }
  }
  const rootTrust = trusts.roots[key] as ProjectRootTrust
  rootTrust.plugins[normalizePluginId(pluginId)] = { decidedAt: at, enabled }
  return trusts
}

/**
 * Whether a candidate should mount under the ledger: the root must be trusted,
 * and no per-plugin decision must disable it. Untracked plugins under a
 * trusted root mount by default (trust is a property of the root).
 * @param trusts - the ledger.
 * @param projectRoot - absolute project root path.
 * @param pluginId - canonical plugin id.
 * @returns true when the plugin should mount.
 */
export function shouldMountProjectPlugin(trusts: ProjectTrusts, projectRoot: string, pluginId: string): boolean {
  const root = trusts.roots[projectRootKey(projectRoot)]
  if (root === undefined) return false
  const decision = root.plugins[normalizePluginId(pluginId)]
  return decision === undefined || decision.enabled
}
