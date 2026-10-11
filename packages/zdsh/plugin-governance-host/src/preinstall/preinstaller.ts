/**
 * Factory preinstall executor (DESIGN-intake-tech.md §1.2, B4 case).
 *
 * {@link SeedPreinstaller} is the governance host's own code, not a plugin: it
 * runs once after the gateway's first Loader sync and drives the idempotent
 * per-entry state machine over the `zdsh-factory/seed.json` manifest —
 * already-registered entries are skipped, `local:`/`npm:` sources reuse the
 * gateway's existing `install()` admission channel, and the outcome lands in
 * the durable result ledger (§1.4) that the plugin-center hub reads back
 * through `preinstallReport()`. Uninstall of a preinstalled entry writes a
 * `userUninstalled` tombstone so a removed plugin is never resurrected.
 *
 * Fail-open, per item: an individual entry that cannot be installed records a
 * `failed` row and the pass continues; the executor never throws into boot.
 * The whole seed-read → install → ledger-write cycle runs under the
 * cross-process writer lock on the result ledger (K-B1), so a CLI and Web
 * gateway starting together serialize instead of double-installing; the lock
 * wait is widened past file-work because an `npm:` install holds it across a
 * registry round trip.
 *
 * Runtime *mounting* (§1.2 step 4, DESIGN-intake-tech.md §9.3) rides this
 * same pass: an admitted entry that declares `enabledAtBoot: true` has each
 * service factory exit of its OWN admitted manifest handed to the host's
 * generic `mount` channel (`ctx.loader.create` of the fileURL, entry id
 * `factory/<pluginId>`). The channel body is generic data — no plugin name
 * or per-id branch exists here (M2) — and per-item fail-open: a rejecting
 * mount (e.g. cordis `invalid plugin` for a library-only barrel) settles a
 * queryable `mount` sub-structure on the ledger row (§9.4) without aborting
 * the pass or touching sibling entries. SYNC-P3: the failure-capture face
 * lives in the gateway's mount hook, which stitches the 0.1.7 double seam —
 * create resolves on fiber creation; import/apply failures are re-captured
 * via the entry/fiber check plus the `fiber.await()` settle.
 *
 * ISOLATION CONTRACT, DECOUPLING DECLARATION (§9.4 bullet 4, verbatim
 * boundary): this mount path rides the raw cordis `ctx.loader.create`
 * channel and NOT the plugin-governance PreLoad five-check chain, so the
 * per-item fail-open here is NOT the SymbolIsolationCheck (DESIGN §2) — a
 * mounted artifact gains no symbol-isolation protection from this channel.
 * A "governed mount" that wraps create into the governance guard chain is
 * explicitly out of scope for this campaign (§9.7, batch 4.2+ separate
 * ruling).
 * @module @deepseek-ai/dsh-plugin-governance-host/src/preinstall/preinstaller
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizePluginId } from '@deepseek-ai/dsh-plugin-governance'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveContainedPath } from '../path-containment.ts'
import type {
  GovernanceAcknowledgement,
  GovernanceResult,
  PreinstallEntryResult,
  PreinstallMountResult,
  PreinstallReport,
} from '../types.ts'
import { parseSeedManifest, seedEntryContractIssue, type SeedEntry } from './seed.ts'
import {
  loadPreinstallResults,
  savePreinstallResults,
  toReport,
  type PersistedPreinstallResults,
} from './results.ts'

/**
 * How long a second gateway waits for the preinstall lock. An `npm:` install
 * holds the lock across a registry download, so the default file-work window
 * ({@link withFileLock} 2s) is far too short for a concurrent first boot.
 */
const PREINSTALL_LOCK_WAIT_MS = 120_000

