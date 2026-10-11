/**
 * TC-B4-RA1 — host-services fixture + RA-1 SANDBOX mount proof (DESIGN-intake-tech §10.4).
 *
 * Drives the REAL `loader.create` mount channel over SCRATCH seed rows forced
 * `enabledAtBoot:true` (since TC-B4-RA-2 the production seed itself boots
 * filehub + plugin-center true — and since TC-B4-W3 webstack too — the
 * scratch forcing below now matches the production posture rather than
 * diverging from it; the fixture remains the only harness providing the eight
 * real host services those rows need — the seventh inject `web` joined at
 * TC-B4-W3), to establish, honestly, which harness-honest rows can actually
 * activate once the host services are in place:
 *
 *  - `core/plugin-center`  → REACHES LOADED. `inject=[]` clears the cordis gate
 *    and its DYNAMIC `ctx.inject(['webServer'], …)` lands the full exact route
 *    table on the capture registrar. (①③)
 *  - `core/filehub`        → REACHES ACTIVE at bundle pin 6c3b570 (TC-B4-RP
 *    re-pin of the RA1c fix): its `apply` reads the optional `llm` service
 *    through the guarded `ctx.get('llm')` seam, which passes the no-inject
 *    production mount channel. Historically (pins ≤538a5b9) this row could NOT
 *    activate — `ctx.llm` was read undeclared and cordis hard-gated it — and
 *    the lock was a PERMANENT FAILURE-MODE assertion; TC-B4-RP upgraded it to
 *    the positive capability-surface proof below. (①②)
 *
 * What it locks (RA-1 acceptance):
 *  - ① both rows → ACTIVE + ledger `mount:'mounted'` + entry resolvable at
 *    fiber state 2; filehub additionally carries the full capability surface
 *    (read_document / list_workspace_files tools, the
 *    `filehub-document-reading` guidance section, the `/api/filehub` prefix
 *    route).
 *  - ② B01 anti-masking: FileHub's OWN real reading-tool DSL, pushed through
 *    the REAL validating registry (`assertSupportedJsonSchema`), is ACCEPTED —
 *    so no schema defect hides behind the mount path. The forged-node
 *    negatives that prove the registry genuinely validates live in ④ (a
 *    non-validating fake registry would accept them = the old B01 mask).
 *  - ③ plugin-center REACHES ACTIVE + ledger mounted (the RA-1 load-fidelity
 *    proof for its dynamic `ctx.inject(['webServer'])` path). RA-1b finding: PC
 *    mounts into a cordis plugin REALM whose route-table / handler state does
 *    not marshal back to the bare-harness root handle, so the in-process ROUTE
 *    HIT is NOT observable here — real route execution is DESIGN §10.7's
 *    batch-4.2 web-server smoke scope (recorded in the receipt).
 *  - ④ per-service discriminative pairs (positive AND negative), so no fixture
 *    provider can be an always-success stub.
 *  - ⑤ zero ports / zero HTTP listen / zero subprocess / zero network (the
 *    webServer is the DESIGN §10.6-3 capture-stub downgrade).
 *  - ⑥ M2: per-artifact literals live ONLY in this spec's probe data table and
 *    test bodies; the fixture body names no artifact (§10.6-6).
 *  - ⑦ the counterexample locks: bare harness (no services) or the broken
 *    tools/systemPrompt PAIR must keep the FileHub entry OUT of ACTIVE with no
 *    capabilities — the red line that makes "flip enabledAtBoot=true without
 *    the fixture" fail honestly instead of masking (RA-F3 close-out).
 *
 * Gate-M M1 (load-surface recheck, DESIGN §10.4 M1/RA-1 side): the dispose /
 * withdraw / remount lifecycle is proven on plugin-center (dynamic-injected
 * routes) and — since the TC-B4-RP2 re-pin (aab73d7, the RA1d fix) — on
 * filehub at BOTH halves: traceable facets and the domain-owned prefix route
 * withdraw on dispose, and a clean remount restores the full surface. The
 * RA1d defect this now guards against: any regression that again leaves
 * domain disposal unwired (route leak / duplicate-route crash on remount)
 * turns this leg red.
 *
 * ➡➡➡ REGRESSION GATE — the filehub mount leg was a PERMANENT FAILURE-MODE
 * LOCK until pin 6c3b570 (RA1c guarded `ctx.get` seam + TC-B4-RP re-pin)
 * flipped it to the positive ACTIVE proof; the M1 disposal leg flipped
 * positive at pin aab73d7 (RA1d effect-contract wiring + TC-B4-RP2 re-pin).
 * If FileHub EVER again reads an undeclared service in `apply`, removes the
 * guarded seam, or leaves domain disposal unwired — the mount flips back to
 * `failed`, or the route leaks past dispose and the remount crashes — and
 * this spec goes red. That red is the defect asserting itself; fix the
 * plugin or the pin, never the assertion.
 *
 * ── TC-O3 (the workbench production-posture leg, it count 9→10): since O3 the
 * production seed carries `core/workbench` enabledAtBoot=true (the user's O-3
 * ruling「默认安装可停用」), so the new leg runs the row UNOVERRIDDEN (webstack
 * W3 leg precedent): ACTIVE + ledger mounted + the four-face route family
 * (api prefix / file media / events SSE / the terminal ws upgrade through the
 * fixture's new `registerUpgrade` capture face) observed on the registrar,
 * then the M1 half locking fiber-dispose withdrawal of every face (RA1d
 * criterion, fourth plugin family — phase-1 wired pty disposeAll / watchers
 * closeAll / ledger unsubscribe through the effect double-arrow form) and a
 * clean remount restoring the surface. The leg stubs DSH_BRANCH_HOME to a
 * scratch dir (the pinned tree's TaskLedger derives its storage root from that
 * env) and the shared afterEach hook gained `vi.unstubAllEnvs()` for it.
 * Fixture side (registerUpgrade 扩面理由): the real host webserver owns an
 * exact-path HTTP-upgrade face (`registerUpgrade` / WebUpgradeRoute); the
 * artifact's ws route registers through it, so without a capture method the
 * mount effect would throw and the fiber could never reach ACTIVE. The fixture
 * stays M2-generic: it mirrors the documented contract (runtime duplicate
 * rejection + the type contract promoted to runtime validation, the register
 * precedent) and names no artifact.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId } from '../../../core/session/src/types.ts'
import PluginGovernanceGateway from '../../plugin-governance-host/src/index.ts'
import { provideHostServices, type HostServicesFixture, type WebServerRouteCapture } from './host-services-fixture.ts'

const storageRoots: string[] = []
const scratchDirs: string[] = []
const contexts: Context[] = []
const repoSeedFiles: string[] = []
let mountSeedSeq = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of storageRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const file of repoSeedFiles.splice(0)) rmSync(file, { force: true })
  // TC-O3 (扩展既有钩子，非新建)：workbench 腿以 vi.stubEnv 隔离 TaskLedger 存储根
  // （DSH_BRANCH_HOME env 派生，task-ledger.ts defaultFilePath），此处统一还原，防
  // 泄漏进后续腿或写真实 HOME。置于 fiber dispose 之后＝teardown 期 env 读仍见 scratch。
  vi.unstubAllEnvs()
})

// The repository's frozen factory seed is the single source of truth for the
// sandbox rows' fixture fields too (same discipline as gate-p, which stays
// byte-identical: this file never edits it).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SEED_PATH = join(REPO_ROOT, 'zdsh-factory', 'seed.json')

interface FullSeedRow {
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
const FULL_SEED = (JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { entries: FullSeedRow[] }).entries

/** Resolve a seed row's `local:` artifact directory, rejecting other states. */
function localSourceDir(row: FullSeedRow): string {
  if (!row.source.startsWith('local:')) {
    throw new Error(`RA-1: seed row ${row.id} declares a non-local source (${row.source})`)
  }
  return resolve(REPO_ROOT, row.source.slice('local:'.length))
}

