/**
 * Host-plane governance service over @deepseek-ai/dsh-plugin-governance.
 * Registers the `pluginGovernance` Cordis service and publishes its roster,
 * lifecycle, health, admission, and preset operations as generated direct
 * Remotes for trusted clients.
 * @module @deepseek-ai/dsh-plugin-governance-host
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, Service, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  DefaultPluginRegistry,
  isCordisPlugin,
  normalizePluginId,
  PluginPersistence,
  PluginPermissionLevel,
  PluginStatus,
  validatePluginId,
  wrapCordisPlugin,
  type CordisService,
  type Plugin as GovernedPlugin,
  type PluginContext as GovernedPluginContext,
  type PluginManifest as GovernedManifest,
  type PluginRegistry,
} from '@deepseek-ai/dsh-plugin-governance'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  DEFAULT_REGISTRY_URL,
  NpmSourceError,
  downloadVerifiedTarball,
  matchesSha512Integrity,
  parseNpmSpec,
  registryOriginFromConfig,
  resolveRegistryVersion,
  type HttpLike,
  type NpmSpec,
} from './install/registry-source.ts'
import { TarExtractionError, extractNpmPackageTarball } from './install/tarball.ts'
import { writeFileAtomicSync } from './atomic-write-sync.ts'
import { resolveContainedPath, resolveFactoryModulePath } from './path-containment.ts'
import { SeedPreinstaller } from './preinstall/preinstaller.ts'
import { mountProjectPluginsOnHost } from './project-source.ts'
import type {
  DisablePluginRequest,
  GovernedCapabilityView,
  GovernedPluginDetail,
  GovernedPluginHealthEntry,
  GovernedPluginSummary,
  GovernanceAcknowledgement,
  GovernanceErrorCode,
  GovernanceHealthReport,
  GovernanceResult,
  GovernanceRosterSnapshot,
  InstallPluginRequest,
  PluginGovernanceId,
  PluginGovernanceStatus,
  PluginIdRequest,
  PreinstallReport,
  PresetApplicationReport,
  PresetNameRequest,
} from './types.ts'

export type * from './types.ts'

/** Brand an already-validated governance id at this owning boundary. */
function governedId(value: string): PluginGovernanceId {
  return value as PluginGovernanceId
}

/**
 * Normalize a wire or manifest id to the governance spec's canonical
 * `namespace/name` form — the exact key space the registry stores under.
 */
function canonicalId(value: string): PluginGovernanceId {
  return governedId(normalizePluginId(value))
}

/** Runtime mirror: `PluginStatus` is a string enum owned by another package. */
const STATUS_NAMES = {
  [PluginStatus.ACTIVE]: 'active',
  [PluginStatus.WARNINGS]: 'warnings',
  [PluginStatus.DISABLED]: 'disabled',
  [PluginStatus.ERROR]: 'error',
  [PluginStatus.DEPRECATED]: 'deprecated',
} as const satisfies Record<PluginStatus, PluginGovernanceStatus>

/** Runtime mirror: `FiberState` is a cross-package const enum with no runtime object. */
const FIBER_ACTIVE = 2 as FiberState.ACTIVE

/** Minimal read view of one service implementation stored on a mounted fiber. */
interface ProvidedImplementation {
  readonly value?: unknown
}

/** Structural view of the Loader surface this service mirrors from. */
interface MountedEntry {
  readonly options: { group?: boolean | null; name: string; id: string }
  readonly disabled?: boolean | null
  readonly fiber?: Fiber
}

interface LoaderLike {
  entries?: () => Iterable<MountedEntry>
  /**
   * The Loader's mount face (§9.3): creates one entry in the live tree.
   * The governance host only ever calls this with `name` = the file URL of
   * an admitted factory exit (M-F4) and `id` = `factory/<pluginId>`.
   * 0.1.7 contract (SYNC-P3): the promise resolves once the entry's fiber
   * EXISTS — an import failure is logged-and-dropped on the host side (the
   * fiber stays undefined) and an apply failure settles on the fiber;
   * neither rejects create any more. Only the synchronous `invalid plugin`
   * throw of the cordis registry still rejects. Failure capture therefore
   * rides the resolve/fiber check face below (the directory-picker-auto
   * idiom), never create's rejection alone.
   */
  create?: (options: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
  /**
   * Entry lookup by id (SYNC-P3 capture face). The cordis Loader THROWS for
   * an unresolvable id, so callers must treat this as a probe, not a read.
   * Optional: a double without it falls back to the entries iteration.
   */
  resolve?: (id: string) => MountedEntry
  /**
   * Stop and remove one entry (SYNC-P3 compensation face). Synchronous
   * fire-and-forget in 0.1.7 (it disposes the fiber without awaiting it), so
   * callers must NOT await it — kept un-awaited for both loader generations.
   */
  remove?: (id: string) => unknown
}

/**
 * Locate one entry on a LoaderLike by id (SYNC-P3, structured probing with
 * the same discipline as resolveLoader/resolveMountLoader): the resolve face
 * first — 0.1.7 throws for an unresolvable id, so it is probed under
 * try/catch — then the entries iteration as the structural fallback.
 * `undefined` when the loader exposes neither face or the id is absent; the
 * mount hook FAILS CLOSED on that (an artifact whose settle cannot be
 * checked is never recorded `mounted`, P3-design §10-7).
 */
function findLoaderEntry(loader: LoaderLike, id: string): MountedEntry | undefined {
  if (typeof loader.resolve === 'function') {
    try { return loader.resolve(id) } catch { return undefined }
  }
  if (typeof loader.entries === 'function') {
    for (const entry of loader.entries()) if (entry.options.id === id) return entry
  }
  return undefined
}

/** Minimal structural view of one project plugin origin record. */
interface ProjectOriginLike {
  readonly manifestId: string
  readonly projectRoot: string
  readonly version: string
  /** Runtime tier projected by the project layer: 'in-process' or 'subprocess'. */
  readonly runtimeTier?: string
}

/** Preset names double as file stems; path separators and dots stay out. */
const PRESET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Durable approvals ledger format under the persistence data directory. */
interface PersistedApprovals {
  version: 1
  /** Plugin id to the epoch milliseconds of its recorded admission decision. */
  approvedAt: Record<string, number>
}

/** Durable preset file format under the persistence presets directory. */
interface PersistedPreset {
  version: 1
  savedAt: string
  entries: Array<{ pluginId: string; status: 'active' | 'disabled' }>
}

/** One registry-sourced install recorded in the installed-source ledger. */
interface PersistedNpmInstallSource {
  kind: 'npm'
  /** The exact `npm:` source string the operator installed from. */
  spec: string
  /** The registry version that was resolved and verified. */
  version: string
  installedAt: number
  /** Directory under the governance storage area holding the extracted files. */
  dir: string
}

/**
 * One factory-preinstalled `local:` artifact recorded in the origin
 * ledger (§1.3, the G2 schema increment). The artifact lives in the pnpm
 * workspace closure of `zdsh-factory-bundle`, never under the governance
 * storage area, so there is no `dir`: a later uninstall removes this row and
 * must never touch the node_modules tree (DESIGN-intake-tech.md §1.2).
 */
interface PersistedPreinstallSource {
  kind: 'preinstall'
  /** The seed entry's two-state `local:` source string, kept verbatim. */
  spec: string
  /** The seed-pinned version admitted this boot. */
  version: string
  installedAt: number
}

/** One origin row, discriminated by how the artifact reached the roster. */
type PersistedInstalledSource = PersistedNpmInstallSource | PersistedPreinstallSource

/** Durable installed-source ledger format under the persistence data directory. */
interface PersistedInstalledSources {
  version: 1
  sources: Record<string, PersistedInstalledSource>
}

/** Hard cap on one publish tarball; plugin packages are far smaller. */
const MAX_TARBALL_BYTES = 20 * 1024 * 1024

/** Deployment configuration of the governance service. */
export interface Config {
  /**
   * Persistence root for the registry snapshot, approvals ledger, presets,
   * and npm-installed plugin trees; defaults to the governance package's own
   * root (`~/.dsh-zdsh-go`, overridden by `DSH_BRANCH_HOME`, or derived as
   * `<DSH_HOME>/zdsh` when only `DSH_HOME` is set — see resolveBranchStorageRoot).
   */
  storageRoot?: string
  /**
   * HTTPS origin of the npm registry `npm:` install sources resolve against;
   * defaults to https://registry.npmjs.org. Mirrors behind a firewall point
   * this at their proxy — every request and redirect hop is pinned to this
   * single origin.
   */
  registryUrl?: string
  /**
   * Absolute path to the factory seed manifest (`zdsh-factory/seed.json`) the
   * preinstall pass consumes. When unset the executor falls back to the
   * `DSH_FACTORY_SEED` environment variable, then to the nearest ancestor of
   * this package holding `zdsh-factory/seed.json`. A seed file that is not
   * present makes the whole pass a no-op, so non-factory deployments and test
   * trees are never disturbed (DESIGN-intake-tech.md §1.2).
   */
  seedPath?: string
  /**
   * When the boot-time factory preinstall pass runs (SYNC-P3-CFIX).
   *
   * - `boot` — always fire the pass from service init. This is the installed
   *   deployment posture and the explicit opt-in tests that assert on the
   *   boot-fired pass itself use.
   * - `off` — never fire it from service init. The explicit
   *   {@link PluginGovernanceGateway.settlePreinstall} seam is untouched by
   *   every mode, so a pass can still be driven on demand.
   * - `auto` (default, also the value an unset field resolves to) — fire it
   *   only when this module executes from its built artifact. A src launch
   *   (`import.meta.url` ending in `.ts`) is a dev/test boot and skips the
   *   pass: pre-installing the factory seed set there mounts the prebuilt
   *   webstack lib, whose top-level bare `@deepseek-ai/dsh-tools` import is
   *   resolved natively (the importer sits inside node_modules, so tsx
   *   `paths` do not apply) onto `packages/core/tools/lib/index.js` — a second
   *   artifact-face instance of the tools face in a source-mode process, which
   *   the src-launch compat contract forbids (profile-resolution.ts:296-301).
   */
  factorySeeds?: FactorySeedsMode
  /**
   * Whether service init mounts the project-plugin layer (the NF4 wiring seam).
   *
   * Default `false`: a default deployment mounts no project plugins and the
   * `dsh.compatible` gate stays inert. Set `true` to gate plugins discovered
   * under the session project root through the host clamp + LoadGuard.preLoad
   * chain and classify them in the roster as `source: 'project'`.
   */
  projectPlugins?: boolean
}

/** The three {@link Config.factorySeeds} postures. */
export type FactorySeedsMode = 'auto' | 'boot' | 'off'

/** The posture an unset `factorySeeds` resolves to. */
const DEFAULT_FACTORY_SEEDS: FactorySeedsMode = 'auto'

/**
 * Whether the boot-time factory preinstall pass fires, given the configured
 * posture. `auto` defers to the runtime mode through the official `.ts`-suffix
 * probe (ptc-runtime-node/src/launch.ts:30, the directory-picker-auto idiom):
 * a source-mode module is a src launch, so the pass is skipped — see
 * {@link Config.factorySeeds} for why that matters to the src-launch contract.
 * @param mode - the configured posture, or undefined when unset.
 * @returns true when service init must fire the pass.
 */
function factorySeedsRunAtBoot(mode: FactorySeedsMode | undefined): boolean {
  const resolved = mode ?? DEFAULT_FACTORY_SEEDS
  if (resolved === 'boot') return true
  if (resolved === 'off') return false
  return !new URL(import.meta.url).pathname.endsWith('.ts')
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginGovernance: PluginGovernanceGateway
  }
}