/** The gateway capabilities the executor needs, injected to avoid a cycle. */
export interface SeedPreinstallerHost {
  /** Monotonic clock for ledger timestamps (overridable in tests). */
  now(): number
  /** Non-fatal diagnostics to the host logger; never surfaces to callers. */
  warn(message: string): void
  /** Whether the canonical id is already in the governed registry this process. */
  isRegistered(pluginId: string): boolean
  /**
   * Reuse the gateway's install admission channel. `expectedIntegrity` (FB6,
   * TC-B4-H1 face 5; `npm:` rows only) carries the seed's own sha512 pin: the
   * host verifies the downloaded tarball against it IN ADDITION to the
   * registry-declared digest, so the seed pin is an independent verification
   * basis rather than dead prose (a mismatch fails the row, never admits).
   */
  install(request: { source: string; expectedIntegrity?: string }): Promise<GovernanceResult<GovernanceAcknowledgement>>
  /**
   * Best-effort enable/disable of an installed artifact; the outcome never
   * fails the pass. `enabled=false` carries the §1.1 factory-off posture
   * (`enabledAtBoot: false` → admitted-but-disabled, the verticals case).
   */
  setBootState(pluginId: string, enabled: boolean): Promise<unknown>
  /**
   * Record the G2 factory origin row (§1.3) for one successfully
   * installed `local:` preinstall. Synchronous and throw-permissive at this
   * boundary: the executor wraps the call so a ledger write failure warns
   * instead of failing an admission that already landed.
   */
  recordOrigin(pluginId: string, spec: string, version: string): void
  /**
   * Mount one admitted factory exit of one preinstalled artifact
   * (DESIGN-intake-tech.md §9.3 step 4). Contract (UNCHANGED — mount throws
   * ⟺ the artifact failed): resolving = the entry settled loaded; rejecting
   * = the module is not loadable (a missing factory file, not a valid cordis
   * plugin) or its `apply` throws during start. Implementation note
   * (SYNC-P3): since 0.1.7 `ctx.loader.create({ name: moduleUrl,
   * id: 'factory/<pluginId>', disabled: !enabled })` alone no longer rejects
   * on import/apply failure, so the gateway hook stitches the two official
   * seams — create → entry/fiber check → `fiber.await()` settle — and
   * compensates a failure with `loader.remove`, leaving no live entry behind.
   */
  mount(pluginId: string, moduleUrl: string, enabled: boolean): Promise<void>
  /**
   * Resolve the file-URL exits one admitted artifact declares
   * (`dsh.capabilities[].service.factory` of its own installed manifest,
   * M-F2/M-F5). Returns `[]` when the artifact declares no service factory
   * — that entry then has no loadable exit and is not created (§9.3).
   */
  resolveFactoryUrls(pluginId: string): string[]
}

/** Construction inputs the gateway resolves once (paths + host ops). */
export interface SeedPreinstallerConfig {
  readonly seedPath: string
  readonly resultsPath: string
  readonly repoRoot: string
  readonly host: SeedPreinstallerHost
}

/** The install action's verdict, before a ledger timestamp is attached. */
type InstallOutcome = { status: 'installed' } | { status: 'failed'; reason: string }

/** Read the seed file; a missing or unparsable manifest yields no entries. */
function readSeedEntries(path: string): readonly SeedEntry[] {
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return []
  }
  return parseSeedManifest(raw).entries
}

/** Whether two ledger rows describe the same outcome (ignore no-op churn). */
function sameRow(a: PreinstallEntryResult, b: PreinstallEntryResult): boolean {
  return a.status === b.status
    && (a.reason ?? null) === (b.reason ?? null)
    && a.at === b.at
    && (a.userUninstalled === true) === (b.userUninstalled === true)
    // The mount dimension compares its verdict, not its stamp: a re-run that
    // resolves to the same status+reason keeps the prior `mount.at` (§9.4
    // restart byte-identity), so churn here would mean a real transition.
    && (a.mount?.status ?? null) === (b.mount?.status ?? null)
    && (a.mount?.reason ?? null) === (b.mount?.reason ?? null)
}

/**
 * The factory preinstall executor. One instance per gateway; {@link runPass}
 * is idempotent and safe to call repeatedly (the gateway invokes it fire-and-
 * forget at init and tests await its settle promise).
 */
export class SeedPreinstaller {
  private readonly seedPath: string
  private readonly resultsPath: string
  private readonly repoRoot: string
  private readonly host: SeedPreinstallerHost
  /** In-flight pass; concurrent triggers reuse one pass. */
  private running: Promise<void> | null = null