/** A throwaway directory registered for cleanup. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ra1-scratch-'))
  scratchDirs.push(dir)
  return dir
}

/** Copy a real seed row onto its absolute in-repo `local:` source (with overrides). */
function mountRow(id: string, overrides: Partial<FullSeedRow> = {}): FullSeedRow {
  const base = FULL_SEED.find(entry => entry.id === id)
  if (base === undefined) throw new Error(`RA-1: seed is missing the ${id} row`)
  const merged = { ...base, ...overrides }
  return { ...merged, source: `local:${localSourceDir(merged)}` }
}

/**
 * A seed document over given rows. F7 fixture root-posture migration
 * (TC-B4-H1 face 6, gate-p homologous): mountRow rows carry ABSOLUTE in-repo
 * `local:` sources, which the containment gate only accepts when
 * repoRoot=REPO_ROOT — exactly what deriveRepoRoot gives for a seed under
 * `<REPO_ROOT>/zdsh-factory/`. The REAL seed.json is never touched; the temp
 * file is PID-keyed and removed in afterEach (a worker killed mid-test would
 * leave a visible untracked residue under zdsh-factory/ — delete it by hand;
 * it never merges silently).
 */
function writeMountSeed(rows: FullSeedRow[]): string {
  const path = join(REPO_ROOT, 'zdsh-factory', `seed.ra1-fixture-${process.pid}-${mountSeedSeq++}.json`)
  repoSeedFiles.push(path)
  writeFileSync(path, JSON.stringify({ version: 1, entries: rows }))
  return path
}

/** Read one row's first declared service factory as a file URL (manifest-driven). */
function firstFactoryHref(row: FullSeedRow): string {
  const sourceDir = localSourceDir(row)
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as {
    dsh?: { capabilities?: Array<{ service?: { factory?: string } }> }
  }
  const factory = (manifest.dsh?.capabilities ?? [])
    .map(cap => cap.service?.factory)
    .find((f): f is string => typeof f === 'string' && f.length > 0)
  if (factory === undefined) throw new Error(`RA-1: ${row.id} declares no service factory`)
  return pathToFileURL(resolve(sourceDir, factory)).href
}

/** `ctx.get` for a service that may throw when absent (cordis unresolvable). */
function tryGet(ctx: Context, name: string): unknown {
  try {
    return (ctx as unknown as { get: (n: string) => unknown }).get(name)
  } catch {
    return undefined
  }
}

/** The fiber-state view of one mounted loader entry (ACTIVE === 2). */
function entryState(ctx: Context, channelId: string): number | undefined {
  const entry = (ctx as unknown as {
    loader: { resolve: (id: string) => { fiber?: unknown } }
  }).loader.resolve(channelId)
  return (entry.fiber as { state?: number } | undefined)?.state
}

/**
 * Settle one entry the spec remounted through a direct `loader.create`
 * (SYNC-P3): 0.1.7 create resolves on fiber CREATION — the apply seam is
 * awaited separately, the directory-picker-auto idiom.
 */
async function settleEntry(
  loader: { resolve: (id: string) => { fiber?: { await?: () => Promise<unknown> } } },
  channelId: string,
): Promise<void> {
  await loader.resolve(channelId).fiber?.await?.()
}

/** Boot the REAL mount harness: Loader + host-services fixture + gateway. */
async function bootWithServices(
  seedPath: string,
  options: { omit?: readonly string[] } = {},
): Promise<{ ctx: Context; gateway: PluginGovernanceGateway; fx: HostServicesFixture }> {
  const ctx = new Context()
  contexts.push(ctx)
  const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  await ctx.plugin(Loader)
  const fx = await provideHostServices(ctx, { storageRoot: scratch(), ...options })
  const storageRoot = mkdtempSync(join(tmpdir(), 'ra1-home-'))
  storageRoots.push(storageRoot)
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot, seedPath })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return { ctx, gateway, fx }
}

/** Boot the harness WITHOUT any host services (counterexample leg). */
async function bootBare(seedPath: string): Promise<{ ctx: Context; gateway: PluginGovernanceGateway }> {
  const ctx = new Context()
  contexts.push(ctx)
  const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  await ctx.plugin(Loader)
  const storageRoot = mkdtempSync(join(tmpdir(), 'ra1-home-'))
  storageRoots.push(storageRoot)
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot, seedPath })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return { ctx, gateway }
}

// ---------------------------------------------------------------------------
// Per-artifact capability probes (M2 §10.6-6: artifact literals ONLY here).
// ---------------------------------------------------------------------------

interface ProbeArgs {
  ctx: Context
  row: FullSeedRow
  fx: HostServicesFixture
}

type Ra1MountProbe = (args: ProbeArgs) => void | Promise<void>