/**
 * Frozen success branch of a {@link GovernanceResult}.
 * @param value - business payload carried on the wire.
 */
function succeeded<T>(value: T): GovernanceResult<T> {
  return Object.freeze({ ok: true, value }) as GovernanceResult<T>
}

/**
 * Frozen failure branch of a {@link GovernanceResult}.
 * @param code - stable machine-readable failure category.
 * @param message - correction-oriented message without sensitive values.
 */
function failed(code: GovernanceErrorCode, message: string): GovernanceResult<never> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) })
}

/**
 * The host governance service. It owns one {@link PluginRegistry} and one
 * {@link PluginPersistence} bound to this service fiber; status mutations are
 * snapshotted durably before their receipt is returned, so memory and disk
 * never disagree behind an acknowledged call.
 */
export class PluginGovernanceGateway extends TypertRemoteService {
  /** Loader validation for the persistence root override. */
  static Config: z<Config> = z.object({
    storageRoot: z.string(),
    registryUrl: z.string(),
    // New optional field, declared with schemastery's `.default` idiom (its
    // `Schema` has no `.optional`), matching the interface's optional `seedPath`
    // without "fixing" the pre-existing required-vs-optional drift on
    // storageRoot/registryUrl (out of scope, DESIGN-intake-tech.md §1.2). An
    // empty string means "not provided": the resolver then applies env / default.
    seedPath: z.string().default(''),
    // Same `.default` idiom as seedPath: schemastery's `Schema` has no
    // `.optional`, and an unset field resolves to `auto` on the code path too
    // (factorySeedsRunAtBoot), so the default here only documents the wire
    // shape rather than being the single source of the fallback.
    factorySeeds: z.union(['auto', 'boot', 'off']).default(DEFAULT_FACTORY_SEEDS),
    // Same `.default` idiom as the fields above: schemastery's `Schema` has no
    // `.optional`, and an unset field resolves to the inert posture on the code
    // path too, so the default documents the wire shape rather than being the
    // single source of the fallback.
    projectPlugins: z.boolean().default(false),
  })

  private readonly registry: PluginRegistry
  private readonly persistence: PluginPersistence
  /** Single HTTPS origin every `npm:` install request and redirect stays on. */
  private readonly registryOrigin: string
  /** Transport for registry interactions (injected in tests, fetch otherwise). */
  private readonly http: HttpLike
  private readonly approvals: Map<PluginGovernanceId, number> = new Map()
  /** Registry-sourced installs, so a later uninstall can remove their files. */
  private readonly installedSources = new Map<PluginGovernanceId, PersistedInstalledSource>()
  /**
   * Enable/disable decisions read once at construction from the registry.json
   * snapshot persistence.save writes, keyed canonically. Entries stay queued
   * here until their plugin actually registers, so restarts re-apply them
   * (R1-17) instead of letting every operator decision bounce back to the
   * default status.
   */
  private readonly persistedDecisions = new Map<PluginGovernanceId, 'active' | 'disabled'>()
  /** Canonical ids already mirrored from the Loader, so re-syncs stay idempotent. */
  private readonly mirrored = new Set<PluginGovernanceId>()
  /** Project plugin sources: canonical id → project root + runtime tier. */
  private readonly projectSources = new Map<PluginGovernanceId, { projectRoot: string; runtimeTier: string }>()
  /** In-flight Loader sync; concurrent triggers reuse one pass. */
  private syncing: Promise<void> | null = null
  /** Repository root the `local:` seed paths resolve against (§9.3). */
  private readonly repoRoot: string
  /** Factory seed preinstall executor (DESIGN-intake-tech.md §1.2). */
  private readonly preinstaller: SeedPreinstaller
  /** Whether service init fires the boot preinstall pass (SYNC-P3-CFIX gate). */
  private readonly preinstallAtBoot: boolean
  /** Whether service init mounts the project-plugin layer (NF4 wiring seam). */
  private readonly mountProjectPluginsAtBoot: boolean

  /**
   * @param ctx - owning Host context.
   * @param config - validated deployment configuration.
   * @param registry - registry backing this service; injection exists for
   * tests, the loader always receives the default in-memory implementation.
   * @param deps - injected transport for `npm:` installs (tests); production
   * uses global fetch pinned to the configured origin.
   */
  constructor(
    ctx: Context,
    config: Config = {},
    registry: PluginRegistry = new DefaultPluginRegistry(),
    deps: { http?: HttpLike } = {},
  ) {
    super(ctx, 'pluginGovernance')
    if (config.storageRoot !== undefined && config.storageRoot.trim().length === 0) {
      throw new TypeError('plugin-governance: storageRoot must not be blank when provided')
    }
    this.registryOrigin = config.registryUrl === undefined
      ? DEFAULT_REGISTRY_URL
      : registryOriginFromConfig(config.registryUrl)
    this.http = deps.http ?? ((globalThis as { fetch: HttpLike }).fetch)
    this.registry = registry
    this.persistence = new PluginPersistence(registry, {
      ...(config.storageRoot === undefined ? {} : { storageRoot: config.storageRoot }),
      autoSave: false,
    })
    // Wire the factory preinstall executor over this service's own admission
    // channel. Paths resolve once here: the seed comes from config / env /
    // repo-root default, and the durable result ledger shares the approvals /
    // installed-sources data directory (§1.4).
    const seedPath = resolveSeedPath(config.seedPath, process.env)
    this.repoRoot = deriveRepoRoot(seedPath)
    // Resolve the boot-pass posture once, at construction: it depends only on
    // config plus this module's own runtime mode, neither of which can change
    // for the lifetime of the service.
    this.preinstallAtBoot = factorySeedsRunAtBoot(config.factorySeeds)
    // Opt-in project-plugin mount (NF4): resolved once at construction, like the
    // preinstall posture above — config cannot change for the service lifetime.
    this.mountProjectPluginsAtBoot = config.projectPlugins === true
    this.preinstaller = new SeedPreinstaller({
      seedPath,
      resultsPath: join(this.persistence.dataDir, 'preinstall-results.json'),
      repoRoot: this.repoRoot,
      host: {
        now: () => Date.now(),
        warn: (message) => { this.warn(message) },
        isRegistered: id => this.registry.get(canonicalId(id)) !== null,
        // FB3 (TC-B4-H1 face 2): the seed rows install through the dedicated
        // seed-chain channel — admission trust from the seed/pin supply chain
        // (governance-side grant), never from the artifact's self-report.
        install: request => this.installFromSeedChain(request),
        setBootState: (id, enabled) => enabled
          ? this.enable({ pluginId: canonicalId(id) })
          : this.disable({
            pluginId: canonicalId(id),
            reason: 'factory preset: installed disabled by default (seed enabledAtBoot=false)',
          }),
        recordOrigin: (id, spec, version) => {
          const pluginId = canonicalId(id)
          // The npm: install channel already wrote this id's row (storage tree
          // included); a re-admit on a later boot re-runs the pass, so an
          // existing row is left untouched — installedAt stays the original.
          if (this.installedSources.has(pluginId)) return
          this.installedSources.set(pluginId, { kind: 'preinstall', spec, version, installedAt: Date.now() })
          this.saveInstalledSources()
        },
        // ── generic mount channel (§9.3) ─────────────────────────────────
        // Both hooks are pure data plumbing: paths come from the seed
        // read-back plus the ADMITTED artifact's own manifest, and the mount
        // body holds no plugin name and no per-id branch (M2). Fail-open on
        // a rejecting create is the executor's job (§9.4), so both sides
        // surface errors by throwing, never by swallowing them here.
        resolveFactoryUrls: id => this.factoryModuleUrls(canonicalId(id)),
        mount: async (pluginId, moduleUrl, enabled) => {
          const loader = this.resolveMountLoader()
          if (loader === undefined) throw new Error('no Loader service with a create channel is mounted on this context')
          const entryId = `factory/${canonicalId(pluginId)}`
          // 0.1.7 Loader contract (SYNC-P3): create resolves once the entry's
          // fiber exists — import failures are logged-and-dropped (fiber stays
          // undefined) and apply failures settle on the fiber; neither rejects
          // create any more (only a synchronous `invalid plugin` still does).
          // §9.3/§9.4 keep "mount throws ⟺ the artifact failed", so the hook
          // re-captures both classes at the official seam (the
          // directory-picker-auto idiom: create → fiber check → fiber.await).
          try {
            await loader.create({ name: moduleUrl, id: entryId, disabled: !enabled })
            if (!enabled) return // admitted-but-disabled posture: no fiber expected
            const entry = findLoaderEntry(loader, entryId)
            if (entry === undefined || entry.fiber === undefined) {
              throw new Error(`the Loader dropped the import of ${moduleUrl} (import error logged on the host side)`)
            }
            await entry.fiber.await() // rejects with the start failure (fiber.ts:704-710)
          } catch (cause) {
            // Failed mounts leave no live entry: 0.1.5 net-state parity (the
            // Loader's own rollback was removed upstream) + the official
            // unmount idiom; a retry (next boot / next url) starts from a
            // clean tree. Best-effort: a compensation fault must not mask the
            // original failure.
            try { loader.remove?.(entryId) } catch { /* best-effort */ }
            throw cause
          }
        },
      },
    })
    // Read the persisted decision snapshot up front (R1-17): every sync pass
    // re-applies it to matching plugins once they register, whether they were
    // injected directly or arrive later through the Loader mirror.
    this.loadPersistedDecisions()
  }