  constructor(config: SeedPreinstallerConfig) {
    this.seedPath = config.seedPath
    this.resultsPath = config.resultsPath
    this.repoRoot = config.repoRoot
    this.host = config.host
  }

  /**
   * Run one full preinstall pass and settle. Concurrent callers reuse the
   * in-flight pass. Never rejects: any unexpected throw is logged fail-open so
   * a broken seed never aborts boot (R-1.1.4).
   * @returns when the pass has committed (or decided to write nothing).
   */
  runPass(): Promise<void> {
    if (this.running !== null) return this.running
    this.running = this.settle().finally(() => {
      this.running = null
    })
    return this.running
  }

  /**
   * Current durable ledger projected to the client-facing report (§1.4).
   * @returns the read-only preinstall report for governance clients.
   */
  report(): PreinstallReport {
    return toReport(loadPreinstallResults(this.resultsPath))
  }

  /**
   * Record the operator's removal of one preinstalled entry as a tombstone so
   * later passes never reinstall it. A no-op (returns false) when the id names
   * no existing entry, so uninstalling a manually-installed or mirrored plugin
   * never fabricates a preinstall row.
   * @param pluginId - canonical governance id the caller uninstalled.
   * @returns whether a tombstone was newly written.
   */
  recordUninstall(pluginId: string): Promise<boolean> {
    const id = normalizePluginId(pluginId)
    return this.withLedger((ledger) => {
      const existing = ledger.entries[id]
      if (existing === undefined || existing.userUninstalled === true) return false
      ledger.entries[id] = { ...existing, status: 'skipped', userUninstalled: true, at: this.host.now() }
      return true
    })
  }

  /**
   * Read-modify-write the ledger under the exclusive writer lock. The mutator
   * re-reads committed state inside the lock so a serialized second process
   * sees the first's work, and the file is rewritten only when it returns true
   * (so a no-op pass leaves the bytes — and `ranAt` — untouched).
   */
  private async withLedger(mutate: (ledger: PersistedPreinstallResults) => boolean | Promise<boolean>): Promise<boolean> {
    // withFileLock creates a sibling `.lock`, so its parent directory must
    // already exist; ensure it even when the caller skipped service init.
    if (!existsSync(this.resultsPath)) {
      try {
        mkdirSync(dirname(this.resultsPath), { recursive: true })
      } catch {
        // A dir we cannot create surfaces from the lock/write below as a
        // fail-open pass warning; nothing to compensate here.
      }
    }
    return withFileLock(this.resultsPath, async () => {
      const ledger = loadPreinstallResults(this.resultsPath)
      const changed = await mutate(ledger)
      if (changed) savePreinstallResults(this.resultsPath, ledger)
      return changed
    }, { waitMs: PREINSTALL_LOCK_WAIT_MS })
  }