// The success-path mount probes for boot-enabled rows. `core/plugin-center`
// (below) and — since the TC-B4-RP re-pin to 6c3b570 — `core/filehub` (whose
// capability-surface proof lives directly in the ①② test body and the M1
// filehub leg, both richer than a probe-table entry needs to be).
const RA1_MOUNT_PROBES: Record<string, Ra1MountProbe> = {
  // PluginCenter: `inject=[]` clears the cordis hard gate and it activates to
  // ACTIVE(state 2) with ledger `mount:'mounted'` once the host services are in
  // place — that IS the RA-1 load-fidelity proof for PC (its DYNAMIC
  // `ctx.inject(['webServer'], …)` ran during `apply` without erroring the
  // mount, which the ACTIVE state already establishes).
  //
  // ⚠ RA-1b finding (recorded in the receipt): PC's routes are registered into
  // a cordis plugin REALM whose service-instance state does NOT marshal back to
  // the bare-harness spec's root `fx.webServer` handle, so the route TABLE /
  // in-process HIT are not observable from this unit harness. Full route
  // EXECUTION (a real HTTP hit on /api2/…) is DESIGN §10.7's batch-4.2
  // web-server smoke scope, not this card's. Asserting it here on the capture
  // registrar would be an unverifiable green (the registrations never land on
  // the object the reader checks), so we prove only what the harness can see.
  'core/plugin-center': async ({ ctx, fx }) => {
    expect(entryState(ctx, 'factory/core/plugin-center'), 'RA-1: plugin-center entry not ACTIVE under the fixture').toBe(2)
    // The webServer host service is in place and the dynamic injection did not
    // throw the entry out of ACTIVE (state===2 above already proves apply ran to
    // completion); this asserts the handle the factory composed against exists.
    expect(fx.webServer, 'RA-1: fixture webServer missing (PC had no host webServer to inject)').toBeTruthy()
  },
}

// ---------------------------------------------------------------------------
// RA-1 proof
// ---------------------------------------------------------------------------

