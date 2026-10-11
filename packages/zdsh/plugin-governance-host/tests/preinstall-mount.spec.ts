/**
 * Generic mount channel suite (TC-B2-23A, DESIGN-intake-tech.md §9 fix8
 * card A): the preinstall executor's step 4 now drives, for every admitted
 * `enabledAtBoot: true` row, one `ctx.loader.create({ name: <fileURL of the
 * artifact's own declared service.factory>, id: 'factory/<pluginId>',
 * disabled: !enabled })` through the host seam (§9.3), and the durable
 * ledger gained the queryable `mount` sub-structure (§9.4).
 *
 * Dual tracks per the card:
 *  - FAKE loader track: a create-arg recorder provided as `ctx.loader`,
 *    proving the channel contract (name = fileURL built from the SEED
 *    read-back + the ADMITTED manifest's factory — never hard-coded, M-F4;
 *    id = `factory/<pluginId>`; disabled flag; boot-off rows never create).
 *  - REAL loader track: the genuine cordis Loader over tmpdir fixtures and
 *    the three REAL factory-bundle artifacts. bridge is the LIVE smoke
 *    (V2 §5-1, non-fake-only): the real `ctx.loader.create` settles and the
 *    `bridge` service resolves off the context. verticals/omnivision were
 *    library-only barrels at the A card's landing (create rejected `invalid
 *    plugin` → the expected-red ledger rows); cards B (omnivision cordis-adapter
 *    060da4d) and C (verticals apply entry 956df1b) have since turned them into
 *    valid cordis plugins, so per §9.5-A③ ("when B/C land the adapter exits,
 *    these very assertions flip to mounted; nobody sneaks the rows out of the
 *    table") the TC-B2-23D re-pin below flips those rows to `mounted` verbatim.
 *  - Fail-open iron proof: within ONE pass the valid sibling mounts while a
 *    barrel row lands `mount:'failed'`, the pass never aborts, and the
 *    roster stays clean because the mirror skips the generic `factory/`
 *    channel namespace.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { normalizePluginId } from '@deepseek-ai/dsh-plugin-governance'
import PluginGovernanceGateway, { type PluginGovernanceId } from '../src/index.ts'
import { SEED_SCHEMA_VERSION } from '../src/preinstall/seed.ts'

const storageRoots: string[] = []
const dirs: string[] = []
const contexts: Context[] = []
const seedFiles: string[] = []
const repoSeedFiles: string[] = []
let seedSeq = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of storageRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const file of seedFiles.splice(0)) rmSync(file, { force: true })
  for (const file of repoSeedFiles.splice(0)) rmSync(file, { force: true })
})

/** A throwaway directory registered for cleanup. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gov-mount-'))
  dirs.push(dir)
  return dir
}

/** Boot a gateway over `storageRoot`, run its service init, return the handle. */
async function bootGateway(ctx: Context, seedPath: string): Promise<PluginGovernanceGateway> {
  const storageRoot = mkdtempSync(join(tmpdir(), 'gov-mount-store-'))
  storageRoots.push(storageRoot)
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot, seedPath })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return gateway
}

// ---- the real repository seed and its pinned artifacts ----------------------

// Repo root resolved from this spec's own location (…/packages/zdsh/
// plugin-governance-host/tests → up four), mirroring the gate-p discipline:
// the seed and the installed artifacts are read back, never re-declared.
const REPO_ROOT = resolve(dirname_of_spec(), '..', '..', '..', '..')
function dirname_of_spec(): string {
  return fileURLToPath(new URL('.', import.meta.url))
}
const SEED_PATH = join(REPO_ROOT, 'zdsh-factory', 'seed.json')

interface SeedRow {
  readonly id: string
  readonly package: string
  readonly version: string
  readonly pin: string
  readonly source: string
  readonly integrity: string | null
  readonly enabledAtBoot: boolean
  readonly family: string
  readonly failPolicy: string
}
const REAL_SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { entries: SeedRow[] }

/** The canonical governance id of one package name (seed-key space). */
function cid(value: string): PluginGovernanceId {
  return normalizePluginId(value) as PluginGovernanceId
}

