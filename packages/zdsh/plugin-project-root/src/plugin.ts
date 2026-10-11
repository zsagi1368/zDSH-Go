/**
 * ProjectPluginLayer — the post-boot mount surface for project plugins (S-43
 * M2a). Owns the origin table, the tool-name attribution map, the RunGuard
 * watcher registry, and the tools/execute wrapper wiring.
 *
 * Mounting is serial and post-boot: every candidate is created through
 * `ctx.loader.create` (root group) with a `file://` module specifier, each
 * create is try/catch isolated (a failure removes that entry only — since
 * 0.1.7 the Loader group no longer rolls a failed entry out of the store by
 * itself, so THIS layer compensates with `loader.remove`; and since create
 * no longer rejects on import/apply failure, the settle check rides the
 * entry fiber seam — SYNC-P3), and the tool set is snapshotted before/after
 * each create so newly registered tools are attributed to the plugin that
 * introduced them.
 *
 * Project entries NEVER enter the include patch tree, so a mount failure can
 * never reach the boot-time whole-tree audit (B-07).
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { RunGuard, PluginError, type PluginManifest } from '@deepseek-ai/dsh-plugin-governance'
import { discoverProjectPlugins, PROJECT_PLUGIN_MANIFEST_FILENAME } from './discover.ts'
import { gate, PROJECT_PLUGIN_KERNEL_VERSION } from './gate.ts'
import { resolveProjectPluginEnabled } from './resolve.ts'
import { guardProjectRoot } from './compat.ts'
import {
  loadProjectTrusts,
  projectRootKey,
  projectTrustsDataDir,
  shouldMountProjectPlugin,
} from './ledger.ts'
import { projectToolWrapper } from './tool-guard.ts'
import { createSubprocessRuntime, type SubprocessRuntime } from './subprocess-runtime.ts'
import { wireSessionScope } from './session-scope.ts'
import type {
  ProjectPluginCandidate,
  ProjectPluginOrigin,
  GateReportEntry,
} from './types.ts'

/** Result of one mount pass. */
export interface MountResult {
  /** Loader entry ids that mounted successfully. */
  mounted: string[]
  /** Full gate+mount audit trail (gate rows plus mount-failed/mounted rows). */
  report: GateReportEntry[]
}

/** The host-side project plugin layer service. */
export interface ProjectPluginLayer {
  /**
   * Mount accepted candidates, one by one, isolated per entry.
   * @param accepted - candidates that passed the discovery gate.
   * @returns mount result with successfully mounted entry ids and full audit trail.
   */
  mount(accepted: ProjectPluginCandidate[]): Promise<MountResult>
  /**
   * Origin of one mounted loader entry id.
   * @param entryId - loader entry id returned by mount.
   * @returns the origin record, or `undefined` when the id is unknown.
   */
  originOf(entryId: string): ProjectPluginOrigin | undefined
  /**
   * The guarded manifest of one mounted loader entry id.
   * @param entryId - loader entry id returned by mount.
   * @returns the guarded manifest, or `undefined` when the id is unknown.
   */
  guardedManifestOf(entryId: string): PluginManifest | undefined
  /**
   * Canonical manifest id owning one tool name.
   * @param toolName - tool name registered by a project plugin.
   * @returns the manifest id that owns the tool, or `undefined` when unattributed.
   */
  toolOwnerOf(toolName: string): string | undefined
  /**
   * Project root owning one manifest id.
   * @param pluginId - manifest id of a mounted project plugin.
   * @returns the project root path, or `undefined` when unknown (M3 scope check).
   */
  projectRootOf(pluginId: string): string | undefined
  /**
   * Whether one manifest id runs in a subprocess.
   * @param pluginId - manifest id of a mounted project plugin.
   * @returns `true` when the plugin runs in an M2b subprocess (process/worker tier).
   */
  isSubprocess(pluginId: string): boolean
  /**
   * The subprocess runtime of one manifest id.
   * @param pluginId - manifest id of a mounted project plugin.
   * @returns the subprocess runtime, or `undefined` when the plugin runs inline.
   */
  subprocessOf(pluginId: string): SubprocessRuntime | undefined
  /**
   * Loader entry ids of subprocess-tier project plugins (M2b).
   * These entries have NO loader row — their tools are host-side proxies — so
   * the governance mirror must enumerate them separately from `loader.entries()`.
   * @returns an array of subprocess-tier loader entry ids.
   */
  subprocessEntryIds(): string[]
  /** The accumulated gate+mount report. */
  readonly report: readonly GateReportEntry[]
  /** The RunGuard backing every project tool call. */
  readonly runGuard: RunGuard
  /** Remove the tools/execute wrapper and drop all watchers and subprocesses. */
  dispose(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    projectPluginLayer: ProjectPluginLayer
  }
}

