/**
 * Project plugin discovery (S-43 M1): scan `<projectRoot>/.dsh/plugins/<id>/`
 * and produce guarded candidates.
 *
 * Hard rules:
 * - Symlink/junction entries are REJECTED with a warning naming the path
 *   (A-04). Unlike the skill filesystem precedent (which follows symlinks for
 *   text content), code loading must never follow links — a junction could
 *   point the plugin body at any other writable location on the machine.
 * - A malformed or incomplete manifest skips the candidate with a warning
 *   containing the path; discovery never fails the boot (A-05).
 * - Candidates are plain objects constructed here; nothing is ever serialized
 *   to YAML, so `!!js` expression injection has no surface (A-06/A7.4).
 * - `pluginDir` is realpathed before use: an internal junction redirecting a
 *   plugin's own directory to the outside must not widen the clamp's allowed
 *   path set (DESIGN §2.2 risk note).
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePluginId, validatePluginId, type PluginManifest } from '@deepseek-ai/dsh-plugin-governance'
import { findProjectRoot } from './find-project-root.ts'
import type { DiscoveredProjectPlugin } from './types.ts'

/** Plugin package manifest filename inside `<root>/.dsh/plugins/<id>/`. */
export const PROJECT_PLUGIN_MANIFEST_FILENAME = 'manifest.json'

/** Entry module filename inside a plugin package (a Cordis plugin module). */
export const PROJECT_PLUGIN_ENTRY_FILENAME = 'index.js'

/** The single project plugin root name (`.agents/plugins` stays out of scope). */
export const PROJECT_PLUGINS_DIRNAME = '.dsh/plugins'

/** Warn sink used by discovery; defaults to stderr. */
export type DiscoveryWarn = (message: string) => void

/** Options for {@link discoverProjectPlugins}. */
export interface DiscoverOptions {
  /** Warn sink for skipped entries (defaults to stderr). */
  warn?: DiscoveryWarn
}

/** Default warn sink: every warning names the offending path. */
function defaultWarn(message: string): void {
  process.stderr.write(`dsh project-plugins: ${message}\n`)
}

/** Whether `path` is a symbolic link or (on Windows) a junction. */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Content hash (sha256) of the raw manifest bytes; pins the guard snapshot. */
function hashOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Required manifest fields, mirroring LoadGuard's integrity check vocabulary. */
function missingManifestFields(value: Record<string, unknown>): string[] {
  const missing: string[] = []
  if (typeof value.id !== 'string' || value.id.trim().length === 0) missing.push('id')
  if (typeof value.version !== 'string' || value.version.trim().length === 0) missing.push('version')
  if (typeof value.name !== 'string' || value.name.trim().length === 0) missing.push('name')
  const dsh = value.dsh as Record<string, unknown> | undefined
  if (typeof dsh?.compatible !== 'string' || dsh.compatible.trim().length === 0) missing.push('dsh.compatible')
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) missing.push('capabilities')
  if (typeof value.sandbox !== 'object' || value.sandbox === null) missing.push('sandbox')
  return missing
}

/** Read one plugin package directory into a candidate, or `null` when skipped. */
function readPluginPackage(
  root: string,
  pluginDir: string,
  warn: DiscoveryWarn,
): DiscoveredProjectPlugin | null {
  if (isLink(pluginDir)) {
    warn(`skipping ${pluginDir}: .dsh/plugins entries must not be symbolic links or junctions`)
    return null
  }
  let realDir: string
  try {
    realDir = realpathSync(pluginDir)
  } catch {
    warn(`skipping ${pluginDir}: failed to resolve real path`)
    return null
  }
  const manifestPath = join(realDir, PROJECT_PLUGIN_MANIFEST_FILENAME)
  if (isLink(manifestPath)) {
    warn(`skipping ${pluginDir}: ${PROJECT_PLUGIN_MANIFEST_FILENAME} must not be a symbolic link`)
    return null
  }
  let raw: string
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch {
    warn(`skipping ${pluginDir}: no readable ${PROJECT_PLUGIN_MANIFEST_FILENAME}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    warn(`skipping ${pluginDir}: ${PROJECT_PLUGIN_MANIFEST_FILENAME} is not valid JSON`)
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    warn(`skipping ${pluginDir}: ${PROJECT_PLUGIN_MANIFEST_FILENAME} is not a JSON object`)
    return null
  }
  const fields = parsed as Record<string, unknown>
  const missing = missingManifestFields(fields)
  if (missing.length > 0) {
    warn(`skipping ${pluginDir}: manifest missing required field(s): ${missing.join(', ')}`)
    return null
  }
  const rawId = typeof fields.id === 'string' ? fields.id : ''
  const id = normalizePluginId(rawId)
  if (!validatePluginId(id)) {
    warn(`skipping ${pluginDir}: manifest id ${JSON.stringify(rawId)} does not normalize to a valid plugin id (namespace/name)`)
    return null
  }
  const entryFile = join(realDir, PROJECT_PLUGIN_ENTRY_FILENAME)
  if (isLink(entryFile)) {
    warn(`skipping ${pluginDir}: ${PROJECT_PLUGIN_ENTRY_FILENAME} must not be a symbolic link`)
    return null
  }
  try {
    lstatSync(entryFile)
  } catch {
    warn(`skipping ${pluginDir}: entry module ${PROJECT_PLUGIN_ENTRY_FILENAME} is missing`)
    return null
  }
  return {
    id,
    version: typeof fields.version === 'string' ? fields.version : '',
    name: typeof fields.name === 'string' ? fields.name : '',
    projectRoot: root,
    pluginDir: realDir,
    manifest: parsed as PluginManifest,
    manifestHash: hashOf(raw),
    entryFile,
    source: 'project',
  }
}

/**
 * Discover project plugins under `cwd`'s project root. The switch gate
 * (`resolveProjectPluginEnabled`) must be checked by the caller BEFORE calling
 * this — with the switch off, discovery is never invoked (zero reads, A-02).
 * @param cwd - the starting directory; its project root owns the plugin root.
 * @param opts - warn sink override.
 * @returns the discovered candidates, in directory order.
 */
export function discoverProjectPlugins(cwd: string, opts: DiscoverOptions = {}): DiscoveredProjectPlugin[] {
  const warn = opts.warn ?? defaultWarn
  const root = findProjectRoot(cwd)
  const pluginsRoot = join(root, PROJECT_PLUGINS_DIRNAME)
  let entries
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
  } catch {
    // No project plugin root at all: nothing to discover, nothing to warn.
    return []
  }
  const candidates: DiscoveredProjectPlugin[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      warn(`skipping ${join(pluginsRoot, entry.name)}: .dsh/plugins entries must not be symbolic links or junctions`)
      continue
    }
    if (!entry.isDirectory()) continue
    const candidate = readPluginPackage(root, join(pluginsRoot, entry.name), warn)
    if (candidate !== null) candidates.push(candidate)
  }
  return candidates
}