/** Rewrite a `local:` seed source to its absolute in-repo directory. */
function absolutizeSource(row: SeedRow): string {
  if (!row.source.startsWith('local:')) {
    throw new Error(`mount-channel fixture only walks local: seed rows, got ${row.source}`)
  }
  const rest = row.source.slice('local:'.length)
  return resolve(REPO_ROOT, rest)
}

/** The artifact's own declared service factory paths (its admitted manifest). */
function declaredFactories(sourceDir: string): string[] {
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as {
    dsh?: { capabilities?: Array<{ service?: { factory?: string } }> }
  }
  return (manifest.dsh?.capabilities ?? [])
    .map(cap => cap.service?.factory)
    .filter((factory): factory is string => typeof factory === 'string' && factory.length > 0)
}

/**
 * A seed document over given rows, written directly under the tmpdir root.
 * F7 fixture root-posture migration (TC-B4-H1 face 6): with the seed at
 * `<tmpdir>/<unique>.json`, deriveRepoRoot anchors repoRoot=tmpdir, so the
 * scratch fixture dirs this file walks (also under tmpdir) are strictly
 * inside the containment root — row shapes and assertions untouched.
 */
function writeSeed(rows: unknown[]): string {
  const path = join(tmpdir(), `gov-mount-seed-${process.pid}-${seedSeq++}.json`)
  seedFiles.push(path)
  writeFileSync(path, JSON.stringify({ version: SEED_SCHEMA_VERSION, entries: rows }))
  return path
}

/**
 * A seed document for rows whose `local:` sources point at the REAL in-repo
 * artifacts (rowOf shape). F7: those absolute in-repo sources are only inside
 * the containment root when repoRoot=REPO_ROOT, which deriveRepoRoot gives
 * exactly for a seed under `<REPO_ROOT>/zdsh-factory/`. The REAL seed.json is
 * never touched; the temp file is PID-keyed and removed in afterEach (a
 * worker killed mid-test would leave a visible untracked residue — delete it
 * by hand; it never merges silently).
 */
function writeRepoSeed(rows: unknown[]): string {
  const path = join(REPO_ROOT, 'zdsh-factory', `seed.mountfixture-${process.pid}-${seedSeq++}.json`)
  repoSeedFiles.push(path)
  writeFileSync(path, JSON.stringify({ version: SEED_SCHEMA_VERSION, entries: rows }))
  return path
}

/** Copy a real seed row with an overridden posture, absolute `local:` source. */
function rowOf(id: string, overrides: Partial<SeedRow> = {}): SeedRow {
  const row = REAL_SEED.entries.find(entry => entry.id === id)
  if (row === undefined) throw new Error(`the repository seed is missing the ${id} row`)
  const merged = { ...row, ...overrides }
  return { ...merged, source: `local:${absolutizeSource(merged)}` }
}

/** A minimal local plugin directory whose manifest declares one service factory. */
function fixturePlugin(name: string, indexSource: string): string {
  const dir = scratch()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    dsh: {
      autoApprove: true,
      compatible: '>=0.0.0',
      capabilities: [{ type: 'service', service: { name: normalizePluginId(name).split('/')[1], factory: './index.js' } }],
    },
  }))
  writeFileSync(join(dir, 'index.js'), indexSource)
  return dir
}

// A cordis-valid module (named apply/inject/name — the §9.2 contract shape,
// structurally typed ctx, zero cordis imports, zero side effects) and a
// library-only barrel (named exports only: the M-F6 `invalid plugin` case).
const VALID_FIXTURE = `
export const name = 'mount-channel-valid-fixture'
export const inject = []
export function apply(ctx) { ctx.effect(() => () => {}) }
`
const BARREL_FIXTURE = `
export const LIB_ONLY_MEMBER = 'no apply, no default: a pure library barrel'
export class VerticalRegistryLike {}
`

// ============================================================================
// Fake-loader track: the channel CONTRACT (create args), no real import.
// ============================================================================

interface CreateCall {
  readonly name: string
  readonly id?: string
  readonly disabled?: boolean | null
}