  /** Create storage dirs and run the initial Loader mirror synchronously so the roster holds real data before any Remote read. */
  protected async [Service.init](): Promise<void> {
    this.persistence.ensureDirectories()
    this.loadApprovals()
    this.loadInstalledSources()
    // P2 (TEST-b0-baseline §3-A): re-register storage-only installs from the
    // installed-source ledger BEFORE the Loader mirror, so `uninstall`/`get` reach
    // them again after a restart and `restorePersistedDecisions` (the tail of
    // the sync below) re-applies their operator enable/disable decisions.
    await this.rebuildInstalledRoster()
    // Await the first mirror pass (L2: no async micro-window between service
    // ready and populated roster). Subsequent syncs remain lazy via list().
    await this.syncMountedPlugins()
    // NF4: mount the project-plugin layer so a project-root plugin is gated by
    // the host clamp + LoadGuard.preLoad chain and classified as source=project.
    // Opt-in (Config.projectPlugins); the inert posture is a no-op.
    if (this.mountProjectPluginsAtBoot) {
      await mountProjectPluginsOnHost(this.ctx, true)
    }
    // Fire-and-forget the factory preinstall pass so a broken or absent seed
    // never delays or aborts boot (R-1.1.4); tests await the settle seam.
    // SYNC-P3-CFIX: gated by `factorySeeds` — a src launch skips it under the
    // default `auto` posture (see Config.factorySeeds for the compat reason);
    // `settlePreinstall()` below stays an unconditional explicit seam in every
    // posture, so a pass is always drivable on demand.
    if (this.preinstallAtBoot) void this.preinstaller.runPass()
    this.ctx.effect(() => () => {
      void this.registry.dispose()
    }, 'plugin-governance.registryDispose')
  }

  /**
   * List every registered plugin with its live status and admission state.
   * @returns the point-in-time roster in registration order.
   */
  @Remote('list')
  list(): GovernanceRosterSnapshot {
    // Late-mounting Loader entries land between polls; each roster read gives
    // the mirror one chance to pick them up without making the read async.
    void this.syncMountedPlugins()
    return Object.freeze({
      plugins: Object.freeze(this.registry.getAll().map(plugin => this.summaryOf(plugin))),
    })
  }

  /**
   * Project one registered plugin in full for inspection surfaces.
   * @param request - the plugin to project.
   * @returns the detail, or `plugin-not-found`.
   */
  @Remote('get')
  get(request: PluginIdRequest): GovernanceResult<GovernedPluginDetail> {
    const known = this.requirePlugin(request.pluginId)
    if (!known.ok) return known
    const [, plugin] = known.value
    const manifest = plugin.manifest
    const capabilities: GovernedCapabilityView[] = manifest.capabilities.map(capability => Object.freeze({
      type: capability.type,
      name: capability.tool?.name ?? capability.hook?.name ?? capability.service?.name
        ?? capability.event?.name ?? capability.uiSlot?.name ?? capability.llmAdapter?.name
        ?? capability.type,
    }))
    // Report rows are keyed by the raw manifest id, exactly as the registry's
    // own report builds them; look them up on that same key.
    const errors = this.registry.getHealthReport().plugins
      .find(row => row.id === manifest.id)?.errors ?? []
    const project = this.projectSources.get(canonicalId(manifest.id))
    return succeeded(Object.freeze({
      summary: this.summaryOf(plugin),
      description: manifest.description ?? null,
      author: manifest.author ?? null,
      certification: manifest.certification?.level ?? null,
      permissionLevel: manifest.permissionLevel ?? null,
      capabilities: Object.freeze(capabilities),
      sandbox: Object.freeze({
        type: manifest.sandbox.type,
        filesystemAccess: manifest.sandbox.filesystem.access,
        networkAccess: manifest.sandbox.network.access,
        maySpawnProcesses: manifest.sandbox.process.spawn || manifest.sandbox.process.exec,
        // Project plugins carry their actual runtime tier so the UI never
        // mistakes the M2a in-process runtime for an OS boundary.
        ...(project !== undefined ? { runtimeTier: project.runtimeTier } : {}),
      }),
      errors: Object.freeze(errors),
    }))
  }