  /** The whole pass, one lock, fail-open at the top level. */
  private async settle(): Promise<void> {
    try {
      await this.withLedger(async (ledger) => {
        const entries = readSeedEntries(this.seedPath)
        // Zero-action passthrough: an empty/absent seed must not touch the
        // ledger at all, so non-zDSH and test trees stay byte-untouched.
        if (entries.length === 0) return false
        let changed = false
        for (const entry of entries) {
          if (await this.applyEntry(entry, ledger)) changed = true
        }
        if (changed) ledger.ranAt = this.host.now()
        return changed
      })
    } catch (cause) {
      // Fail-open: a broken pass must never abort boot. Report, keep prior ledger.
      this.host.warn(`preinstall pass failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Drive one seed entry through the idempotent state machine against the
   * loaded ledger. @returns whether the ledger row changed.
   */
  private async applyEntry(entry: SeedEntry, ledger: PersistedPreinstallResults): Promise<boolean> {
    const id = normalizePluginId(entry.id)
    const existing = ledger.entries[id]
    // Tombstone wins over everything: never resurrect a removed preinstall.
    if (existing?.userUninstalled === true) return false
    // Present in this process's registry (an npm rebuilt from storage, a loader
    // mirror, or a prior pass this boot): nothing to install.
    if (this.host.isRegistered(id)) {
      if (existing !== undefined) return false
      ledger.entries[id] = { status: 'skipped', at: this.host.now() }
      return true
    }
    // Absent and untombstoned: install through the shared admission channel.
    // S2 (EXEC7 建议②): an entry the executor cannot honor — an unimplemented
    // failPolicy, or an npm: source without its mandatory sha512 integrity —
    // becomes a queryable `failed` row before any install attempt, never a
    // silent downgrade to the executor's own defaults.
    const issue = seedEntryContractIssue(entry)
    if (issue !== null) return this.writeRow(ledger, id, { status: 'failed', reason: issue }, existing)
    const outcome = await this.installOne(entry, id)
    if (outcome.status === 'installed') {
      // G2 origin (§1.3): a `local:` artifact admitted through the shared
      // channel carries its factory row (the npm: form's registry row is
      // already written by the install channel itself, dir included).
      if (entry.source.startsWith('local:')) this.requestOrigin(entry, id)
      // Step 4 (§9.3): boot-enabled entries additionally take the generic
      // mount channel; a `enabledAtBoot: false` entry is never created and
      // records the `skipped` mount dimension (§9.4) so Gate-P can tell
      // "declared off" apart from "tried and failed" at a glance.
      const mount = entry.enabledAtBoot
        ? await this.mountEntry(id)
        : { status: 'skipped' as const, reason: 'not mounted: the seed entry declares enabledAtBoot=false' }
      const changed = this.writeRow(ledger, id, { status: 'installed', mount }, existing)
      // Activation posture is best-effort and never changes the ledger row
      // (activation is not admission): boot-enabled entries enable, and a
      // factory-off entry (`enabledAtBoot: false`, §1.1) takes the
      // registry's default-ACTIVE admission, so the executor disables it once
      // on first admit. Restarts skip the disable (row unchanged) and instead
      // honor the operator's own persisted enable/disable decision.
      if (entry.enabledAtBoot) this.requestBootState(id, true)
      else if (changed) this.requestBootState(id, false)
      return changed
    }
    return this.writeRow(ledger, id, { status: 'failed', reason: outcome.reason }, existing)
  }

  /**
   * Drive the generic mount channel (§9.3) for one admitted, boot-enabled
   * entry: resolve the factory exits from the artifact's OWN admitted
   * manifest, then mount each and await settle. Fail-open per item (§9.4):
   * the first rejecting mount settles the row's `mount` dimension as
   * `failed` with that cause — the pass continues, siblings are untouched,
   * nothing is thrown into boot. Zero plugin knowledge: every input is data
   * (seed read-back + manifest factory paths, M2).
   */
  private async mountEntry(id: string): Promise<Omit<PreinstallMountResult, 'at'>> {
    let urls: string[]
    try {
      urls = this.host.resolveFactoryUrls(id)
    } catch (cause) {
      return { status: 'failed', reason: `factory resolution failed: ${cause instanceof Error ? cause.message : String(cause)}` }
    }
    if (urls.length === 0) {
      return { status: 'skipped', reason: 'the admitted manifest declares no service factory path' }
    }
    for (const url of urls) {
      try {
        await this.host.mount(id, url, true)
      } catch (cause) {
        return { status: 'failed', reason: `${url}: ${cause instanceof Error ? cause.message : String(cause)}` }
      }
    }
    return { status: 'mounted' }
  }

  /** Run the install action; a thrown host error is a fail-open `failed`. */
  private async installOne(entry: SeedEntry, id: string): Promise<InstallOutcome> {
    try {
      const result = await this.host.install({
        source: this.installSource(entry),
        // FB6 (TC-B4-H1 face 5): the seed row's own sha512 pin rides along on
        // `npm:` rows — the host compares the downloaded tarball against it as
        // an INDEPENDENT second basis beside the registry's self-declared
        // dist.integrity (same-channel self-attestation ≠ seed pin). The
        // contract gate upstream already made integrity mandatory for npm:.
        ...(entry.source.startsWith('npm:') && entry.integrity !== null
          ? { expectedIntegrity: entry.integrity }
          : {}),
      })
      if (result.ok) return { status: 'installed' }
      // A plugin admitted earlier this same boot by a concurrent path already
      // occupies the id: treat that as satisfied, not a failure.
      if (this.host.isRegistered(id)) return { status: 'installed' }
      // zDSH 防御性保留：host.install 是注入面（GovernanceHost），违约实现可在
      // 运行期返回 { ok: false } 而缺 error 字段；移除 ?. 会使属性访问抛
      // TypeError 被下方 catch 改写 reason 文案（运行时行为改变），?? 兜底
      // 维持 fail-soft reason 语义，故行级豁免。
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      return { status: 'failed', reason: result.error?.message ?? 'install was rejected' }
    } catch (cause) {
      return { status: 'failed', reason: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  /**
   * Map a seed entry's two-state source onto the gateway install() face:
   * `npm:` passes through for the registry branch; `local:<path>` strips the
   * scheme and resolves a relative path against the repository root (the B4
   * artifact lives in `node_modules/`, bare-resolved from the repo) through
   * the F7 containment gate (TC-B4-H1 face 6; D1a F7 / D1b §4: the seed is an
   * UNTRUSTED declarative file — a `..` escape, an outside-root absolute, a
   * cross-drive value, or a junction/symlink escaping the root throws here and
   * settles as a queryable `failed` row via installOne's catch; a legal
   * in-root row returns the identical value as before = zero drift for the
   * factory eight, K-1.2.1 zero-false-kill discipline).
   */
  private installSource(entry: SeedEntry): string {
    if (entry.source.startsWith('npm:')) return entry.source
    const rest = entry.source.slice('local:'.length)
    return resolveContainedPath(this.repoRoot, rest, 'local: seed source')
  }

  /**
   * Write one ledger row, stamping `at` fresh only when the status transitions
   * (so re-running an already-`installed` entry leaves the row byte-identical
   * and the second boot is a true no-op). @returns whether the row changed.
   */
  private writeRow(
    ledger: PersistedPreinstallResults,
    id: string,
    outcome: Omit<PreinstallEntryResult, 'at'>,
    prior: PreinstallEntryResult | undefined,
  ): boolean {
    const at = prior !== undefined && prior.status === outcome.status ? prior.at : this.host.now()
    if (outcome.mount !== undefined) {
      // Same stamp-preserving discipline as the row-level `at`: the mount
      // timestamp refreshes only on a real mount-dimension transition, so a
      // restart that resolves to the same verdict keeps the ledger bytes.
      const priorMount = prior?.mount
      const unchanged = priorMount !== undefined
        && priorMount.status === outcome.mount.status
        && (priorMount.reason ?? null) === (outcome.mount.reason ?? null)
      const mountAt = unchanged && typeof priorMount.at === 'number' ? priorMount.at : this.host.now()
      const next: PreinstallEntryResult = {
        ...outcome,
        mount: { ...outcome.mount, at: mountAt },
        at,
      }
      if (prior !== undefined && sameRow(prior, next)) return false
      ledger.entries[id] = next
      return true
    }
    const next: PreinstallEntryResult = { ...outcome, at }
    if (prior !== undefined && sameRow(prior, next)) return false
    ledger.entries[id] = next
    return true
  }

  /** Fire the injected enable/disable hook; a throw here never fails the ledger. */
  private requestBootState(id: string, enabled: boolean): void {
    void Promise.resolve(this.host.setBootState(id, enabled)).catch((cause: unknown) => {
      this.host.warn(`preinstall boot state ${JSON.stringify(id)}=${enabled ? 'active' : 'disabled'} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }

  /**
   * Fire the injected origin record; a durable-write failure warns (the
   * admission already landed) and the next pass retries, never fails the row.
   */
  private requestOrigin(entry: SeedEntry, id: string): void {
    try {
      this.host.recordOrigin(id, entry.source, entry.version)
    } catch (cause) {
      this.host.warn(`preinstall origin ${JSON.stringify(id)} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}