describe('mount channel contract — fake loader records every create() arg', () => {
  it('routes boot-enabled rows to loader.create(fileURL, factory/<id>, disabled=false) and never boot-off rows', async () => {
    const calls: CreateCall[] = []
    const fakeLoader = {
      * entries() {},
      create: async (options: CreateCall) => { calls.push(options) },
      // SYNC-P3: the 0.1.7 mount channel inspects the entry/fiber face after
      // create (fail-closed when uncheckable) — the double models a created
      // entry whose fiber settles clean.
      resolve: (id: string) => ({ options: { name: '', id }, fiber: { await: async () => {} } }),
    }
    const ctx = new Context()
    contexts.push(ctx)
    void ctx.reflect.provide('loader', fakeLoader)

    // The three REAL seed rows (absolute sources), production postures kept:
    // verticals stays boot-off and must never reach create().
    const gateway = await bootGateway(ctx, writeRepoSeed([
      rowOf('core/webstack-verticals'),
      rowOf('core/omnivision'),
      rowOf('core/webstack-bridge'),
    ]))
    await gateway.settlePreinstall()

    // Seed file order, boot-enabled rows only: verticals never creates.
    expect(calls.map(call => call.id)).toEqual([
      'factory/core/omnivision',
      'factory/core/webstack-bridge',
    ])
    expect(calls.map(call => call.disabled)).toEqual([false, false])

    // M-F4 construction proof WITHOUT hard-coding: every recorded name equals
    // pathToFileURL(resolve(seed artifact dir, one of its OWN manifest's
    // declared factory paths)) — both inputs read back from the shipped seed
    // + admitted manifests, exactly like the production binding.
    for (const call of calls) {
      const row = REAL_SEED.entries.find(entry => `factory/${entry.id}` === call.id)
      expect(row, `create call for unknown seed row ${String(call.id)}`).toBeDefined()
      const sourceDir = absolutizeSource(row!)
      const factories = declaredFactories(sourceDir)
      expect(factories.length, `mount name: ${row!.id} declares no factory`).toBeGreaterThan(0)
      const expectedHrefs = factories.map(f => pathToFileURL(resolve(sourceDir, f)).href)
      expect(expectedHrefs).toContain(call.name)
      // Not a bare specifier, not a relative path: an absolute file URL (M-F4).
      expect(call.name.startsWith('file:///')).toBe(true)
    }

    // Ledger mount column over the same create calls (§9.4).
    const report = gateway.preinstallReport()
    expect(report.entries['core/webstack-verticals']?.mount?.status).toBe('skipped')
    expect(report.entries['core/webstack-verticals']?.mount?.reason).toMatch(/enabledAtBoot=false/)
    expect(report.entries['core/omnivision']?.mount?.status).toBe('mounted')
    expect(report.entries['core/webstack-bridge']?.mount?.status).toBe('mounted')
    for (const id of ['core/webstack-verticals', 'core/omnivision', 'core/webstack-bridge']) {
      expect(report.entries[id]?.status).toBe('installed')
    }
  })

  it('fail-open without any Loader on the context: failed mount rows, siblings and roster intact, pass settles', async () => {
    // The plain-context case the Q1-F2 deferral used to hide: admission stays
    // green, ONLY the mount column goes red, and the pass never throws (§9.4).
    const ctx = new Context()
    contexts.push(ctx)
    const gateway = await bootGateway(ctx, writeRepoSeed([
      rowOf('core/webstack-verticals'),
      rowOf('core/omnivision'),
      rowOf('core/webstack-bridge'),
    ]))
    await gateway.settlePreinstall()
    const report = gateway.preinstallReport()
    expect(report.entries['core/omnivision']?.status).toBe('installed')
    expect(report.entries['core/omnivision']?.mount?.status).toBe('failed')
    expect(report.entries['core/omnivision']?.mount?.reason).toMatch(/no Loader service/)
    expect(report.entries['core/webstack-bridge']?.mount?.status).toBe('failed')
    expect(report.entries['core/webstack-verticals']?.mount?.status).toBe('skipped')
    // Fail-open never连坐: every admitted artifact still holds its roster row.
    for (const id of ['core/webstack-verticals', 'core/omnivision', 'core/webstack-bridge']) {
      expect(gateway.list().plugins.some(plugin => plugin.pluginId === cid(id))).toBe(true)
    }
  })
})