  /**
   * Install a plugin from a local directory or an npm registry source (L3
   * admission pipeline). Local sources must be existing directories with a
   * readable `package.json`; `npm:<name>[@<exact-version>]` sources are
   * resolved against the configured registry, integrity-checked, and
   * extracted into the governance storage area before the same manifest
   * construction runs over them. The constructed manifest is admitted
   * through the governance registry and the roster snapshot persists before
   * the receipt returns.
   *
   * Fail closed: a manifest whose permission posture requests an admission
   * decision (`requiresAdmission`) registers **disabled** unless the approvals
   * ledger already holds a decision, so installed code never runs before the
   * operator approves it; `approve` + `enable` then activate it.
   * @param request - local source directory or `npm:` spec of the plugin.
   * @returns a receipt, or `request-invalid` / `registry-unavailable` /
   * `persistence-failed`.
   */
  @Remote('install')
  async install(request: InstallPluginRequest): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    if (request.source.startsWith('npm:')) return this.installFromNpm(request.source)
    return this.admitManifest(manifestFromLocalSource(request.source))
  }

  /**
   * Shared admission tail for both install sources: duplicate check, registry
   * registration, server-side fail-closed gate, durable snapshot — plus, for
   * registry installs, the installed-source ledger entry that lets a later
   * uninstall remove the extracted tree. `seedChain` marks the factory
   * preinstall channel (FB3): its admission trust is the seed/pin supply
   * chain itself — a governance-side decision recorded as an approvals-ledger
   * grant — instead of the clamped package self-report.
   */
  private async admitManifest(
    manifest: GovernanceResult<GovernedManifest>,
    origin?: PersistedInstalledSource,
    seedChain = false,
  ): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    if (!manifest.ok) return manifest
    const pluginId = canonicalId(manifest.value.id)
    if (this.registry.get(pluginId) !== null) {
      return failed(
        'request-invalid',
        `plugin ${JSON.stringify(String(pluginId))} is already registered; uninstall it first`,
      )
    }
    const plugin: GovernedPlugin = {
      manifest: manifest.value,
      install: () => {},
      uninstall: () => {},
    }
    const registration = await this.registry.register(plugin)
    if (!registration.success) {
      const reasons = (registration.errors ?? []).map(error => `${error.path}: ${error.message}`).join('; ')
      return failed('request-invalid', `the manifest built from package.json was rejected: ${reasons || 'unknown validation failure'}`)
    }
    // Fail-closed admission gate (server-side, mirroring the `enable` remote):
    // registered but disabled until an approval decision exists. Seed-chain
    // exception (FB3): the grant is recorded here — the seed/pin chain IS the
    // governance-side admission decision for factory rows, durably queryable
    // in the approvals ledger; operator installs stay disabled until
    // `approve` records the operator's own decision.
    let seedAdmissionGranted = false
    if (requiresAdmission(plugin) && !this.approvals.has(pluginId)) {
      if (seedChain) {
        this.approvals.set(pluginId, Date.now())
        seedAdmissionGranted = true
      } else {
        await this.registry.disable(pluginId, 'installed without a recorded admission decision')
      }
    }
    // TC-B3-MM1b (restart boot-posture drift): replay a persisted `disabled`
    // decision INSIDE this admission, before the snapshot save below. The
    // factory preinstall pass re-admits each `local:` artifact in every fresh
    // process, and it runs AFTER the init sync's restorePersistedDecisions
    // tail — which then finds the id unregistered and merely keeps the
    // decision queued, while this admission lands the registry default
    // ACTIVE. Without this replay, the `persistence.save()` tail of the same
    // call silently overwrites the first boot's factory-off row back to
    // 'active': the seed's `enabledAtBoot: false` posture survives boot 1 in
    // memory only, and the drift goes permanent from the next boot onward.
    // Disable-only, mirroring restorePersistedDecisions' discipline: a queued
    // 'active' (an operator who enabled a seed-false row) keeps the fresh
    // ACTIVE admission untouched — operator decisions outrank the seed. The
    // decision stays queued so a later lazy sync sweep still consumes it
    // idempotently (the DISABLED-status check makes the replay a no-op).
    // Fail-soft like the restore tail: a throwing disable warns and leaves
    // the admission standing, never aborts an install that already landed.
    if (this.persistedDecisions.get(pluginId) === 'disabled') {
      try {
        if (this.registry.getStatus(pluginId) !== PluginStatus.DISABLED) {
          await this.registry.disable(pluginId, 'persisted disabled decision re-applied at admission')
        }
      } catch (cause) {
        this.warn(`failed to re-apply persisted disabled state at admission for ${String(pluginId)}: ${describe(cause)}`)
      }
    }
    if (origin !== undefined) this.installedSources.set(pluginId, origin)
    try {
      // Ledger first: if the registry snapshot then fails, compensation drops
      // the ledger entry (a stale ledger row for an unregistered id is inert —
      // the next install overwrites it), whereas the reverse order could leave
      // the snapshot advertising a plugin this process no longer has in memory.
      if (origin !== undefined) this.saveInstalledSources()
      if (seedAdmissionGranted) this.saveApprovals()
      this.persistence.save()
    } catch (cause) {
      // Compensate so memory and disk never disagree behind a failed call.
      await this.registry.unregister(pluginId)
      if (origin !== undefined) this.installedSources.delete(pluginId)
      if (seedAdmissionGranted) this.approvals.delete(pluginId)
      return failed('persistence-failed', `the registry snapshot could not be written: ${describe(cause)}`)
    }
    return succeeded(Object.freeze({ acknowledged: true }))
  }

  /** Resolve, verify, extract, and admit one `npm:` install source. `seedChain`
   * marks the factory preinstall channel (FB3 seed-chain admission grant);
   * `expectedIntegrity` (FB6, seed rows only) is the seed's own sha512 pin —
   * an INDEPENDENT second verification basis the downloaded tarball must also
   * satisfy (the registry-declared digest alone is a same-channel
   * self-attestation inside the npm trust model). */
  private async installFromNpm(
    source: string,
    seedChain = false,
    expectedIntegrity?: string,
  ): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    const spec: NpmSpec | null = parseNpmSpec(source)
    if (spec === null) {
      return failed(
        'request-invalid',
        'npm install sources take the form npm:<name>[@<exact-version>]; version ranges are not accepted',
      )
    }
    // Cheap pre-check so an already-registered id never triggers a download.
    const expectedId = canonicalId(normalizePluginId(spec.name))
    if (this.registry.get(expectedId) !== null) {
      return failed(
        'request-invalid',
        `plugin ${JSON.stringify(String(expectedId))} is already registered; uninstall it first`,
      )
    }
    let tarball: Buffer
    let resolvedVersion: string
    try {
      const resolved = await resolveRegistryVersion(this.registryOrigin, spec, this.http)
      resolvedVersion = resolved.version
      tarball = await downloadVerifiedTarball(this.registryOrigin, resolved, MAX_TARBALL_BYTES, this.http)
    } catch (cause) {
      if (cause instanceof NpmSourceError && cause.kind === 'invalid') return failed('request-invalid', cause.message)
      if (cause instanceof NpmSourceError && cause.kind === 'not-found') return failed('request-invalid', cause.message)
      return failed('registry-unavailable', cause instanceof Error ? cause.message : describe(cause))
    }
    // FB6 (TC-B4-H1 face 5): the seed pin is an independent verification
    // basis — the bytes must satisfy BOTH digests or the row is never
    // admitted. Compared before extraction, so a rejected tarball never
    // touches the storage area.
    if (expectedIntegrity !== undefined && !matchesSha512Integrity(tarball, expectedIntegrity)) {
      return failed(
        'request-invalid',
        'the downloaded tarball does not match the seed-pinned sha512 integrity value (the registry served different bytes than the seed pins)',
      )
    }
    const destination = this.npmInstallDir(expectedId)
    try {
      rmSync(destination, { recursive: true, force: true })
      extractNpmPackageTarball(tarball, destination)
    } catch (cause) {
      rmSync(destination, { recursive: true, force: true })
      if (cause instanceof TarExtractionError) {
        return failed('request-invalid', ['the publish tarball was rejected:', cause.message].join(' '))
      }
      return failed('persistence-failed', `the extracted package could not be written: ${describe(cause)}`)
    }
    const manifest = manifestFromLocalSource(destination)
    if (!manifest.ok) {
      rmSync(destination, { recursive: true, force: true })
      return manifest
    }
    if (canonicalId(manifest.value.id) !== expectedId) {
      rmSync(destination, { recursive: true, force: true })
      return failed('request-invalid', 'the extracted package.json declares a different plugin id than the requested package name')
    }
    return this.admitManifest(manifest, {
      kind: 'npm',
      spec: source,
      version: resolvedVersion,
      installedAt: Date.now(),
      dir: destination,
    }, seedChain)
  }

  /**
   * Seed-chain install channel (FB3, TC-B4-H1 face 2): the preinstaller's
   * dedicated wiring. Admission trust for these installs is the seed/pin
   * supply chain — a governance-side decision recorded as an approvals-ledger
   * grant inside admitManifest — never the artifact's own package.json, whose
   * self-reported trust fields are clamped at manifest construction. The
   * public `install` @Remote contract is untouched: operator installs still
   * land disabled until `approve` records the operator's decision.
   */
  private async installFromSeedChain(
    request: { source: string; expectedIntegrity?: string },
  ): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    if (request.source.startsWith('npm:')) return this.installFromNpm(request.source, true, request.expectedIntegrity)
    return this.admitManifest(manifestFromLocalSource(request.source), undefined, true)
  }

  /**
   * Uninstall a plugin: unregister it from the governance registry, purge its
   * durable admission state (approvals-ledger entry and queued persisted
   * decision — a later reinstall fails closed instead of inheriting stale
   * grants), and snapshot the registry before the receipt returns. Entries
   * mirrored from the Cordis Loader reappear on the next sync while their
   * module stays mounted in the loader configuration.
   * @param request - the plugin to remove.
   * @returns a receipt, or `plugin-not-found` / `persistence-failed`.
   */
  @Remote('uninstall')
  async uninstall(request: PluginIdRequest): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    const pluginId = canonicalId(request.pluginId)
    const plugin = this.registry.get(pluginId)
    if (plugin === null) {
      return failed('plugin-not-found', noSuchPlugin(pluginId))
    }
    const previousStatus = this.registry.getStatus(pluginId)
    const previousApproval = this.approvals.get(pluginId)
    const previousDecision = this.persistedDecisions.get(pluginId)
    // P-9b (DESIGN-intake-tech.md §1.2 [P-9b 附裁], TC-B1-P9 fix6): whether the
    // `userUninstalled` tombstone is a load-bearing durable contract for THIS
    // plugin. Its only consumer is the seed preinstall pass, and only a
    // `origin=preinstall` row can ever be resurrected by a later pass;
    // every other origin (a user-installed `npm:` artifact, a storage or
    // loader rebuild) has no pass-resurrectable row, so its tombstone write is
    // best-effort and must never fail the uninstall the operator asked for.
    const tombstoneIsLoadBearing = this.installedSources.get(pluginId)?.kind === 'preinstall'
    await this.registry.unregister(pluginId)
    this.approvals.delete(pluginId)
    this.persistedDecisions.delete(pluginId)
    try {
      if (previousApproval !== undefined) this.saveApprovals()
      this.persistence.save()
      // S1 (EXEC7 建议①): for a load-bearing (preinstall) row the durable
      // `userUninstalled` tombstone is written BEFORE the storage-area tree
      // removal, inside the same durable block — if it cannot be committed,
      // the compensation below restores the pre-call registry state and the
      // receipt fails, so an acknowledged uninstall can never be missing the
      // guard that stops resurrection. (The old order wrote the tombstone
      // after everything, best-effort: a lock-timeout or disk error there
      // produced "uninstall OK + no tombstone", which the next preinstall pass
      // would resurrect.) P-9b keeps that fatal path exactly for preinstall
      // rows; for a non-preinstall row the same write failure falls back to
      // non-fatal + warn — an availability-critical user operation is not
      // gated on a durability write nothing on that path ever reads back.
      if (tombstoneIsLoadBearing) {
        await this.preinstaller.recordUninstall(String(pluginId))
      } else {
        try {
          await this.preinstaller.recordUninstall(String(pluginId))
        } catch (cause) {
          this.warn(`failed to record the uninstall tombstone of ${String(pluginId)}: ${describe(cause)} (non-preinstall origin: no preinstall-pass row exists to resurrect this plugin, so the uninstall is not rolled back)`)
        }
      }
    } catch (cause) {
      // Compensate both maps and the registry, restoring the pre-call status.
      restoreMapEntry(this.approvals, pluginId, previousApproval)
      restoreMapEntry(this.persistedDecisions, pluginId, previousDecision)
      await this.registry.register({ ...plugin })
      if (previousStatus === PluginStatus.DISABLED) await this.registry.disable(pluginId)
      return failed('persistence-failed', `the uninstall could not be committed durably: ${describe(cause)}`)
    }
    // Registry installs leave an extracted tree under the storage area; its
    // removal is hygiene rather than admission state, so a failure here is
    // logged and the ledger entry restored instead of failing the receipt —
    // the plugin is unregistered either way and a reinstall overwrites the
    // stale directory. Preinstall rows (§1.3) carry **no** dir by design:
    // their artifact lives in the pnpm-managed node_modules closure, which
    // governance must never delete — the row itself is all there is to drop.
    const installed = this.installedSources.get(pluginId)
    if (installed !== undefined) {
      this.installedSources.delete(pluginId)
      try {
        if (installed.kind === 'npm') {
          // Defense in depth against a tampered ledger: only remove trees that
          // still live inside the governance storage area.
          const storageRoot = resolve(this.persistence.storagePath)
          if (!resolve(installed.dir).startsWith(storageRoot + sep)) {
            throw new Error('recorded install directory is outside the governance storage area')
          }
          rmSync(installed.dir, { recursive: true, force: true })
        }
        this.saveInstalledSources()
      } catch (cause) {
        restoreMapEntry(this.installedSources, pluginId, installed)
        this.warn(['failed to remove the installed files of', String(pluginId) + ':', describe(cause)].join(' '))
      }
    }
    return succeeded(Object.freeze({ acknowledged: true }))
  }

  /**
   * Re-enable a previously disabled plugin and snapshot the registry. Plugins
   * whose manifest requests an admission decision stay disabled until
   * `approve` records one — the gate is enforced here on the server, not just
   * in client UI.
   * @param request - the plugin to enable.
   * @returns a receipt, or `plugin-not-found` / `approval-required` /
   * `persistence-failed`.
   */
  @Remote('enable')
  async enable(request: PluginIdRequest): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    const known = this.requirePlugin(request.pluginId)
    if (!known.ok) return known
    const [pluginId, plugin] = known.value
    if (requiresAdmission(plugin) && !this.approvals.has(pluginId)) {
      return failed(
        'approval-required',
        `plugin ${JSON.stringify(String(pluginId))} requires an admission decision (approve) before it can be enabled`,
      )
    }
    await this.registry.enable(pluginId)
    return this.persistRegistryChange(() => {
      void this.registry.disable(pluginId)
    })
  }

  /**
   * Disable a plugin and snapshot the registry. An optional reason enters the
   * registry's own per-plugin record until the next enable re-enables it.
   * @param request - the plugin to disable, with an optional reason.
   * @returns a receipt, or `plugin-not-found` / `persistence-failed`.
   */
  @Remote('disable')
  async disable(request: DisablePluginRequest): Promise<GovernanceResult<GovernanceAcknowledgement>> {
    const pluginId = canonicalId(request.pluginId)
    if (this.registry.get(pluginId) === null) {
      return failed('plugin-not-found', noSuchPlugin(pluginId))
    }
    await this.registry.disable(pluginId, request.reason ?? undefined)
    return this.persistRegistryChange(() => {
      void this.registry.enable(pluginId)
    })
  }

  /**
   * Report aggregate and per-plugin health, including each plugin's own probe
   * verdict when it declares one.
   * @returns the aggregated report over the current roster.
   */
  @Remote('health')
  health(): GovernanceHealthReport {
    void this.syncMountedPlugins()
    const report = this.registry.getHealthReport()
    const plugins: GovernedPluginHealthEntry[] = this.registry.getAll().map((plugin) => {
      const pluginId = canonicalId(plugin.manifest.id)
      return {
        pluginId,
        displayName: plugin.manifest.name,
        status: STATUS_NAMES[this.registry.getStatus(pluginId)],
        healthy: this.probeVerdict(pluginId),
        errors: Object.freeze(this.reportErrors(plugin)),
        warnings: Object.freeze(this.registry.getPluginWarnings(pluginId) ?? []),
      }
    })
    return Object.freeze({
      total: report.total,
      active: report.active,
      warnings: report.warnings,
      errors: report.errors,
      disabled: report.disabled,
      plugins: Object.freeze(plugins),
    })
  }

  /**
   * Record the operator's admission decision for a plugin whose manifest
   * requests confirmation. The decision survives restarts in the approvals
   * ledger and is reported by `list` and `get`.
   * @param request - the plugin to approve.
   * @returns a receipt, or `plugin-not-found` / `persistence-failed`.
   */
  @Remote('approve')
  approve(request: PluginIdRequest): GovernanceResult<GovernanceAcknowledgement> {
    const pluginId = canonicalId(request.pluginId)
    if (this.registry.get(pluginId) === null) {
      return failed('plugin-not-found', noSuchPlugin(pluginId))
    }
    const previous = this.approvals.get(pluginId)
    this.approvals.set(pluginId, Date.now())
    try {
      this.saveApprovals()
    } catch (cause) {
      restoreMapEntry(this.approvals, pluginId, previous)
      return failed('persistence-failed', `the approvals ledger could not be written: ${describe(cause)}`)
    }
    return succeeded(Object.freeze({ acknowledged: true }))
  }

  /**
   * Snapshot which plugins are currently enabled or disabled under a preset
   * name. Statuses other than active/disabled are runtime facts rather than
   * operator decisions and stay out of presets.
   * @param request - name of the preset to write.
   * @returns a receipt, or `preset-already-exists` / `request-invalid` /
   * `persistence-failed`.
   */
  @Remote('presetSave')
  presetSave(request: PresetNameRequest): GovernanceResult<GovernanceAcknowledgement> {
    const nameError = checkPresetName(request.name)
    if (nameError !== null) return failed('request-invalid', nameError)
    const path = this.presetPath(request.name)
    if (existsSync(path)) {
      return failed('preset-already-exists', `preset ${JSON.stringify(request.name)} already exists`)
    }
    const entries: PersistedPreset['entries'] = []
    for (const plugin of this.registry.getAll()) {
      const status = this.registry.getStatus(canonicalId(plugin.manifest.id))
      if (status === PluginStatus.ACTIVE || status === PluginStatus.DISABLED) {
        entries.push({
          pluginId: String(canonicalId(plugin.manifest.id)),
          status: status === PluginStatus.DISABLED ? 'disabled' : 'active',
        })
      }
    }
    try {
      writePreset(path, { version: 1, savedAt: new Date().toISOString(), entries })
    } catch (cause) {
      return failed('persistence-failed', `preset ${JSON.stringify(request.name)} could not be written: ${describe(cause)}`)
    }
    return succeeded(Object.freeze({ acknowledged: true }))
  }

  /**
   * Apply a stored preset: re-enable or disable each listed plugin against
   * the live registry. Entries naming unknown plugins are reported untouched.
   * @param request - name of the preset to apply.
   * @returns applied and unknown ids, or `preset-not-found` /
   * `request-invalid` / `persistence-failed`.
   */
  @Remote('presetLoad')
  async presetLoad(request: PresetNameRequest): Promise<GovernanceResult<PresetApplicationReport>> {
    const nameError = checkPresetName(request.name)
    if (nameError !== null) return failed('request-invalid', nameError)
    const path = this.presetPath(request.name)
    if (!existsSync(path)) {
      return failed('preset-not-found', `no preset named ${JSON.stringify(request.name)}`)
    }
    let preset: PersistedPreset
    try {
      preset = readPreset(path)
    } catch (cause) {
      return failed('persistence-failed', `preset ${JSON.stringify(request.name)} could not be read: ${describe(cause)}`)
    }
    const applied: PluginGovernanceId[] = []
    const unknown: PluginGovernanceId[] = []
    /** Previous disabled state per touched id, so IO failure can restore it. */
    const previousDisabled = new Map<PluginGovernanceId, boolean>()
    for (const entry of preset.entries) {
      const pluginId = canonicalId(entry.pluginId)
      const plugin = this.registry.get(pluginId)
      if (plugin === null) {
        unknown.push(pluginId)
        continue
      }
      // FB4 (TC-B4-H1 face 3, D1b §3-FB4): an `active` row re-checks the same
      // server-side admission gate `enable` enforces — the preset file is
      // storage-area input, not an approval decision, so an admission-
      // required plugin without a recorded decision is left untouched and
      // reported in the `unknown` column ("not applied"), never silently
      // enabled. `disabled` rows take no gate: disabling is always safe
      // (disable-only discipline, symmetric with the MM1b replay — the two
      // gates never fight over the same row).
      if (entry.status !== 'disabled' && requiresAdmission(plugin) && !this.approvals.has(pluginId)) {
        unknown.push(pluginId)
        continue
      }
      previousDisabled.set(
        pluginId,
        this.registry.getStatus(pluginId) === PluginStatus.DISABLED,
      )
      if (entry.status === 'disabled') await this.registry.disable(pluginId)
      else await this.registry.enable(pluginId)
      applied.push(pluginId)
    }
    // The applied statuses are durable facts like every other mutation: a
    // failed snapshot rolls the live registry back before the failure is
    // reported, so memory and disk never disagree behind an acknowledged call.
    try {
      this.persistence.save()
    } catch (cause) {
      for (const [pluginId, wasDisabled] of [...previousDisabled].reverse()) {
        if (wasDisabled) await this.registry.disable(pluginId)
        else await this.registry.enable(pluginId)
      }
      return failed('persistence-failed', `the registry snapshot could not be written: ${describe(cause)}`)
    }
    return succeeded(Object.freeze({
      applied: Object.freeze(applied),
      unknown: Object.freeze(unknown),
    }))
  }

  /**
   * Delete one stored preset. The live registry is untouched.
   * @param request - name of the preset to delete.
   * @returns a receipt, or `preset-not-found` / `request-invalid` /
   * `persistence-failed`.
   */
  @Remote('presetDelete')
  presetDelete(request: PresetNameRequest): GovernanceResult<GovernanceAcknowledgement> {
    const nameError = checkPresetName(request.name)
    if (nameError !== null) return failed('request-invalid', nameError)
    const path = this.presetPath(request.name)
    if (!existsSync(path)) {
      return failed('preset-not-found', `no preset named ${JSON.stringify(request.name)}`)
    }
    try {
      rmSync(path, { force: false })
    } catch (cause) {
      return failed('persistence-failed', `preset ${JSON.stringify(request.name)} could not be deleted: ${describe(cause)}`)
    }
    return succeeded(Object.freeze({ acknowledged: true }))
  }

  /**
   * Read the durable factory preinstall result ledger (§1.4): one row per seed
   * entry recording whether it installed, was skipped, or failed, plus the
   * `userUninstalled` tombstone. The plugin-center discovery-install hub
   * consumes this alongside the catalog. A read-only, synchronous projection
   * of the on-disk ledger — it triggers no install work and never fails; an
   * absent ledger reports an empty result set.
   * @returns the point-in-time preinstall report.
   */
  @Remote('preinstallReport')
  preinstallReport(): PreinstallReport {
    return this.preinstaller.report()
  }

  /**
   * Await the in-flight or last factory preinstall pass to settle. Test seam
   * mirroring {@link syncMountedPlugins}: boot calls the pass fire-and-forget,
   * so a caller that needs the durable outcome calls this to join it. When the
   * boot pass was gated off (`factorySeeds`, SYNC-P3-CFIX) nothing is in flight
   * and this seam runs the pass itself — the awaited outcome is one complete
   * pass either way.
   * @returns when the current pass has committed or decided to write nothing.
   */
  settlePreinstall(): Promise<void> {
    return this.preinstaller.runPass()
  }

  /**
   * Mirror the Cordis Loader's currently mounted plugin entries into the
   * governed registry, so the roster and the plugin-manager UI report real
   * production data instead of an empty list. Each entry is wrapped through
   * the governance Cordis adapter in mirror mode: lifecycle stays owned by
   * Cordis, and the operator's mount decision in the loader configuration
   * counts as the admission decision. One entry failing to wrap or register
   * never blocks the rest; already-mirrored ids are skipped on re-runs.
   *
   * Runs once at service init and is re-triggered by every `list`/`health`
   * read so entries mounted after this service can still appear.
   * @returns when one full sync pass has settled (also a test seam).
   */
  async syncMountedPlugins(): Promise<void> {
    if (this.syncing !== null) return this.syncing
    this.syncing = this.runSyncPass().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  /** One fail-soft pass over the Loader's active entries. */
  private async runSyncPass(): Promise<void> {
    const loader = this.resolveLoader()
    try {
      if (loader !== undefined) {
        for (const entry of loader.entries()) {
          try {
            if (entry.options.group || entry.disabled) continue
            // Mount-channel rows (§9.3): the artifact behind a `factory/`
            // entry was admitted and registered through the install channel
            // already, and its options.name is a file URL — mirroring it
            // would re-register the same code under a URL-derived id. Skip
            // the channel's namespace prefix: a generic convention, no
            // plugin knowledge in this body (M2).
            if (entry.options.id.startsWith('factory/')) continue
            const fiber = entry.fiber
            if (fiber === undefined || fiber.state !== FIBER_ACTIVE) continue
            const service = resolveMountedService(fiber)
            // Entries that provide no object-valued service (plain function or
            // config-only plugins) have no instance to govern; skip them.
            if (service === undefined) continue
            // Project plugin branch: the entry carries a origin record from
            // the project plugin layer, so it is wrapped as a PROJECT source —
            // explicit id = manifest id, clamped manifest, no OFFICIAL badge,
            // no autoApprove. The origin table is written at mount time,
            // which always precedes this first sync pass (no race window).
            const origin = this.projectOriginOf(entry.options.id)
            if (origin !== undefined) {
              await this.registerProjectEntry(entry.options.id, origin, service)
              continue
            }
            const pluginId = canonicalId(entry.options.name)
            if (this.mirrored.has(pluginId)) continue
            if (this.registry.get(pluginId) !== null) {
              // Registered by another path (e.g. a test-injected registry): still
              // roster data, and re-registering would only fail as a duplicate.
              this.mirrored.add(pluginId)
              continue
            }
            const result = await this.registry.register(wrapCordisPlugin(
              service as CordisService,
              mirrorPluginContext(String(pluginId), this.ctx.logger),
              { id: String(pluginId), name: mountedDisplayName(entry.options.name), mirror: true },
            ))
            this.mirrored.add(pluginId)
            if (!result.success) {
              this.warn(`failed to register loader entry ${entry.options.name}: ${(result.errors ?? []).map(error => error.message).join('; ')}`)
            }
          } catch (cause) {
            // Fail soft: one broken entry must not blank out the rest of the roster.
            this.warn(`failed to mirror loader entry ${entry.options.name}: ${describe(cause)}`)
          }
        }
      }
    } catch (cause) {
      // Fail soft: the enumeration itself (entries() or a mid-pass next())
      // throwing must not abort the pass or its persisted-decision sweep.
      this.warn(`failed to enumerate loader entries: ${describe(cause)}`)
    }
    // Subprocess project plugins (M2b): these entries have NO loader row —
    // their tools are host-side proxies registered during mount — so they are
    // enumerated separately from the project layer's subprocess entry id set.
    try {
      const subprocessIds = this.projectLayer()?.subprocessEntryIds?.() ?? []
      for (const entryId of subprocessIds) {
        const origin = this.projectOriginOf(entryId)
        if (origin !== undefined) {
          await this.registerProjectEntry(entryId, origin)
        }
      }
    } catch (cause) {
      this.warn(`failed to enumerate subprocess project entries: ${describe(cause)}`)
    }
    // Every pass ends by re-applying persisted decisions, so entries that just
    // registered through the Loader above come back with their operator
    // decisions instead of a fresh default status.
    await this.restorePersistedDecisions()
  }

  /** The Loader service when one is present on this context, else `undefined`. */
  private resolveLoader(): (LoaderLike & { entries: () => Iterable<MountedEntry> }) | undefined {
    // Context property access resolves through the reflection layer and THROWS
    // for names nothing provides, so contexts without a Loader must be probed,
    // not read directly. The untrusted-face cast keeps presence probing honest:
    // the declared context face may claim a Loader the runtime never mounted.
    try {
      const candidate = (this.ctx as unknown as Partial<Record<'loader', LoaderLike>>).loader
      if (candidate === undefined) return undefined
      const entries = candidate.entries
      if (typeof entries !== 'function') return undefined
      return candidate as LoaderLike & { entries: () => Iterable<MountedEntry> }
    } catch {
      return undefined
    }
  }

  /**
   * The Loader's create face when one is present on this context, else
   * `undefined` (§9.3). Probed separately from {@link resolveLoader} because
   * the mount channel needs only `create`, and the fake Loader doubles of
   * unit tests may legitimately expose one face without the other. Same
   * reflection-throw discipline as the entries probe.
   */
  private resolveMountLoader(): (LoaderLike & { create: NonNullable<LoaderLike['create']> }) | undefined {
    try {
      const candidate = (this.ctx as unknown as Partial<Record<'loader', LoaderLike>>).loader
      if (candidate === undefined) return undefined
      const create = candidate.create
      if (typeof create !== 'function') return undefined
      return candidate as LoaderLike & { create: NonNullable<LoaderLike['create']> }
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the factory exits of one admitted artifact as file URLs over
   * its installed directory (§9.3/M-F4/M-F5 — the gate-p P4 algorithm as
   * production code): the paths come from the artifact's OWN admitted
   * manifest (`dsh.capabilities[].service.factory`), never from a lookup
   * table keyed by plugin. `[]` when nothing is loadable: an unregistered
   * id, a manifest without a service factory, or a origin row that
   * names no source directory. An escaping factory value (the manifest is
   * an untrusted artifact declaration, F7 third point / D1b §4.1) throws
   * with a queryable reason — the executor's per-item fail-open settles it
   * as a `failed` mount row, siblings untouched.
   */
  private factoryModuleUrls(pluginId: PluginGovernanceId): string[] {
    const plugin = this.registry.get(pluginId)
    if (plugin === null) return []
    const factories = plugin.manifest.capabilities
      .map(capability => capability.service?.factory)
      .filter((factory): factory is string => typeof factory === 'string' && factory.trim().length > 0)
    if (factories.length === 0) return []
    const sourceDir = this.artifactSourceDir(pluginId)
    if (sourceDir === null) return []
    return factories.map(factory => pathToFileURL(resolveFactoryModulePath(sourceDir, factory)).href)
  }

  /**
   * The directory the admitted artifact's manifest was read from: an npm
   * row owns its extracted tree under the governance storage area, and a
   * preinstall `local:` row keeps the seed source verbatim — resolved
   * against the repository root exactly like the executor's installSource,
   * so both faces agree on one absolute dir. The F7 containment gate runs
   * on this face too (TC-B4-H1 face 6): a rewritten ledger row whose `local:`
   * spec escapes the repository root (textually or through a link) throws a
   * queryable reason instead of handing an outside dir to the mount chain.
   */
  private artifactSourceDir(pluginId: PluginGovernanceId): string | null {
    const row = this.installedSources.get(pluginId)
    if (row === undefined) return null
    if (row.kind === 'npm') return row.dir
    if (!row.spec.startsWith('local:')) return null
    const rest = row.spec.slice('local:'.length)
    return resolveContainedPath(this.repoRoot, rest, 'local: origin spec')
  }

  /** Structural read view of the project plugin layer service (no package import). */
  private projectLayer(): {
    originOf(entryId: string): ProjectOriginLike | undefined
    guardedManifestOf(entryId: string): GovernedManifest | undefined
    subprocessEntryIds?(): string[]
  } | undefined {
    try {
      const candidate = this.ctx.get('projectPluginLayer') as
        | {
          originOf(entryId: string): ProjectOriginLike | undefined
          guardedManifestOf(entryId: string): GovernedManifest | undefined
          subprocessEntryIds?(): string[]
        }
        | undefined
      if (candidate === undefined) return undefined
      return candidate
    } catch {
      return undefined
    }
  }

  /** Origin of one loader entry id when the project layer knows it. */
  private projectOriginOf(entryId: string): ProjectOriginLike | undefined {
    return this.projectLayer()?.originOf(entryId)
  }

  /** The guarded (clamped) manifest the project layer mounted for one entry. */
  private projectGuardedManifestOf(entryId: string): GovernedManifest | undefined {
    return this.projectLayer()?.guardedManifestOf(entryId)
  }

  /**
   * Register one project-layer entry (a loader entry or a subprocess-tier
   * entry with no loader row) into the governed registry as source='project'.
   * Shared by the loader mirror branch and the subprocess enumeration so both
   * rows get the same C-01 projection: explicit id = manifest id, clamped
   * manifest, no OFFICIAL badge, no autoApprove.
   * @param entryId - the loader entry id (or synthetic project entry id).
   * @param origin - the layer's origin record for this entry.
   * @param service - the mounted Cordis service for a loader entry; subprocess
   *   entries pass no service (their tools are host-side proxies) and receive
   *   a stub whose health probe reports the mirror status.
   */
  private async registerProjectEntry(
    entryId: string,
    origin: ProjectOriginLike,
    service?: unknown,
  ): Promise<void> {
    const manifestId = canonicalId(origin.manifestId)
    if (this.mirrored.has(manifestId)) return
    const guardedManifest = this.projectGuardedManifestOf(entryId)
    if (guardedManifest === undefined) {
      // Origin without a guarded manifest means the layer is in a state it
      // should never reach; fail soft and never treat this entry as an official
      // host plugin either (the C-01 invariant).
      this.warn(`project entry ${entryId} has no guarded manifest; skipping`)
      return
    }
    const result = await this.registry.register(wrapCordisPlugin(
      // Subprocess-tier project entries have no mounted Cordis service to
      // mirror; the project source branch of the adapter never consults the
      // service for the manifest, and the stub keeps health/status probes
      // defined. Loader entries keep their real mounted service.
      service === undefined ? { start: async () => {}, stop: async () => {} } : service as CordisService,
      mirrorPluginContext(String(manifestId), this.ctx.logger),
      {
        id: String(manifestId),
        name: mountedDisplayName(manifestId),
        version: origin.version,
        mirror: true,
        source: 'project',
        manifest: guardedManifest,
      },
    ))
    this.mirrored.add(manifestId)
    if (result.success) {
      this.projectSources.set(manifestId, {
        projectRoot: origin.projectRoot,
        runtimeTier: origin.runtimeTier ?? 'in-process',
      })
    } else {
      this.warn(`failed to register project entry ${entryId}: ${(result.errors ?? []).map(error => error.message).join('; ')}`)
    }
  }

  /** Non-fatal sync diagnostics go through the host logger, never to callers. */
  private warn(message: string): void {
    this.ctx.logger.warn('plugin-governance: %s', message)
  }

  /** Fail unless the id names a registered plugin, returning its canonical form. */
  private requirePlugin(pluginId: PluginGovernanceId): GovernanceResult<readonly [PluginGovernanceId, GovernedPlugin]> {
    const id = canonicalId(pluginId)
    const plugin = this.registry.get(id)
    if (plugin === null) return failed('plugin-not-found', noSuchPlugin(id))
    return succeeded([id, plugin] as const)
  }

  /** Build the list-line projection for one plugin. */
  private summaryOf(plugin: GovernedPlugin): GovernedPluginSummary {
    const manifest = plugin.manifest
    const pluginId = canonicalId(manifest.id)
    const project = this.projectSources.get(pluginId)
    const installed = this.installedSources.get(pluginId)
    return Object.freeze({
      pluginId,
      displayName: manifest.name,
      version: manifest.version,
      status: STATUS_NAMES[this.registry.getStatus(pluginId)],
      // Entries mirrored from the Loader are distinguishable from native
      // registrations so the UI can badge their origin; project plugins
      // carry their root and source from the server-side origin table.
      source: project !== undefined
        ? 'project'
        : this.mirrored.has(pluginId) ? 'loader-mirror' : 'native',
      ...(project !== undefined ? { projectRoot: project.projectRoot } : {}),
      // §1.3 G2: factory-preinstalled `local:` rows badge their origin;
      // the source projection stays 'native' (admission, not a mirror).
      ...(installed?.kind === 'preinstall' ? { origin: 'preinstall' as const } : {}),
      approvalRequired: requiresAdmission(plugin),
      approved: this.approvals.has(pluginId),
      warnings: Object.freeze(this.registry.getPluginWarnings(pluginId) ?? []),
    })
  }

  /**
   * Registry errors for one plugin. Report rows are keyed by the raw
   * manifest id, exactly as the registry's own report builds them, so the
   * lookup uses that key instead of the canonical form.
   */
  private reportErrors(plugin: GovernedPlugin): readonly string[] {
    return this.registry.getHealthReport().plugins
      .find(row => row.id === plugin.manifest.id)?.errors ?? []
  }

  /** Read one plugin's own health probe, `null` when it declares none. */
  private probeVerdict(pluginId: PluginGovernanceId): boolean | null {
    const verdict = this.registry.get(pluginId)?.getHealthStatus?.()
    return verdict === undefined ? null : verdict.healthy
  }

  /**
   * Snapshot the registry after a status mutation; on IO failure undo the
   * mutation, so a receipt is only ever sent when memory and disk agree.
   */
  private persistRegistryChange(undo: () => void): GovernanceResult<GovernanceAcknowledgement> {
    try {
      this.persistence.save()
    } catch (cause) {
      undo()
      return failed('persistence-failed', `the registry snapshot could not be written: ${describe(cause)}`)
    }
    return succeeded(Object.freeze({ acknowledged: true }))
  }

  /** Approvals ledger path inside the persistence data directory. */
  private get approvalsPath(): string {
    return join(this.persistence.dataDir, 'approvals.json')
  }

  /** Installed-source ledger path inside the persistence data directory. */
  private get installedSourcesPath(): string {
    return join(this.persistence.dataDir, 'installed-sources.json')
  }

  /**
   * Destination for one registry install's extracted files: a fixed
   * two-level layout under the governance storage area, built only from
   * validated npm name segments so the path stays inside storage by
   * construction.
   */
  private npmInstallDir(pluginId: PluginGovernanceId): string {
    const [namespace = '', name = ''] = String(pluginId).split('/')
    return join(this.persistence.storagePath, 'installed', namespace, name)
  }

  /**
   * P2 fix (TEST-b0-baseline §3-A): after a restart the in-memory governed
   * registry is empty, yet the installed-sources installed-source ledger survives,
   * so a storage-only `npm:` install becomes unreachable — `uninstall`/`get`
   * return `plugin-not-found` and its extracted tree is orphaned on disk.
   * Re-register each such entry from its recorded tree, reusing the exact
   * manifest construction and fail-closed admission gate the original install
   * ran, but WITHOUT rewriting any durable ledger (registry.json already
   * carries the row, and persistence.save at the next mutation refreshes it).
   *
   * Fail-soft and user-data-preserving: a tree that has vanished or no longer
   * parses is skipped with a warning and its ledger row is left intact — the
   * standing discipline that runtime user ledgers are never script-deleted.
   */
  private async rebuildInstalledRoster(): Promise<void> {
    for (const [pluginId, source] of [...this.installedSources]) {
      // Only `npm:` rows own an extracted tree under the governance storage
      // area and so are what this rebuild restores. A factory `preinstall` row
      // carries **no** dir (its artifact lives in the pnpm workspace closure,
      // never here — S3 §1.3), and it is re-admitted by the preinstall pass at
      // boot, never by this roster scan. Rebuilding from a nonexistent dir
      // would both fail to compile against the union and risk double-register.
      if (source.kind !== 'npm') continue
      // A loader mirror, a live native registration, or a rebuilt sibling
      // already owns the id — never double-register.
      if (this.registry.get(pluginId) !== null) continue
      const manifest = manifestFromLocalSource(source.dir)
      if (!manifest.ok) {
        this.warn(`failed to rebuild roster entry for ${String(pluginId)} from storage: ${manifest.error.message}`)
        continue
      }
      const plugin: GovernedPlugin = { manifest: manifest.value, install: () => {}, uninstall: () => {} }
      const registration = await this.registry.register(plugin)
      if (!registration.success) {
        const reasons = (registration.errors ?? []).map(error => `${error.path}: ${error.message}`).join('; ')
        this.warn(`failed to rebuild roster entry for ${String(pluginId)}: ${reasons || 'unknown validation failure'}`)
        continue
      }
      // Re-apply the same server-side gate install applied: without a stored
      // approval decision a permission-posture plugin comes back disabled, so a
      // restart never silently re-enables code the operator had not approved.
      if (requiresAdmission(plugin) && !this.approvals.has(pluginId)) {
        await this.registry.disable(pluginId, 'rebuilt from storage without a recorded admission decision')
      }
    }
  }

  /** Hydrate the installed-source ledger once at init. */
  private loadInstalledSources(): void {
    if (!existsSync(this.installedSourcesPath)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.installedSourcesPath, 'utf8')) as unknown
    } catch {
      // A corrupt ledger loses only uninstall hygiene: entries without it are
      // treated like local installs and their directories stay in place.
      return
    }
    if (!isRecord(parsed) || !isRecord(parsed.sources)) return
    for (const [id, entry] of Object.entries(parsed.sources)) {
      const source = readInstalledSource(entry)
      if (source !== null) this.installedSources.set(canonicalId(id), source)
    }
  }

  /** Write the installed-source ledger as one atomic replacement (FB5,
   * 0o600: user decision data); throws so the caller can compensate. */
  private saveInstalledSources(): void {
    const payload: PersistedInstalledSources = { version: 1, sources: {} }
    for (const [id, entry] of this.installedSources) payload.sources[String(id)] = entry
    writeFileAtomicSync(this.installedSourcesPath, JSON.stringify(payload, null, 2), 0o600)
  }

  /** Hydrate the approvals ledger once at init. */
  private loadApprovals(): void {
    if (!existsSync(this.approvalsPath)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.approvalsPath, 'utf8')) as unknown
    } catch {
      // A corrupt or half-written ledger carries no decisions worth keeping:
      // admission reverts to unapproved, which fails closed for every plugin.
      return
    }
    if (!isRecord(parsed) || !isRecord(parsed.approvedAt)) return
    for (const [id, at] of Object.entries(parsed.approvedAt)) {
      if (typeof at === 'number' && Number.isFinite(at)) this.approvals.set(canonicalId(id), at)
    }
  }

  /** Write the approvals ledger as one atomic replacement (FB5, 0o600: user
   * decision data); throws so the caller can compensate. */
  private saveApprovals(): void {
    const payload: PersistedApprovals = { version: 1, approvedAt: {} }
    for (const [id, at] of this.approvals) payload.approvedAt[String(id)] = at
    writeFileAtomicSync(this.approvalsPath, JSON.stringify(payload, null, 2), 0o600)
  }

  /**
   * Read the persisted enable/disable decisions once at construction (R1-17).
   * The registry.json snapshot that persistence.save writes carries each
   * plugin's last acknowledged status; reading it here is what makes a restart
   * honor those decisions instead of silently resetting them. The file layout
   * and narrowing discipline mirror persistence.load's, extended with the
   * per-entry `status` field that API leaves out. A missing or corrupt
   * snapshot carries no decisions worth keeping: restore stays a no-op (fail
   * closed to the registry's own defaults).
   */
  private loadPersistedDecisions(): void {
    if (!existsSync(this.persistence.registryPath)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.persistence.registryPath, 'utf8')) as unknown
    } catch {
      return
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) return
    for (const entry of parsed.plugins) {
      if (!isRecord(entry) || typeof entry.id !== 'string') continue
      if (entry.status === 'active' || entry.status === 'disabled') {
        this.persistedDecisions.set(canonicalId(entry.id), entry.status)
      }
    }
  }

  /**
   * Re-apply persisted decisions to every registered plugin they name. Each id
   * applies once and then leaves the queue, so later passes never clobber live
   * operator decisions made during this session; ids whose plugin has not
   * registered yet stay queued until a future pass sees them mount. Only
   * disables are enforced: a fresh process registers everything active by
   * default, and force-re-enabling here would bypass the server-side admission
   * gate the `enable` remote enforces.
   */
  private async restorePersistedDecisions(): Promise<void> {
    for (const [pluginId, decision] of [...this.persistedDecisions]) {
      if (this.registry.get(pluginId) === null) continue
      this.persistedDecisions.delete(pluginId)
      if (decision !== 'disabled') continue
      try {
        if (this.registry.getStatus(pluginId) !== PluginStatus.DISABLED) {
          await this.registry.disable(pluginId)
        }
      } catch (cause) {
        this.warn(`failed to restore persisted disabled state for ${String(pluginId)}: ${describe(cause)}`)
      }
    }
  }

  /** Preset file path for one validated name. */
  private presetPath(name: string): string {
    return join(this.persistence.storagePath, 'presets', `${name}.json`)
  }
}