describe('RA-1 sandbox mount proof (fixture + real loader.create; fixture is the only eight-service harness)', () => {
  // plugin-center honestly reaches LOADED under the fixture: `inject=[]` clears
  // the cordis hard gate and its DYNAMIC `ctx.inject(['webServer'], …)` lands
  // the full exact route table on the capture registrar (③).
  it('plugin-center reaches ACTIVE with live capabilities under the fixture (①③)', async () => {
    const { ctx, gateway, fx } = await bootWithServices(writeMountSeed([
      mountRow('core/plugin-center', { enabledAtBoot: true }),
    ]))
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    expect(report.entries['core/plugin-center']?.status).toBe('installed')
    expect(report.entries['core/plugin-center']?.mount?.status, 'RA-1: plugin-center must mount under the fixture').toBe('mounted')
    await RA1_MOUNT_PROBES['core/plugin-center']!({ ctx, row: FULL_SEED.find(row => row.id === 'core/plugin-center')!, fx })
  })

  // ── UPGRADED POSITIVE MOUNT PROOF (was the PERMANENT FAILURE-MODE LOCK) ────
  // ① FileHub, re-pinned to 6c3b570 (TC-B4-RP). The old pin read `ctx.llm`
  // in `apply` WITHOUT declaring `llm` in its `inject` list, and cordis gates
  // property reads on that declaration (vendor/cordis reflect.ts:144 `cannot
  // get property "llm" without inject`, independent of the ancestor fiber
  // store) — so the honest factory path could NOT activate FileHub, and the
  // lock below pinned that terminal state. The 〔源〕 RA1c fix (6c3b570) reads
  // the optional service through the guarded `ctx.get('llm')` seam
  // (`typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm`) instead,
  // which passes the production mount channel (`host.mount` →
  // `loader.create({name, id, disabled})` — still NO inject) and mounts to
  // ACTIVE even though the fixture provides `llm` only as a real ancestor
  // service. This leg is now the positive mirror: FULL capability surface
  // live (tools + guidance section + prefix route).
  // The NEW regression gate this assertion carries: if FileHub ever again
  // reads an undeclared service in `apply` (or the guarded seam is removed),
  // the mount flips back to `failed` and this test goes red — the exact
  // failure mode the pre-RP lock used to pin. Do not weaken either side.
  it('filehub reaches ACTIVE with full capability surface under the fixture (①, upgraded at re-pin 6c3b570)', async () => {
    const { ctx, gateway, fx } = await bootWithServices(writeMountSeed([
      mountRow('core/filehub', { enabledAtBoot: true }),
    ]))
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    expect(report.entries['core/filehub']?.status, 'RA-1: filehub admission regressed').toBe('installed')
    expect(report.entries['core/filehub']?.mount?.status, 'RA-1: filehub must mount under the fixture at pin 6c3b570 (guarded llm seam)').toBe('mounted')
    // ACTIVE on the tree: the fiber settles, so resolve works and reports 2.
    expect(entryState(ctx, 'factory/core/filehub'), 'RA-1: filehub entry not ACTIVE at pin 6c3b570').toBe(2)
    // Full capability surface live — the same four facets the old no-leak lock
    // asserted ABSENT when the mount failed (they leaked nowhere then; they
    // must be PRESENT now that the mount succeeds).
    expect(fx.tools!.get('read_document'), 'RA-1: mounted filehub did not register read_document').toBeDefined()
    expect(fx.tools!.get('list_workspace_files'), 'RA-1: mounted filehub did not register list_workspace_files').toBeDefined()
    expect((await fx.systemPrompt!.assemble()).sections.some(s => s.name === 'filehub-document-reading'),
      'RA-1: mounted filehub guidance section absent').toBe(true)
    expect(fx.webServer!.find('prefix', '/api/filehub'), 'RA-1: mounted filehub prefix route absent').toBeDefined()
    const readDoc = fx.tools!.get('read_document') as { output?: { schema?: { type?: unknown } } } | undefined
    expect(readDoc?.output?.schema?.type, 'RA-1: mounted read_document output schema is not host-normalized object-rooted').toBe('object')
  })

  // ② B01 ANTI-MASKING, DECOUPLED onto a fresh fixture boot (empty seed): the
  // mounted filehub of ① already registered its tools, so the direct
  // registerReadingTools pass runs on its OWN boot — pushing FileHub's OWN
  // real reading-tool DSL through the REAL validating registry (the very
  // `assertSupportedJsonSchema` path the pre-B01 non-validating fake registry
  // skipped) must SUCCEED, so no schema defect hides behind the mount path.
  // The forged-node NEGATIVES that prove this registry is genuinely
  // validating live in ④.
  it('B01 anti-masking: filehub real reading-tool DSL passes the real validating registry (②)', async () => {
    const { fx } = await bootWithServices(writeMountSeed([]))
    const fh = (await import(firstFactoryHref(mountRow('core/filehub')))) as {
      registerReadingTools(deps: unknown): Array<() => void>
    }
    expect(typeof fh.registerReadingTools, 'RA-1: filehub factory no longer exports registerReadingTools (② anchor drifted)').toBe('function')
    const disposers = fh.registerReadingTools({ tools: fx.tools, systemPrompt: fx.systemPrompt })
    try {
      expect(fx.tools!.get('read_document'), 'RA-1 B01: real registry rejected filehub read_document DSL').toBeDefined()
      expect(fx.tools!.get('list_workspace_files'), 'RA-1 B01: real registry rejected filehub list_workspace_files DSL').toBeDefined()
      const readDoc = fx.tools!.get('read_document') as { output?: { schema?: { type?: unknown } } } | undefined
      expect(readDoc?.output?.schema?.type, 'RA-1 B01: read_document output schema is not host-normalized object-rooted').toBe('object')
      expect((await fx.systemPrompt!.assemble()).sections.some(s => s.name === 'filehub-document-reading'),
        'RA-1 B01: filehub guidance section absent after a direct real-registry register').toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })


  it('per-service discriminative pairs — no provider is an always-success stub (④)', async () => {
    const { fx } = await bootWithServices(writeMountSeed([]))
    // The `&&` short-circuit yields the LAST operand (a cordis Service proxy),
    // never a boolean — so assert the seven-service completeness as a plain
    // boolean array to keep the failure message renderable (a raw object under
    // `toBe(true)` makes vitest pretty-print the proxy and crash on `$$typeof`).
    expect(
      [fx.tools, fx.systemPrompt, fx.sessions, fx.storage, fx.fs, fx.webServer, fx.llm, fx.web]
        .every(service => service !== undefined),
      'RA-1: full eight-service fixture (seven inject + the empirically-required llm) must resolve complete',
    ).toBe(true)
    const webServer = fx.webServer as WebServerRouteCapture

    // tools：真注册器收真形制（正）；具 B01 形态的伪造 DSL 必须抛（负）。
    const forgedJsonNode = {
      name: 'ra1_forged_json_node', description: 'forged', parameters: { type: 'object' },
      output: { schema: { type: 'object', properties: { x: { type: 'json' } } }, render: () => [] },
      execute: async () => ({}),
    }
    expect(() => fx.tools!.register(forgedJsonNode as never),
      'RA-1: real tools registry accepted a B01-form type:"json" node (non-validating stub escape)')
      .toThrow()
    const forgedRequiredFlag = {
      name: 'ra1_forged_required_flag', description: 'forged', parameters: { type: 'object' },
      output: { schema: { type: 'object', properties: { x: { type: 'string', required: true } } }, render: () => [] },
      execute: async () => ({}),
    }
    expect(() => fx.tools!.register(forgedRequiredFlag as never),
      'RA-1: real tools registry accepted a per-property required:true flag')
      .toThrow()
    // 对照登记：假桩「照收一切」——正是 B01 掩盖形态，上方两抛即其回归闸。
    const naiveRegistry: { register(definition: unknown): () => void } = { register: () => () => {} }
    expect(() => naiveRegistry.register(forgedJsonNode)).not.toThrow()

    // systemPrompt：非法 order 必拒（负）；合法注册可观测（正）。
    expect(() => fx.systemPrompt!.section({ name: 'ra1_bad_order', order: Number.POSITIVE_INFINITY, text: 'x' }),
      'RA-1: real prompt service accepted a non-finite section order').toThrow()
    const disposeSection = fx.systemPrompt!.section({ name: 'ra1_probe_section', order: 77, text: 'probe' })
    const assembly = await fx.systemPrompt!.assemble()
    expect(assembly.sections.some(section => section.name === 'ra1_probe_section')).toBe(true)
    disposeSection()
    expect((await fx.systemPrompt!.assemble()).sections.some(section => section.name === 'ra1_probe_section')).toBe(false)

    // webServer 捕获桩：坏输入必拒、好输入入表、disposer 生效。
    expect(() => webServer.register({ kind: 'regex', path: '/ra1/bad-kind', handler: () => {} })).toThrow()
    expect(() => webServer.register({ kind: 'exact', path: 'ra1/relative', handler: () => {} })).toThrow()
    expect(() => webServer.register({ kind: 'exact', path: '/ra1/no-handler' })).toThrow()
    const good = { kind: 'exact' as const, path: '/ra1/capture', handler: () => {} }
    const disposeRoute = webServer.register(good)
    expect(webServer.find('exact', '/ra1/capture')).toBeDefined()
    disposeRoute()
    expect(webServer.find('exact', '/ra1/capture'), 'RA-1: disposer did not withdraw the route').toBeUndefined()
    // 重复 (kind,path) 与真 WebServer 同型必拒。
    const again = webServer.register(good)
    expect(() => webServer.register(good)).toThrow()
    again()

    // registerUpgrade 捕获面（TC-O3 扩既有 it，循上方 register 五连形制）：坏 path
    // 必拒（相对形 + 尾斜杠形）、非函数 handler 必拒、好输入入表+findUpgrade 可观测、
    // disposer 撤回、重复 path 拒——镜像真 WebServer.registerUpgrade 文档化契约
    // （运行时仅重复拒；绝对无尾斜杠/handler 函数签名=WebUpgradeRoute 类型契约在
    // fixture 面升为运行时校验，register 既有先例同款）。
    expect(() => webServer.registerUpgrade({ path: 'ra1/relative-ws', handler: () => {} })).toThrow()
    expect(() => webServer.registerUpgrade({ path: '/ra1/trailing-slash/', handler: () => {} })).toThrow()
    expect(() => webServer.registerUpgrade({ path: '/ra1/no-handler-ws' })).toThrow()
    const goodUpgrade = { path: '/ra1/capture-ws', handler: () => {} }
    const disposeUpgrade = webServer.registerUpgrade(goodUpgrade)
    expect(webServer.findUpgrade('/ra1/capture-ws')).toBeDefined()
    disposeUpgrade()
    expect(webServer.findUpgrade('/ra1/capture-ws'), 'RA-1: upgrade disposer did not withdraw the route').toBeUndefined()
    // 重复 path 与真 WebServer 同型必拒（一 socket 一协议 owner）。
    const againUpgrade = webServer.registerUpgrade(goodUpgrade)
    expect(() => webServer.registerUpgrade(goodUpgrade)).toThrow()
    againUpgrade()

    // storage：KV 写→读回同一 unit（正），跨 reopen 持久（出厂分支实证）。
    const kv = fx.storage!.backend.get('json').kv!
    const unit = await kv.open({ name: 'ra1_probe', version: 1, tables: ['data'], hasGlobal: false })
    await unit.putRecord('data', 'k1', { v: 7 })
    expect(((await unit.loadAll()) as unknown as { tables: { data: Record<string, unknown> } }).tables.data.k1).toEqual({ v: 7 })
    await unit.close()
    const reopened = await kv.open({ name: 'ra1_probe', version: 1, tables: ['data'], hasGlobal: false })
    expect(((await reopened.loadAll()) as unknown as { tables: { data: Record<string, unknown> } }).tables.data.k1, 'RA-1: KV record did not survive the unit reopen').toEqual({ v: 7 })
    await reopened.close()
    await expect(kv.open({ name: 'RA1-Bad', version: 1, tables: ['data'], hasGlobal: false }),
      'RA-1: KV accepted a malformed unit name').rejects.toThrow()

    // sessions：合法 session（tmpdir cwd）可 resolve（正）；未知 id 与非法 meta（负）。
    const home = scratch()
    const sessionId = SessionId('ra1-known')
    fx.sessions!.create(sessionId, { meta: { cwd: home } })
    expect(fx.sessions!.get(sessionId)?.header.cwd, 'RA-1: session header cwd did not round-trip').toBe(home)
    expect(fx.sessions!.get(SessionId('ra1-never-created'))).toBeUndefined()
    expect(() => fx.sessions!.create(SessionId('ra1-relative'), { meta: { cwd: 'relative/path' } }),
      'RA-1: sessions accepted a non-absolute cwd header').toThrow()

    // fs：真 provider 在场且可用（RA-F1 销案：解析期占位 + 真实例，见回执）。
    expect(fx.fs, 'RA-1: fs service missing').toBeTruthy()
    const resolved = await (fx.fs as { resolve(p: string, o?: unknown): Promise<{ targetKey: unknown }> })
      .resolve('package.json', { cwd: REPO_ROOT })
    expect(resolved.targetKey).toBeTruthy()
  })

  it('counterexample locks: bare harness and broken pair can NEVER be a green mount (⑦)', async () => {
    // (A) 全撤六服务：今天的「裸翻 true」实况——装载不达 ACTIVE。
    const bare = await bootBare(writeMountSeed([mountRow('core/filehub', { enabledAtBoot: true })]))
    await bare.gateway.settlePreinstall()
    expect(
      entryState(bare.ctx, 'factory/core/filehub'),
      'RA-1 counterexample A: filehub reached ACTIVE without any host service (false green)',
    ).not.toBe(2)
    expect(tryGet(bare.ctx, 'tools'), 'RA-1 counterexample A: tools materialized out of nothing').toBeUndefined()
    // RA-F3 精确失败模式销案（实证登记）：create 不 reject、台账仍写 mounted——
    // 唯一可靠红灯是 entryState≠2 + 能力面缺席；断言锁死该语义防 cordis 漂移。
    expect(
      bare.gateway.preinstallReport().entries['core/filehub']?.mount?.status,
      'RA-1 counterexample A: the ledger dimension drifted from the observed fail-open settle semantics',
    ).toBe('mounted')

    // (B) 成对铁律回归锁：只撤 tools（systemPrompt 等其余五件在场）。
    const noTools = await bootWithServices(
      writeMountSeed([mountRow('core/filehub', { enabledAtBoot: true })]),
      { omit: ['tools'] },
    )
    await noTools.gateway.settlePreinstall()
    expect(
      entryState(noTools.ctx, 'factory/core/filehub'),
      'RA-1 counterexample B: filehub mounted with the tools side of the pair withdrawn',
    ).not.toBe(2)
    // 静默跳过必须可见为「未注册」：prompt 侧成对分支没跑，section 不得出现。
    const assembly = await noTools.fx.systemPrompt!.assemble()
    expect(
      assembly.sections.some(section => section.name === 'filehub-document-reading'),
      'RA-1 counterexample B: guidance section appeared while the read-tool branch must have skipped',
    ).toBe(false)
    expect(noTools.fx.webServer!.find('prefix', '/api/filehub'),
      'RA-1 counterexample B: route registered although the apply must never have run').toBeUndefined()
  })

  // M1 load-surface recheck (DESIGN §10.4 M1, RA-1 side), on BOTH rows that
  // activate — plugin-center (dynamic-injected routes; the "no orphan
  // registration" facet rides on PC's injected routes, which per the RA-1b
  // finding in the ③ probe comment live in a plugin realm the bare harness
  // cannot read, so the real route-disposer orphan check is deferred to the
  // batch-4.2 web-server smoke) and, since the TC-B4-RP re-pin to 6c3b570,
  // filehub: its capability surface (tools / guidance section / prefix route)
  // IS visible on the fixture root, so dispose must withdraw exactly those
  // four facets and remount must restore them.
  it('M1 load-surface recheck on plugin-center: dispose withdraws the entry, remount restores (Gate-M 并入)', async () => {
    const { ctx, gateway } = await bootWithServices(writeMountSeed([
      mountRow('core/plugin-center', { enabledAtBoot: true }),
    ]))
    await gateway.settlePreinstall()
    const pcChannel = 'factory/core/plugin-center'
    expect(entryState(ctx, pcChannel), 'M1: plugin-center not ACTIVE before dispose').toBe(2)

    const loader = (ctx as unknown as {
      loader: {
        resolve: (id: string) => { fiber?: { state?: number; dispose?: () => unknown; await?: () => Promise<unknown> } }
        create: (o: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
      }
    }).loader
    // entryState throws for an unresolvable id; treat that as "not ACTIVE".
    const stateOrGone = (): number | undefined => {
      try { return entryState(ctx, pcChannel) } catch { return undefined }
    }

    await loader.resolve(pcChannel).fiber?.dispose?.()
    expect(stateOrGone(), 'M1: plugin-center still ACTIVE after dispose').not.toBe(2)

    // remount through the SAME real loader.create channel → ACTIVE again.
    await loader.create({ name: firstFactoryHref(mountRow('core/plugin-center')), id: pcChannel, disabled: false })
    await settleEntry(loader, pcChannel)
    expect(entryState(ctx, pcChannel), 'M1: plugin-center did not come back after remount').toBe(2)
  })

  // M1 filehub leg — UPGRADED AT TC-B4-RP2 (re-pin aab73d7 = the RA1d fix).
  // History: pins ≤6c3b570 returned a domain OBJECT from `apply`; cordis's
  // constructor path (isConstructor=true → `new callback(ctx, config)` → only
  // `instance[symbols.init]?.()` collected, vendor/cordis fiber.ts:251-257)
  // silently dropped it, so `domain.dispose()` never ran on fiber disposal:
  // traceable-service facets (tools/prompt) withdrew, the webServer prefix
  // route LEAKED, and a remount died on the duplicate-route rejection. RA1d
  // (FileHub aab73d7) wires `ctx.effect(() => () => domain.dispose(), …)` —
  // the effect-contract form where the setup's RETURN is the unload disposer
  // — so the full capability surface now withdraws on dispose and the
  // remount cycle is clean. This leg is the positive mirror of both old
  // locks: full withdrawal + clean remount + surface restored.

  // ── TC-B3-33C3c: autopilot sandbox boot leg (production seed stays
  // enabledAtBoot=false — ADJ-3 product-design-off; this leg mirrors the
  // verticals P5 sandbox-forced-mount precedent). AP's `inject=[]` clears the
  // cordis gate, so the entry reaches ACTIVE in this fixture; its dual route
  // disposers (33C3b wired them through ctx.effect in the FileHub aab73d7
  // double-arrow form + the MountedRuntime.dispose fallback) must withdraw
  // both HTTP routes on fiber dispose — the RA1d criterion applied to the
  // second plugin family. The approval/request answerer (33C3a) is an event
  // listener on the fixture context, not an observable service; its behavior
  // is locked in AutoPilot's own spec on a real cordis bus.
  it('autopilot sandbox boot: ACTIVE under the fixture, routes withdraw on dispose (33C3c)', async () => {
    const { ctx, gateway, fx } = await bootWithServices(writeMountSeed([
      mountRow('core/autopilot', { enabledAtBoot: true }),
    ]))
    await gateway.settlePreinstall()
    const apChannel = 'factory/core/autopilot'
    expect(gateway.preinstallReport().entries['core/autopilot']?.mount?.status,
      'RA-1: autopilot must mount under the fixture at pin 89d923d00e (inject=[] clears the gate)').toBe('mounted')
    expect(entryState(ctx, apChannel), 'RA-1: autopilot entry not ACTIVE in the sandbox boot').toBe(2)
    // The 33C3b bridge routes live on the fixture's capture registrar once
    // the host webServer service is present (AP registers them when the
    // service resolves; the fixture provides it).
    expect(fx.webServer!.find('exact', '/api/autopilot-action'), 'RA-1: autopilot action route absent after sandbox boot').toBeDefined()
    expect(fx.webServer!.find('exact', '/api/autopilot-bridge'), 'RA-1: autopilot bridge route absent after sandbox boot').toBeDefined()

    const loader = (ctx as unknown as {
      loader: {
        resolve: (id: string) => { fiber?: { state?: number; dispose?: () => unknown; await?: () => Promise<unknown> } }
        create: (o: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
      }
    }).loader
    const stateOrGone = (): number | undefined => {
      try { return entryState(ctx, apChannel) } catch { return undefined }
    }
    await loader.resolve(apChannel).fiber?.dispose?.()
    expect(stateOrGone(), 'M1: autopilot still ACTIVE after dispose').not.toBe(2)
    // RA1d criterion, AP leg: the ctx.effect wiring (33C3b) must withdraw
    // both routes on dispose — a leak here re-opens the constructor-path
    // disposal defect for the second plugin family.
    expect(fx.webServer!.find('exact', '/api/autopilot-action'), 'M1 RA1d: dispose leaked the autopilot action route').toBeUndefined()
    expect(fx.webServer!.find('exact', '/api/autopilot-bridge'), 'M1 RA1d: dispose leaked the autopilot bridge route').toBeUndefined()

    await loader.create({ name: firstFactoryHref(mountRow('core/autopilot')), id: apChannel, disabled: false })
    await settleEntry(loader, apChannel)
    expect(entryState(ctx, apChannel), 'M1: autopilot did not come back after remount').toBe(2)
    expect(fx.webServer!.find('exact', '/api/autopilot-action'), 'M1: action route not restored after remount').toBeDefined()
    expect(fx.webServer!.find('exact', '/api/autopilot-bridge'), 'M1: bridge route not restored after remount').toBeDefined()
  })

  // ── TC-B4-W3: webstack production-posture boot leg. The production seed
  // itself carries enabledAtBoot=true since W3 (W-DEC ruling: the three tools
  // go live off the box while the coexist data plane stays dormant behind the
  // host's pinned selectors), so this leg runs the row UNOVERRIDDEN — scratch
  // posture and production posture are the same. `inject=['web']` is
  // satisfied by the fixture's eighth service (the real WebRuntime mounted
  // with the host production selectors; zero init side effects).
  //
  // RA1d-criterion check (result recorded in the W3 receipt): webstack's
  // apply side-effect surface is ENTIRELY fiber-managed host services — the
  // three tool registrations on the real ToolRuntime and the dual provider
  // registrations on WebRuntime (whose registerProvider binds disposal to
  // the CALLING fiber through ctx.effect) — with no domain-owned
  // timers/routes/sweeps started at mount time, so there is no plugin-side
  // disposer for the effect contract to wire. The M1 half below locks exactly
  // that claim: dispose must withdraw EVERY facet and remount must restore
  // it — a leak would mean some side effect escaped fiber management
  // (re-opening the RA1d class for this family).
  //
  // The tools registration itself is the F2 fix's factory-level true-host
  // smoke: the pre-W1 lib carried a root-level `required` array that throws
  // inside the real assertSupportedJsonSchema at registration, which would
  // flip this mount to failed — this leg is that regression gate.
  it('webstack reaches ACTIVE at the production posture with three tools + dual web providers; dispose withdraws the fiber-scoped surface (W3)', async () => {
    const { ctx, gateway, fx } = await bootWithServices(writeMountSeed([
      mountRow('core/webstack'),
    ]))
    await gateway.settlePreinstall()
    const wsChannel = 'factory/core/webstack'
    const report = gateway.preinstallReport()
    expect(report.entries['core/webstack']?.status, 'RA-1 W3: webstack admission regressed').toBe('installed')
    expect(report.entries['core/webstack']?.mount?.status, 'RA-1 W3: webstack must mount under the fixture (inject=[web] satisfied)').toBe('mounted')
    expect(entryState(ctx, wsChannel), 'RA-1 W3: webstack entry not ACTIVE under the fixture').toBe(2)

    // Three tools registered through the REAL validating registry (the F2
    // fix's factory-level smoke — the old root-level-required schema threw
    // here and flipped the mount to failed).
    for (const tool of ['web_backend_status', 'web_batch_search', 'web_history']) {
      expect(fx.tools!.get(tool), `RA-1 W3: mounted webstack did not register ${tool}`).toBeDefined()
    }
    const statusTool = fx.tools!.get('web_backend_status') as { output?: { schema?: { type?: unknown } } } | undefined
    expect(statusTool?.output?.schema?.type, 'RA-1 W3: web_backend_status output schema is not host-normalized object-rooted').toBe('object')

    // Dual provider registration on the real WebRuntime, observed on its
    // registries, plus the duplicate-id discrimination pair: a stub
    // registrar would accept the second 'webstack' registration.
    const web = fx.web as unknown as {
      searchProviders: Map<string, unknown>
      fetchProviders: Map<string, unknown>
      registerSearchProvider: (p: { id: string }) => () => void
    }
    expect(web.searchProviders.has('webstack'), 'RA-1 W3: webstack search provider absent on the real WebRuntime').toBe(true)
    expect(web.fetchProviders.has('webstack'), 'RA-1 W3: webstack fetch provider absent on the real WebRuntime').toBe(true)
    expect(() => web.registerSearchProvider({ id: 'webstack' }),
      'RA-1 W3: duplicate provider id accepted — the registration never really landed').toThrow(/already registered/)

    // M1 lifecycle (RA1d-criterion check for the webstack family): fiber
    // dispose withdraws every facet; remount restores the full surface.
    const loader = (ctx as unknown as {
      loader: {
        resolve: (id: string) => { fiber?: { state?: number; dispose?: () => unknown; await?: () => Promise<unknown> } }
        create: (o: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
      }
    }).loader
    const stateOrGone = (): number | undefined => {
      try { return entryState(ctx, wsChannel) } catch { return undefined }
    }
    await loader.resolve(wsChannel).fiber?.dispose?.()
    expect(stateOrGone(), 'M1 W3: webstack still ACTIVE after dispose').not.toBe(2)
    for (const tool of ['web_backend_status', 'web_batch_search', 'web_history']) {
      expect(fx.tools!.get(tool), `M1 W3: dispose leaked ${tool}`).toBeUndefined()
    }
    expect(web.searchProviders.has('webstack'), 'M1 W3: dispose leaked the search provider').toBe(false)
    expect(web.fetchProviders.has('webstack'), 'M1 W3: dispose leaked the fetch provider').toBe(false)

    await loader.create({ name: firstFactoryHref(mountRow('core/webstack')), id: wsChannel, disabled: false })
    await settleEntry(loader, wsChannel)
    expect(entryState(ctx, wsChannel), 'M1 W3: webstack did not come back after remount').toBe(2)
    expect(fx.tools!.get('web_backend_status'), 'M1 W3: tools not restored after remount').toBeDefined()
    expect(web.searchProviders.has('webstack'), 'M1 W3: search provider not restored after remount').toBe(true)
    expect(web.fetchProviders.has('webstack'), 'M1 W3: fetch provider not restored after remount').toBe(true)
  })

  // ── TC-O3: workbench production-posture boot leg (it 计数 9→10). The
  // production seed itself carries enabledAtBoot=true since O3 (the user's O-3
  // ruling「默认安装可停用」, seeded only after the phase-1 source
  // modernization went green), so this leg runs the row UNOVERRIDDEN — scratch
  // posture and production posture are the same (webstack W3 leg precedent).
  // `inject=['webServer']` is satisfied by the fixture's capture registrar;
  // without the fixture's TC-O3 `registerUpgrade` capture face the terminal ws
  // route effect would throw and the fiber could never reach ACTIVE.
  //
  // Environment isolation (R2 预置): the pinned tree's TaskLedger derives its
  // storage root from DSH_BRANCH_HOME (task-ledger.ts defaultFilePath:
  // DSH_BRANCH_HOME → <DSH_HOME>/zdsh → legacy ~/.zdsh-workbench) — stub it to
  // a scratch dir BEFORE the boot so ledger init can never touch the real
  // HOME; the shared afterEach hook restores envs (vi.unstubAllEnvs).
  //
  // RA1d criterion, fourth plugin family: phase-1 wired the domain teardown
  // (ptyRegistry.disposeAll + watchers.closeAll + task-ledger unsubscribe)
  // through ctx.effect's double-arrow form, and the four route faces
  // (api prefix / file media / events SSE / terminal ws upgrade) were already
  // effect-wired at the source. The M1 half below locks exactly that claim:
  // dispose must withdraw the fiber AND every route face; remount must
  // restore the full surface — a leak re-opens the RA1d class for this family.
  it('workbench reaches ACTIVE at the production posture with the route family + upgrade capture; dispose withdraws the fiber-scoped surface (O3)', async () => {
    vi.stubEnv('DSH_BRANCH_HOME', scratch())
    const { ctx, gateway, fx } = await bootWithServices(writeMountSeed([
      mountRow('core/workbench'),
    ]))
    await gateway.settlePreinstall()
    const wbChannel = 'factory/core/workbench'
    const report = gateway.preinstallReport()
    expect(report.entries['core/workbench']?.status, 'RA-1 O3: workbench admission regressed').toBe('installed')
    expect(report.entries['core/workbench']?.mount?.status, 'RA-1 O3: workbench must mount under the fixture (inject=[webServer] satisfied)').toBe('mounted')
    expect(entryState(ctx, wbChannel), 'RA-1 O3: workbench entry not ACTIVE under the fixture').toBe(2)

    // Four-face route family on the capture registrar (route literals captured
    // from the pinned tree: apply's register×3 + registerUpgrade×1 over
    // WORKBENCH_ROUTE_PREFIX='/workbench'; M2: artifact literals live ONLY here).
    expect(fx.webServer!.find('prefix', '/workbench/api/'), 'RA-1 O3: workbench api prefix route absent after mount').toBeDefined()
    expect(fx.webServer!.find('exact', '/workbench/file'), 'RA-1 O3: workbench file media route absent after mount').toBeDefined()
    expect(fx.webServer!.find('exact', '/workbench/events'), 'RA-1 O3: workbench events SSE route absent after mount').toBeDefined()
    expect(fx.webServer!.findUpgrade('/workbench/ws/terminal'), 'RA-1 O3: workbench terminal ws upgrade route absent after mount (registerUpgrade capture face)').toBeDefined()

    // M1 half (RA1d criterion, workbench family): fiber dispose withdraws the
    // entry and every route face; remount restores the full surface.
    const loader = (ctx as unknown as {
      loader: {
        resolve: (id: string) => { fiber?: { state?: number; dispose?: () => unknown; await?: () => Promise<unknown> } }
        create: (o: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
      }
    }).loader
    const stateOrGone = (): number | undefined => {
      try { return entryState(ctx, wbChannel) } catch { return undefined }
    }
    await loader.resolve(wbChannel).fiber?.dispose?.()
    expect(stateOrGone(), 'M1 O3: workbench still ACTIVE after dispose').not.toBe(2)
    expect(fx.webServer!.find('prefix', '/workbench/api/'), 'M1 O3 RA1d: dispose leaked the api prefix route').toBeUndefined()
    expect(fx.webServer!.find('exact', '/workbench/file'), 'M1 O3 RA1d: dispose leaked the file media route').toBeUndefined()
    expect(fx.webServer!.find('exact', '/workbench/events'), 'M1 O3 RA1d: dispose leaked the events SSE route').toBeUndefined()
    expect(fx.webServer!.findUpgrade('/workbench/ws/terminal'), 'M1 O3 RA1d: dispose leaked the terminal ws upgrade route').toBeUndefined()

    await loader.create({ name: firstFactoryHref(mountRow('core/workbench')), id: wbChannel, disabled: false })
    await settleEntry(loader, wbChannel)
    expect(entryState(ctx, wbChannel), 'M1 O3: workbench did not come back after remount').toBe(2)
    expect(fx.webServer!.find('prefix', '/workbench/api/'), 'M1 O3: api prefix route not restored after remount').toBeDefined()
    expect(fx.webServer!.find('exact', '/workbench/file'), 'M1 O3: file media route not restored after remount').toBeDefined()
    expect(fx.webServer!.find('exact', '/workbench/events'), 'M1 O3: events SSE route not restored after remount').toBeDefined()
    expect(fx.webServer!.findUpgrade('/workbench/ws/terminal'), 'M1 O3: terminal ws upgrade route not restored after remount').toBeDefined()
  })
  it('M1 filehub: dispose withdraws the full surface, remount restores it cleanly (RP2, aab73d7)', async () => {
    const { ctx, gateway, fx } = await bootWithServices(writeMountSeed([
      mountRow('core/filehub', { enabledAtBoot: true }),
    ]))
    await gateway.settlePreinstall()
    const fhChannel = 'factory/core/filehub'
    expect(entryState(ctx, fhChannel), 'M1: filehub not ACTIVE before dispose').toBe(2)
    expect(fx.tools!.get('read_document'), 'M1: filehub read_document absent before dispose').toBeDefined()
    expect(fx.webServer!.find('prefix', '/api/filehub'), 'M1: filehub prefix route absent before dispose').toBeDefined()

    const loader = (ctx as unknown as {
      loader: {
        resolve: (id: string) => { fiber?: { state?: number; dispose?: () => unknown; await?: () => Promise<unknown> } }
        create: (o: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
      }
    }).loader
    const stateOrGone = (): number | undefined => {
      try { return entryState(ctx, fhChannel) } catch { return undefined }
    }

    await loader.resolve(fhChannel).fiber?.dispose?.()
    expect(stateOrGone(), 'M1: filehub still ACTIVE after dispose').not.toBe(2)
    // Traceable-service facets withdraw (fiber effect teardown) …
    expect(fx.tools!.get('read_document'), 'M1: dispose leaked read_document').toBeUndefined()
    expect(fx.tools!.get('list_workspace_files'), 'M1: dispose leaked list_workspace_files').toBeUndefined()
    expect((await fx.systemPrompt!.assemble()).sections.some(s => s.name === 'filehub-document-reading'),
      'M1: dispose leaked the guidance section').toBe(false)
    // … and the RA1d effect wiring withdraws the domain-owned facets too:
    // the prefix route that used to leak past disposal must now be gone.
    expect(fx.webServer!.find('prefix', '/api/filehub'),
      'M1 RA1d: the prefix route survived dispose — the effect-contract wiring regressed (revert to the RA1d failure lock and re-open TC-B4-RA1d)').toBeUndefined()

    // Clean remount through the SAME real loader.create channel — no
    // duplicate-route rejection, ACTIVE restored, surface back.
    await loader.create({ name: firstFactoryHref(mountRow('core/filehub')), id: fhChannel, disabled: false })
    await settleEntry(loader, fhChannel)
    expect(entryState(ctx, fhChannel), 'M1 RA1d: filehub did not come back after remount').toBe(2)
    expect(fx.tools!.get('read_document'), 'M1 RA1d: read_document not restored after remount').toBeDefined()
    expect((await fx.systemPrompt!.assemble()).sections.some(s => s.name === 'filehub-document-reading'),
      'M1 RA1d: guidance section not restored after remount').toBe(true)
    expect(fx.webServer!.find('prefix', '/api/filehub'), 'M1 RA1d: prefix route not restored after remount').toBeDefined()
  })
})