// ============================================================================
// Real-loader track: genuine cordis Loader, tmpdir fixtures + the three
// real artifacts (bridge live smoke; verticals/omnivision expected red).
// ============================================================================

async function bootGatewayWithRealLoader(seedPath: string): Promise<{ ctx: Context; gateway: PluginGovernanceGateway }> {
  const ctx = new Context()
  contexts.push(ctx)
  const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  await ctx.plugin(Loader)
  const gateway = await bootGateway(ctx, seedPath)
  return { ctx, gateway }
}

describe('mount channel over the REAL cordis loader — tmpdir fixtures', () => {
  it('mounts a valid apply-module to LOADED and rejects a barrel as invalid plugin in the SAME pass (fail-open)', async () => {
    const validDir = fixturePlugin('@fixture/mount-valid', VALID_FIXTURE)
    const barrelDir = fixturePlugin('@fixture/mount-barrel', BARREL_FIXTURE)
    const { ctx, gateway } = await bootGatewayWithRealLoader(writeSeed([
      { id: 'fixture/mount-valid', package: '@fixture/mount-valid', version: '1.0.0', pin: 'e'.repeat(40), source: `local:${validDir}`, integrity: null, enabledAtBoot: true, family: 'fixture', failPolicy: 'fail-open' },
      { id: 'fixture/mount-barrel', package: '@fixture/mount-barrel', version: '1.0.0', pin: 'f'.repeat(40), source: `local:${barrelDir}`, integrity: null, enabledAtBoot: true, family: 'fixture', failPolicy: 'fail-open' },
    ]))
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    // ① valid fixture: entry LOADED through the real tree + ledger mounted.
    expect(report.entries['fixture/mount-valid']?.status).toBe('installed')
    expect(report.entries['fixture/mount-valid']?.mount?.status).toBe('mounted')
    const validEntry = ctx.loader.resolve('factory/fixture/mount-valid')
    expect(validEntry.options.name).toBe(pathToFileURL(join(validDir, 'index.js')).href)
    expect(validEntry.disabled).toBe(false)
    // Fiber actually reached ACTIVE (create awaited settle — 9.5-A① "entry
    // 达 LOADED"; FiberState is a const enum with no runtime object, the
    // host mirrors ACTIVE as the numeric 2 — see index.ts FIBER_ACTIVE).
    expect((validEntry.fiber as unknown as { state?: number } | undefined)?.state).toBe(2)

    // ② barrel fixture: create rejected with cordis `invalid plugin`, row
    // mounted:'failed' + reason — the pass continued (fail-open, §9.4).
    expect(report.entries['fixture/mount-barrel']?.status).toBe('installed')
    expect(report.entries['fixture/mount-barrel']?.mount?.status).toBe('failed')
    expect(report.entries['fixture/mount-barrel']?.mount?.reason).toMatch(/invalid plugin/)

    // ③ Sibling non-contamination at the roster level: exactly the two
    // admitted fixture rows; the mirror never ghost-registered a fileURL id.
    const fixturePlugins = gateway.list().plugins.filter(plugin => String(plugin.pluginId).startsWith('fixture/'))
    expect(fixturePlugins.map(plugin => String(plugin.pluginId)).sort()).toEqual(['fixture/mount-barrel', 'fixture/mount-valid'])
  })

  it('records skipped when the admitted manifest declares no service factory', async () => {
    const noFactoryDir = scratch()
    writeFileSync(join(noFactoryDir, 'package.json'), JSON.stringify({
      name: '@fixture/no-factory',
      version: '1.0.0',
      dsh: {
        autoApprove: true,
        compatible: '>=0.0.0',
        // A tool-only capability: admitted by the L3 pipeline, but the mount
        // channel finds no service.factory exit to resolve (§9.3: 无 factory
        // 声明返回空数组，该件视为无可装载出口，不 create).
        capabilities: [{ type: 'tool', tool: { name: 'no_factory_tool', description: 'fixture', schema: { type: 'object' } } }],
      },
    }))
    const { gateway } = await bootGatewayWithRealLoader(writeSeed([
      { id: 'fixture/no-factory', package: '@fixture/no-factory', version: '1.0.0', pin: 'a'.repeat(40), source: `local:${noFactoryDir}`, integrity: null, enabledAtBoot: true, family: 'fixture', failPolicy: 'fail-open' },
    ]))
    await gateway.settlePreinstall()
    const row = gateway.preinstallReport().entries['fixture/no-factory']
    expect(row?.status).toBe('installed')
    expect(row?.mount?.status).toBe('skipped')
    expect(row?.mount?.reason).toMatch(/no service factory/)
  })
})