/** Loader entry id prefix for project plugins (the double-id space marker). */
const PROJECT_ENTRY_PREFIX = 'project-plugin-'

/**
 * A deterministic loader entry id for one root × plugin pair.
 * @param projectRoot - the raw project root path.
 * @param manifestId - the canonical plugin id from the manifest.
 * @returns the stable double-space entry id for the pair.
 */
export function projectEntryId(projectRoot: string, manifestId: string): string {
  const rootHash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 8)
  const safeId = manifestId.replace(/[^A-Za-z0-9_.-]/g, '-')
  return `${PROJECT_ENTRY_PREFIX}${rootHash}-${safeId}`
}

/** sha256 hex of the raw manifest bytes (must equal the discovery snapshot). */
function hashOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** B-10 TOCTOU re-check: the disk manifest must still hash to the guarded snapshot. */
function verifyCandidateUnchanged(candidate: ProjectPluginCandidate): boolean {
  try {
    const entryStats = lstatSync(candidate.entryFile)
    if (entryStats.isSymbolicLink()) return false
    const raw = readFileSync(join(candidate.pluginDir, PROJECT_PLUGIN_MANIFEST_FILENAME), 'utf8')
    return hashOf(raw) === candidate.manifestHash
  } catch {
    return false
  }
}

/** Tool names currently visible on the global scope (empty when tools is absent). */
function toolNames(ctx: Context): Set<string> {
  try {
    const tools = (ctx as Context & { tools?: { schemas?: (scope?: unknown) => Array<{ name: string }> } }).tools
    if (typeof tools.schemas !== 'function') return new Set()
    return new Set(tools.schemas().map(schema => schema.name))
  } catch {
    return new Set()
  }
}

/** Tool names declared in a plugin manifest's tool capabilities (the IPC whitelist). */
function manifestToolNames(manifest: PluginManifest): string[] {
  const names: string[] = []
  for (const cap of manifest.capabilities) {
    if (cap.type === 'tool' && cap.tool !== undefined) names.push(cap.tool.name)
  }
  return names
}

/**
 * Register a host-side proxy tool for a subprocess plugin. The manifest
 * declares the tool capability (name, description, schema); the proxy tool
 * forwards the call to the subprocess via its runtime.
 */
function registerSubprocessProxyTool(
  ctx: Context,
  pluginId: string,
  name: string,
  description: string | undefined,
  schema: Record<string, unknown> | undefined,
  runtime: SubprocessRuntime,
): void {
  // The tools runtime is always present at mount time (project plugins mount
  // post-boot, after the tools service is installed); a missing registry is a
  // wiring bug and must fail loudly, not silently skip the proxy surface.
  const tools = (ctx as Context & { tools: { register: (def: Record<string, unknown>) => () => void } }).tools
  tools.register({
    name,
    description: description ?? `project plugin tool ${name}`,
    parameters: schema ?? { type: 'object' },
    output: {
      schema: {},
      render: (_args: unknown, value: unknown) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
      ],
    },
    execute: async (args: unknown) => {
      const result = await runtime.executeTool(name, args)
      if (result.isError) {
        throw new PluginError(pluginId, result.error.message)
      }
      return result.value
    },
  })
}

/**
 * Create the project plugin layer for a context.
 * @param ctx - the settled boot context.
 * @returns the layer service.
 */