/**
 * Yield `dir` and each of its ancestors up to the filesystem root, so a
 * nearest-ancestor search can locate the repository by its `zdsh-factory` dir.
 */
function* ancestorDirs(start: string): Generator<string> {
  let dir = resolve(start)
  for (;;) {
    yield dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

/**
 * Resolve which seed file the preinstall pass consumes: an explicit config
 * path wins, then the `DSH_FACTORY_SEED` environment override, then the
 * nearest ancestor of this module holding `zdsh-factory/seed.json`; falling
 * all the way through, return the conventional repo-root location anyway (a
 * path that does not exist simply makes the pass a zero-action no-op, so this
 * never aborts boot — DESIGN-intake-tech.md §1.2).
 */
function resolveSeedPath(configSeedPath: string | undefined, env: NodeJS.ProcessEnv): string {
  if (typeof configSeedPath === 'string' && configSeedPath.trim().length > 0) return resolve(configSeedPath)
  const fromEnv = env['DSH_FACTORY_SEED']
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv)
  const here = dirname(fileURLToPath(import.meta.url))
  for (const dir of ancestorDirs(here)) {
    const candidate = join(dir, 'zdsh-factory', 'seed.json')
    if (existsSync(candidate)) return candidate
  }
  // Not found on disk: fall back to `packages/host/<pkg>/{src,lib}` → repo root.
  return join(resolve(here, '..', '..', '..', '..'), 'zdsh-factory', 'seed.json')
}

/**
 * The repository root a relative `local:` seed path resolves against. The seed
 * normally lives at `<root>/zdsh-factory/seed.json`; for a custom path that
 * sits elsewhere, fall back to the seed's own directory.
 */
function deriveRepoRoot(seedPath: string): string {
  const seedDir = dirname(resolve(seedPath))
  if (basename(seedDir) === 'zdsh-factory') return dirname(seedDir)
  return seedDir
}

/** Canonical not-found message for one plugin id. */
function noSuchPlugin(pluginId: PluginGovernanceId): string {
  return `no registered plugin ${JSON.stringify(String(pluginId))}`
}
/**
 * Deny-all sandbox defaults behind a manifest built from a plain package.json:
 * until the plugin's own `dsh.sandbox` section declares otherwise it gets no
 * network, no process rights, and read-only filesystem access.
 */
function denyAllSandbox(): GovernedManifest['sandbox'] {
  return {
    type: 'inline',
    resources: { memoryLimitMb: 256, cpuLimit: 50, timeoutMs: 30000, maxOutputBytes: 10_000 },
    filesystem: { access: 'readonly', allowedPaths: [], deniedPatterns: [] },
    network: { access: 'none', allowedHosts: [], deniedHosts: [], allowLocal: false },
    environment: { whitelist: [], blacklist: [], clear: false },
    process: { spawn: false, exec: false, allowedCommands: [] },
  }
}

/**
 * Read one local plugin directory and construct a governance manifest from
 * its package.json (L3 admission pipeline). Identity comes from the standard
 * npm fields (`name` normalized into the canonical `namespace/name` key space,
 * `version`); an optional embedded `dsh` section may declare compatibility,
 * permission posture, capabilities, and sandbox; everything undeclared falls
 * back to fail-closed defaults. Every unreadable or under-specified source
 * surfaces as `request-invalid`.
 */
function manifestFromLocalSource(source: unknown): GovernanceResult<GovernedManifest> {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return failed('request-invalid', 'install requires the local plugin directory path in source')
  }
  let stats: Stats | undefined
  try {
    stats = statSync(source, { throwIfNoEntry: false })
  } catch {
    stats = undefined
  }
  if (stats === undefined || !stats.isDirectory()) {
    return failed(
      'request-invalid',
      `the install source ${JSON.stringify(source)} is not an existing local directory`,
    )
  }
  const packagePath = join(source, 'package.json')
  if (!existsSync(packagePath)) {
    return failed('request-invalid', 'the install source carries no package.json; a readable plugin manifest is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as unknown
  } catch (cause) {
    return failed('request-invalid', `package.json could not be parsed: ${describe(cause)}`)
  }
  if (!isRecord(parsed)) {
    return failed('request-invalid', 'package.json is not a JSON object')
  }
  const rawName = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  const id = normalizePluginId(rawName)
  if (!validatePluginId(id)) {
    return failed(
      'request-invalid',
      `package.json name ${JSON.stringify(rawName)} does not normalize to a valid governance plugin id (namespace/name)`,
    )
  }
  const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return failed('request-invalid', `package.json version ${JSON.stringify(version)} is not a semver string`)
  }
  // Optional embedded governance section; unrecognized content stays out.
  const dsh = isRecord(parsed.dsh) ? parsed.dsh : {}
  const capabilities: GovernedManifest['capabilities'] = Array.isArray(dsh.capabilities)
    ? (dsh.capabilities.filter(entry => isRecord(entry)) as unknown as GovernedManifest['capabilities'])
    : []
  const manifest: GovernedManifest = {
    id,
    version,
    name: typeof parsed.displayName === 'string' && parsed.displayName.trim().length > 0
      ? parsed.displayName
      : rawName,
    ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
    ...(typeof parsed.author === 'string' ? { author: parsed.author } : {}),
    dsh: {
      compatible: typeof dsh.compatible === 'string' && dsh.compatible.trim().length > 0
        ? dsh.compatible
        : '>=0.0.0',
    },
    capabilities,
    // FB3 (TC-B4-H1 face 2, D1b §3-FB3): the install channel's trust fields
    // are governance-side decisions ONLY — the package's own
    // `dsh.permissionLevel` / `dsh.autoApprove` are never consumed (any npm
    // publisher or local directory could otherwise self-elevate to
    // admission-free ACTIVE; the project-source adapter already clamps the
    // same way, cordis-adapter autoApprove 恒 false). Every installed
    // manifest starts at CONFIRM_REQUIRED; the factory seed rows' admission
    // is granted governance-side by the seed/pin chain (admitManifest's
    // seedChain grant) — trust from supply-chain pinning, not self-report.
    // (`certification` was never consumed on this channel: nothing to strip.)
    permissionLevel: PluginPermissionLevel.CONFIRM_REQUIRED,
    sandbox: isRecord(dsh.sandbox) ? (dsh.sandbox as unknown as GovernedManifest['sandbox']) : denyAllSandbox(),
  }
  return succeeded(manifest)
}