describe('mount channel over the REAL cordis loader — the three real artifacts', () => {
  it('LIVE smoke (TC-B2-23A): bridge really mounts via ctx.loader.create and the bridge service resolves', async () => {
    const { ctx, gateway } = await bootGatewayWithRealLoader(writeRepoSeed([rowOf('core/webstack-bridge')]))
    await gateway.settlePreinstall()

    expect(gateway.preinstallReport().entries['core/webstack-bridge']?.status).toBe('installed')
    expect(gateway.preinstallReport().entries['core/webstack-bridge']?.mount?.status).toBe('mounted')
    expect(gateway.preinstallReport().entries['core/webstack-bridge']?.mount?.reason).toBeUndefined()

    // The live entry sits in the real tree under the channel id, and its
    // provided `bridge` service resolves off the context (V2 §5-1 non-fake).
    const entry = ctx.loader.resolve('factory/core/webstack-bridge')
    const sourceDir = absolutizeSource(rowOf('core/webstack-bridge'))
    expect(entry.options.name).toBe(pathToFileURL(resolve(sourceDir, declaredFactories(sourceDir)[0]!)).href)
    // The apply-side runtime actually came up: the named `bridge` service
    // the entry provided resolves off the real context (V2 §5-1 evidence).
    expect(ctx.get('bridge')).toBeTruthy()

    // Mirror discipline: no URL-derived ghost row entered the roster.
    expect(gateway.list().plugins.filter(plugin => String(plugin.pluginId).includes('file')).length).toBe(0)
  })

  it('翻正 (TC-B2-23D, was EXPECTED RED §9.5-A③): verticals + omnivision now mount through their B/C adapter exits', async () => {
    // Cards B (omnivision cordis-adapter) and C (verticals apply entry) shipped;
    // the re-pin put them under node_modules, so the two rows the A card left as
    // `failed` now settle `mounted`. verticals is exercised at the sandbox
    // forced posture (enabledAtBoot=true) to prove mountability — its PRODUCTION
    // seed row stays `false` (FIX9), asserted skipped in the fake-loader track
    // and the restart byte-identity below.
    const { ctx, gateway } = await bootGatewayWithRealLoader(writeRepoSeed([
      rowOf('core/webstack-verticals', { enabledAtBoot: true }),
      rowOf('core/omnivision'),
      rowOf('core/webstack-bridge'),
    ]))
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    // | core/webstack-verticals | installed | mount:mounted | (x-vertical resolves) |
    // | core/omnivision         | installed | mount:mounted | (entry reaches LOADED) |
    expect(report.entries['core/webstack-verticals']?.status).toBe('installed')
    expect(report.entries['core/webstack-verticals']?.mount?.status).toBe('mounted')
    expect(report.entries['core/webstack-verticals']?.mount?.reason).toBeUndefined()
    expect(report.entries['core/omnivision']?.status).toBe('installed')
    expect(report.entries['core/omnivision']?.mount?.status).toBe('mounted')
    expect(report.entries['core/omnivision']?.mount?.reason).toBeUndefined()
    // Sibling live evidence inside the same pass: fail-open 不连坐.
    expect(report.entries['core/webstack-bridge']?.mount?.status).toBe('mounted')
    // Entry LOADED (fiber ACTIVE=2) through the real tree, not just the ledger.
    for (const id of ['core/webstack-verticals', 'core/omnivision']) {
      const entry = ctx.loader.resolve(`factory/${id}`)
      expect((entry.fiber as unknown as { state?: number } | undefined)?.state, `${id} entry did not reach ACTIVE`).toBe(2)
    }
    // verticals' apply provides a real cordis service `x-vertical` that resolves
    // off the parent context (mirrors the bridge `bridge`-service smoke above).
    expect(ctx.get('x-vertical')).toBeTruthy()
    // NOTE (契约偏差, 回执 §9.5-D): omnivision's ported apply returns the plugin
    // and records it via `mountedFor(ctx)`; it registers NO cordis-named
    // service, so there is no `ctx.get('vision')` — the entry reaching ACTIVE
    // (asserted above) is its mount-success signal, and its capability face is
    // the P4 barrel probe (createOmnivisionPlugin / getTool). Gate-P P5 carries
    // the deeper omnivision capability + lifecycle checks.
    // Pass completed: all three admitted rows are in the roster.
    for (const id of ['core/webstack-verticals', 'core/omnivision', 'core/webstack-bridge']) {
      expect(gateway.list().plugins.some(plugin => plugin.pluginId === cid(id))).toBe(true)
    }
  })

  it('restart byte-identity covers the new mount column (gate-p P1 discipline)', async () => {
    const seedPath = writeRepoSeed([
      rowOf('core/webstack-verticals'),
      rowOf('core/omnivision'),
      rowOf('core/webstack-bridge'),
    ])
    const storageRoot = mkdtempSync(join(tmpdir(), 'gov-mount-home-'))
    storageRoots.push(storageRoot)
    const ledger = (root: string) => join(root, 'data', 'preinstall-results.json')

    const ctx1 = new Context()
    contexts.push(ctx1)
    const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
    await ctx1.plugin(Loader)
    const gateway1 = new PluginGovernanceGateway(ctx1, { storageRoot, seedPath })
    await (gateway1 as unknown as Record<symbol, () => Promise<void>>)[Service.init]!.call(gateway1 as never)
    await gateway1.settlePreinstall()
    const bytes1 = readFileSync(ledger(storageRoot), 'utf8')

    const ctx2 = new Context()
    contexts.push(ctx2)
    await ctx2.plugin(Loader)
    const gateway2 = new PluginGovernanceGateway(ctx2, { storageRoot, seedPath })
    await (gateway2 as unknown as Record<symbol, () => Promise<void>>)[Service.init]!.call(gateway2 as never)
    await gateway2.settlePreinstall()
    // 逐字节：mount 列（mounted/skipped+reason）重启后不得漂移。B/C 落地后
    // 生产三行的 mount 列 = verticals skipped（enabledAtBoot=false）+
    // omnivision/bridge mounted（TC-B2-23D 翻正，原 omnivision 为 failed）。
    expect(readFileSync(ledger(storageRoot), 'utf8')).toBe(bytes1)
    const parsed = JSON.parse(bytes1) as { entries: Record<string, { mount?: { status: string; at?: number } }> }
    expect(parsed.entries['core/webstack-verticals']?.mount?.status).toBe('skipped')
    expect(parsed.entries['core/omnivision']?.mount?.status).toBe('mounted')
    expect(parsed.entries['core/webstack-bridge']?.mount?.status).toBe('mounted')
    expect(typeof parsed.entries['core/webstack-bridge']?.mount?.at).toBe('number')
  })
})

// Guard: this suite's own premise — the real artifacts are on disk (the same
// existsSync lock gate-p P4 uses to pin "prebuilt-inclusive" trees red).
for (const id of ['core/webstack-verticals', 'core/omnivision', 'core/webstack-bridge']) {
  const dir = absolutizeSource(REAL_SEED.entries.find(entry => entry.id === id)!)
  for (const factory of declaredFactories(dir)) {
    if (!existsSync(resolve(dir, factory))) {
      throw new Error(`mount-channel premise: ${id} factory '${factory}' absent under ${dir}`)
    }
  }
}