export function createProjectPluginLayer(ctx: Context): ProjectPluginLayer {
  const runGuard = new RunGuard()
  const origin = new Map<string, ProjectPluginOrigin>()
  const manifests = new Map<string, PluginManifest>()
  const toolOwners = new Map<string, string>()
  /** manifest id → owning project root (M3 session-scope and execute checks). */
  const pluginRoots = new Map<string, string>()
  const subprocesses = new Map<string, SubprocessRuntime>()
  const report: GateReportEntry[] = []
  let disposeWrapper: (() => void) | undefined
  let provideDisposer: (() => Promise<void>) | undefined

  // M3: bind every mounted project tool to its owning project root and
  // restrict it away from agents whose session cwd misses the root. The
  // wiring is inert without an agents service and never fails the boot.
  const sessionScope = wireSessionScope(ctx)
  const sessionScopeDisposer = (): void => { sessionScope.dispose() }

  const layer: ProjectPluginLayer = {
    runGuard,
    report,

    toolOwnerOf(toolName: string): string | undefined {
      return toolOwners.get(toolName)
    },

    projectRootOf(pluginId: string): string | undefined {
      return pluginRoots.get(pluginId)
    },

    isSubprocess(pluginId: string): boolean {
      return subprocesses.has(pluginId)
    },

    subprocessOf(pluginId: string): SubprocessRuntime | undefined {
      return subprocesses.get(pluginId)
    },

    subprocessEntryIds(): string[] {
      return [...origin.values()]
        .filter(p => p.runtimeTier === 'subprocess')
        .map(p => p.entryId)
    },

    originOf(entryId: string): ProjectPluginOrigin | undefined {
      return origin.get(entryId)
    },

    guardedManifestOf(entryId: string): PluginManifest | undefined {
      return manifests.get(entryId)
    },

    async mount(accepted: ProjectPluginCandidate[]): Promise<MountResult> {
      const mounted: string[] = []
      for (const candidate of accepted) {
        // B-10: the disk content must still match the discovery snapshot.
        if (!verifyCandidateUnchanged(candidate)) {
          report.push({
            root: candidate.projectRoot,
            id: candidate.id,
            version: candidate.version,
            verdict: 'mount-failed',
            check: 'toctou',
            message: `manifest or entry changed since discovery at ${candidate.projectRoot}; refusing to mount`,
          })
          continue
        }
        const sandbox = candidate.clampedSandbox
        // M2b: a process/worker clamped sandbox runs the plugin in a subprocess.
        if (sandbox.type === 'process' || sandbox.type === 'worker') {
          const entryId = projectEntryId(candidate.projectRoot, candidate.id)
          const toolNames_ = manifestToolNames(candidate.manifest)
          const runtime = createSubprocessRuntime({
            pluginId: candidate.id,
            type: sandbox.type,
            entryFile: candidate.entryFile,
            config: sandbox,
            toolWhitelist: toolNames_,
          })
          try {
            await runtime.start()
          } catch (cause) {
            report.push({
              root: candidate.projectRoot,
              id: candidate.id,
              version: candidate.version,
              verdict: 'mount-failed',
              check: 'subprocess-start',
              message: `failed to start subprocess at ${candidate.projectRoot}: ${cause instanceof Error ? cause.message : String(cause)}`,
            })
            continue
          }
          subprocesses.set(candidate.id, runtime)
          const guardedManifest = { ...candidate.manifest, sandbox }
          manifests.set(entryId, guardedManifest)
          pluginRoots.set(candidate.id, candidate.projectRoot)
          // Proxy tools: the manifest declares the IPC whitelist surface; each
          // host-side proxy forwards calls to the subprocess runtime. The
          // session scope applies to proxies exactly like in-process tools.
          const subprocessToolNames: string[] = []
          for (const cap of candidate.manifest.capabilities) {
            if (cap.type !== 'tool' || cap.tool === undefined) continue
            registerSubprocessProxyTool(
              ctx,
              candidate.id,
              cap.tool.name,
              cap.tool.description,
              cap.tool.schema,
              runtime,
            )
            toolOwners.set(cap.tool.name, candidate.id)
            subprocessToolNames.push(cap.tool.name)
          }
          if (subprocessToolNames.length > 0) {
            sessionScope.applyRestrictions(subprocessToolNames, candidate.projectRoot)
          }
          // Register a watcher for every mounted plugin (B-08).
          try {
            runGuard.watch(candidate.id, {
              manifest: { ...candidate.manifest, sandbox },
              install: () => {},
            })
          } catch (cause) {
            report.push({
              root: candidate.projectRoot,
              id: candidate.id,
              version: candidate.version,
              verdict: 'mount-failed',
              check: 'run-guard',
              message: `failed to register RunGuard watcher: ${cause instanceof Error ? cause.message : String(cause)}`,
            })
          }
          origin.set(entryId, {
            entryId,
            manifestId: candidate.id,
            version: candidate.version,
            projectRoot: candidate.projectRoot,
            pluginDir: candidate.pluginDir,
            manifestHash: candidate.manifestHash,
            clampedSandbox: sandbox,
            runtimeTier: 'subprocess',
            mountTime: Date.now(),
            guardVerdict: report.some(row => row.id === candidate.id && row.verdict === 'warned')
              ? 'warned'
              : 'allowed',
          })
          mounted.push(entryId)
          report.push({
            root: candidate.projectRoot,
            id: candidate.id,
            version: candidate.version,
            verdict: 'mounted',
            check: 'mount',
            message: `mounted ${JSON.stringify(candidate.id)} v${candidate.version} (${sandbox.type}) at ${candidate.projectRoot}`,
          })
          continue
        }
        const name = pathToFileURL(candidate.entryFile).href
        const before = toolNames(ctx)
        // Id taken up front (SYNC-P3): the compensation in the catch below
        // stays usable even when create itself rejects.
        const entryId = projectEntryId(candidate.projectRoot, candidate.id)
        try {
          const options: EntryOptions = { id: entryId, name, config: {} }
          await ctx.loader.create(options)
          // 0.1.7: create no longer rejects on import/apply failure — capture
          // at the fiber seam (SYNC-P3, the directory-picker-auto idiom); the
          // compensation below restores the 0.1.5 net state "a failure
          // removes that entry only" (header contract, the B-07 tree face).
          const entry = ctx.loader.resolve(entryId)
          if (entry.fiber === undefined) throw new Error(`the Loader dropped the import of ${name}`)
          await entry.fiber.await()
        } catch (cause) {
          // 0.1.7 removed the Loader's own failed-entry rollback, so this
          // layer removes the half-mounted residue itself: synchronous
          // fire-and-forget, never awaited, and a compensation fault must
          // not mask the original failure.
          try { ctx.loader.remove(entryId) } catch { /* best-effort compensation */ }
          report.push({
            root: candidate.projectRoot,
            id: candidate.id,
            version: candidate.version,
            verdict: 'mount-failed',
            check: 'mount',
            message: `failed to mount at ${candidate.projectRoot}: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
          continue
        }
        // Attribute newly visible tools to this plugin (serial mount ⇒ diff unambiguous).
        const after = toolNames(ctx)
        const attributed: string[] = []
        for (const toolName of after) {
          if (!before.has(toolName)) {
            toolOwners.set(toolName, candidate.id)
            attributed.push(toolName)
          }
        }
        pluginRoots.set(candidate.id, candidate.projectRoot)
        if (attributed.length > 0) {
          sessionScope.applyRestrictions(attributed, candidate.projectRoot)
        }
        // Record origin BEFORE the mirror can see the entry: mount runs at
        // boot, before the first governance sync pass, so the entry always finds
        // its origin (the fail-closed direction is "no origin ⇒ never
        // treated as a project entry").
        origin.set(entryId, {
          entryId,
          manifestId: candidate.id,
          version: candidate.version,
          projectRoot: candidate.projectRoot,
          pluginDir: candidate.pluginDir,
          manifestHash: candidate.manifestHash,
          clampedSandbox: candidate.clampedSandbox,
          runtimeTier: 'in-process',
          mountTime: Date.now(),
          guardVerdict: report.some(row => row.id === candidate.id && row.verdict === 'warned')
            ? 'warned'
            : 'allowed',
        })
        manifests.set(entryId, { ...candidate.manifest, sandbox: candidate.clampedSandbox })
        // Register a watcher for every mounted plugin (B-08).
        try {
          runGuard.watch(candidate.id, {
            manifest: { ...candidate.manifest, sandbox: candidate.clampedSandbox },
            install: () => {},
          })
        } catch (cause) {
          report.push({
            root: candidate.projectRoot,
            id: candidate.id,
            version: candidate.version,
            verdict: 'mount-failed',
            check: 'run-guard',
            message: `failed to register RunGuard watcher: ${cause instanceof Error ? cause.message : String(cause)}`,
          })
        }
        mounted.push(entryId)
        report.push({
          root: candidate.projectRoot,
          id: candidate.id,
          version: candidate.version,
          verdict: 'mounted',
          check: 'mount',
          message: `mounted ${JSON.stringify(candidate.id)} v${candidate.version} at ${candidate.projectRoot}`,
        })
      }
      return { mounted, report }
    },

    dispose(): void {
      disposeWrapper?.()
      disposeWrapper = undefined
      sessionScopeDisposer()
      void provideDisposer?.()
      provideDisposer = undefined
      for (const runtime of subprocesses.values()) void runtime.stop()
      subprocesses.clear()
      for (const id of runGuard.getActiveWatchers()) runGuard.unwatch(id)
    },
  }

  // The tools/execute wrapper is registered once, at layer creation.
  disposeWrapper = projectToolWrapper(ctx, {
    toolOwnerOf: name => toolOwners.get(name),
    projectRootOf: pluginId => pluginRoots.get(pluginId),
    runGuard,
  })

  provideDisposer = ctx.reflect.provide('projectPluginLayer', layer)
  return layer
}

/** Options for {@link mountProjectPlugins}. */
export interface MountProjectPluginsOptions {
  /** Starting directory for discovery (defaults to process.cwd()). */
  cwd?: string
  /** Override the persistence data directory (tests). */
  dataDir?: string
  /** Warn sink for author-facing diagnostics (defaults to stderr). */
  warn?: (message: string) => void
}

/**
 * The boot wiring seam: gate + ledger filter + mount project plugins on a
 * settled context. The switch is checked BEFORE any discovery happens — when
 * it is off, this function performs zero filesystem reads (A-01/A-02).
 * @param ctx - the settled boot context (boot() returned, before watchUserPatches).
 * @param rows - the composed entry index (bundles + user layers + overlays only).
 * @param options - cwd / dataDir / warn overrides.
 * @returns the created layer (undefined when the switch is off) and the audit report.
 */
export async function mountProjectPlugins(
  ctx: Context,
  rows: ReadonlyMap<string, EntryOptions>,
  options: MountProjectPluginsOptions = {},
): Promise<{ layer: ProjectPluginLayer | undefined; report: GateReportEntry[]; mounted: string[] }> {
  const warn = options.warn ?? ((message: string) => void process.stderr.write(`dsh project-plugins: ${message}\n`))

  // Compat guard: skip mount when the project-root plugin is disabled by the runtime.
  const enabled = await guardProjectRoot(ctx.logger)
  if (!enabled) {
    warn('project-root: disabled by compat guard')
    return { layer: undefined, report: [], mounted: [] }
  }

  // A-01/A-02: switch off ⇒ short-circuit before discovery (zero reads).
  if (!resolveProjectPluginEnabled(rows)) {
    return { layer: undefined, report: [], mounted: [] }
  }

  const cwd = options.cwd ?? process.cwd()
  const discovered = discoverProjectPlugins(cwd)
  // Pass the derived kernel version explicitly: this is the production mount
  // path, and LoadGuard.preLoad judges `dsh.compatible` windows against it.
  const { accepted, report } = await gate(discovered, { kernelVersion: PROJECT_PLUGIN_KERNEL_VERSION })
  const layer = createProjectPluginLayer(ctx)
  const dataDir = options.dataDir ?? projectTrustsDataDir()

  // Ledger filtering (C-02): untrusted roots stay pending; disabled plugins
  // never mount. Fail closed on any ledger read problem (untrusted).
  const trusts = loadProjectTrusts(dataDir)
  const toMount: ProjectPluginCandidate[] = []
  for (const candidate of accepted) {
    if (!shouldMountProjectPlugin(trusts, candidate.projectRoot, candidate.id)) {
      const rootTrusted = trusts.roots[projectRootKey(candidate.projectRoot)] !== undefined
      report.push({
        root: candidate.projectRoot,
        id: candidate.id,
        version: candidate.version,
        verdict: 'rejected',
        check: rootTrusted ? 'ledger-disabled' : 'pending-trust',
        message: rootTrusted
          ? `plugin ${JSON.stringify(candidate.id)} is disabled in the project trust ledger; not mounting`
          : `project root ${candidate.projectRoot} is not trusted yet; plugin ${JSON.stringify(candidate.id)} stays pending-trust`,
      })
      continue
    }
    toMount.push(candidate)
  }

  const { mounted } = await layer.mount(toMount)
  // Author-facing diagnostics: rejections and mount failures go to stderr.
  for (const row of report) {
    if (row.verdict === 'rejected' || row.verdict === 'mount-failed') {
      warn(`${row.check}: ${row.message}`)
    }
  }
  return { layer, report, mounted }
}