/**
 * Whether one manifest's permission posture asks for an explicit admission
 * decision. Shared by the roster projection and the server-side `enable` gate,
 * so what the UI displays is exactly what the service enforces.
 */
function requiresAdmission(plugin: GovernedPlugin): boolean {
  const level = plugin.manifest.permissionLevel
  return plugin.manifest.autoApprove !== true
    && (level === undefined
      || level === PluginPermissionLevel.CONFIRM_REQUIRED
      || level === PluginPermissionLevel.SYSTEM)
}

/**
 * Pick the mounted instance to govern from one active fiber: prefer a value
 * that looks like a Cordis service (start/health surface), else the first
 * object-valued implementation the fiber provided.
 */
function resolveMountedService(fiber: Fiber): unknown {
  const store = fiber.store as Record<string, ProvidedImplementation | undefined> | undefined
  if (store === undefined) return undefined
  let fallback: unknown
  for (const implementation of Object.values(store)) {
    const value = implementation?.value
    if (value === null || typeof value !== 'object') continue
    if (isCordisPlugin(value)) return value
    fallback ??= value
  }
  return fallback
}

/** Display name for a mounted module specifier (`@scope/pkg` → `pkg`). */
function mountedDisplayName(moduleName: string): string {
  const segments = moduleName.split('/')
  return segments[segments.length - 1] ?? moduleName
}

/**
 * Printf-style sink for mirror-context diagnostics: the subset of the host
 * `ctx.logger` (cordis LoggerService) surface this module forwards into.
 */
interface MirrorLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/**
 * Minimal governance-spec context used only to construct mirrored wrappers.
 * The registry substitutes its own context for install/uninstall; this one
 * carries a logger adapter over the host `ctx.logger` controlled channel —
 * the same sink the gateway's own warn() helper uses — so adapter
 * diagnostics stay attributable (`[governed <id>]` prefix, printf `%s`
 * form) and never touch console. stdout is a product surface (headless JSON
 * event stream); the former console.* bypass polluted it (SYNC-017 §12
 * family-1, e2e expected-output 27F root cause). Cordis routes logger
 * output to in-memory exporters (LoggerService ring buffer; app-boot only
 * collects WARN+ into startup diagnostics), so green runs stay silent.
 */
function mirrorPluginContext(pluginId: string, logger: MirrorLogger): GovernedPluginContext {
  return {
    services: new Map(),
    emit: () => {},
    on: () => () => {},
    once: () => () => {},
    off: () => {},
    config: {},
    setConfig: () => {},
    getConfig: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
    effect: () => {},
    onDispose: () => {},
    logger: {
      info: (message) => { logger.info(`[governed ${pluginId}] %s`, message) },
      warn: (message) => { logger.warn(`[governed ${pluginId}] %s`, message) },
      error: (message) => { logger.error(`[governed ${pluginId}] %s`, message) },
      debug: () => {},
    },
    status: PluginStatus.ACTIVE,
    setWarnings: () => {},
    markDeprecated: () => {},
    sandbox: {
      exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '', duration: 0 }),
      read: () => Promise.resolve(''),
      write: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    registerCapability: () => {},
    unregisterCapability: () => {},
  }
}

/** Restore a Map entry removed or overwritten by a compensated operation. */
function restoreMapEntry<K, V>(map: Map<K, V>, key: K, previous: V | undefined): void {
  if (previous === undefined) map.delete(key)
  else map.set(key, previous)
}

/** Validate one preset name against the file-stem grammar. */
function checkPresetName(name: string): string | null {
  if (PRESET_NAME_PATTERN.test(name)) return null
  return 'preset name must be 1-64 letters, digits, underscores, or hyphens'
}

/** Read and narrow one preset file; throws on unreadable or foreign content. */
function readPreset(path: string): PersistedPreset {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new TypeError('not a v1 governance preset')
  }
  const entries: PersistedPreset['entries'] = []
  for (const entry of parsed.entries) {
    if (!isRecord(entry) || typeof entry.pluginId !== 'string') continue
    if (entry.status !== 'active' && entry.status !== 'disabled') continue
    entries.push({ pluginId: entry.pluginId, status: entry.status })
  }
  return { version: 1, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '', entries }
}

/** Write one preset file, creating the presets directory on first use. */
function writePreset(path: string, payload: PersistedPreset): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(payload, null, 2))
}

/**
 * Narrow one raw ledger row back into a origin source (S3, §1.3 G2). The
 * load loop used to inline only the `npm:` shape; the union needs a second
 * branch for factory-`preinstall` rows, which carry **no** `dir` (their
 * artifact lives in the pnpm workspace closure, never under the storage area).
 * An unrecognized shape — a foreign `kind`, or a row missing any mandatory
 * field — returns `null` so the caller drops it rather than admitting a
 * partially-narrowed entry that a later uninstall could mis-handle.
 */
function readInstalledSource(entry: unknown): PersistedInstalledSource | null {
  if (!isRecord(entry)) return null
  if (
    entry.kind === 'npm'
    && typeof entry.spec === 'string'
    && typeof entry.version === 'string'
    && typeof entry.installedAt === 'number'
    && typeof entry.dir === 'string'
  ) {
    return {
      kind: 'npm',
      spec: entry.spec,
      version: entry.version,
      installedAt: entry.installedAt,
      dir: entry.dir,
    }
  }
  if (
    entry.kind === 'preinstall'
    && typeof entry.spec === 'string'
    && typeof entry.version === 'string'
    && typeof entry.installedAt === 'number'
  ) {
    return {
      kind: 'preinstall',
      spec: entry.spec,
      version: entry.version,
      installedAt: entry.installedAt,
    }
  }
  return null
}

/** Narrow one parsed JSON document to a plain-object view. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** One-line cause rendering for failure messages, without stack noise. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export default PluginGovernanceGateway
