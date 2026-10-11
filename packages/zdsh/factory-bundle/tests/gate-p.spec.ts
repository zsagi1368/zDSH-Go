/**
 * Gate-P / Gate-M factory matrix — three artifacts (TC-B1-1.3b task 5, 续跑 TC-B1-1.3c;
 * P4 真 import 探针 by TC-B2-S1b; parameterized into a per-seed-row matrix by
 * TC-B2-2.1b, extended to a third row by TC-B2-2.2b: the factory-off
 * `core/webstack-verticals` pilot + the boot-enabled `core/omnivision` and
 * `core/webstack-bridge` entries).
 *
 * This is the factory's OWN self-managed test surface (DESIGN-intake-tech.md §6
 * Gate-P row: "新 packages/zdsh（自管面）+ 根 vitest run"). It drives the real
 * governance gateway against the REAL repository seed (`zdsh-factory/seed.json`)
 * and the REAL cold-installed artifacts under
 * `packages/zdsh/factory-bundle/node_modules/...`, over a throwaway
 * storage root standing in for a fresh `DSH_HOME`.
 *
 * Note on placement: the root vitest lane glob covers package tests at the path
 * form "packages/<group>/<package>/tests", which has no rule for a two-level
 * "packages/zdsh/tests", and the design forbids standing up a new lane /
 * editing the shared vitest config — so the matrix lives inside the bundle
 * package ("packages/zdsh/factory-bundle/tests", the same self-managed
 * assembly) and still runs under the existing "pnpm vitest run".
 *
 * What it proves (the batch-2 acceptance slice, per seed row):
 *  - P1 first boot: every seed row is admitted, appears in list(), lands the
 *    boot posture the seed ITSELF declares (`enabledAtBoot` → 'active', else
 *    the K-B2 DEFAULT-DISABLED check), and badges origin 'preinstall' +
 *    source native. The verticals row is the disabled case; the omnivision row
 *    is the boot-enabled case (出厂即用功能件, TC-B2-2.1b).
 *  - P1 idempotency: a restart over the same home re-settles to a
 *    byte-identical result ledger covering BOTH rows (逐字节), and both roster
 *    postures survive.
 *  - M1 lifecycle (verticals pilot, unchanged): disabled → still disabled on
 *    restart → uninstall (tombstone) → a later boot never resurrects → explicit
 *    reinstall brings it back and the node_modules artifact was never touched
 *    by governance.
 *  - P4: every service `factory` declared by an admitted artifact's OWN
 *    manifest is iterated (ADJ 建议-3: no more `.find()`-first-only), re-pinned
 *    to a prebuilt-inclusive tree (existsSync lock), truly `import()`ed once,
 *    and shape-probed — verticals: `XVerticalChannel` with canHandle 正负例
 *    (x.com → true; foreign site and empty hints → false, sealing the
 *    always-true-stub escape); omnivision: `createOmnivisionPlugin`
 *    instantiation shape plus tool-registry and validateConfig discriminative
 *    positive/negative pairs (same anti-always-true discipline). It asserts the
 *    import + export contract, not a full governance-boot instantiation.
 *  - P5 (TC-B2-23D): the mount layer above import — the real governance mount
 *    channel (`ctx.loader.create` via the SeedPreinstaller) is driven over a
 *    throwaway home + the genuine cordis Loader. bridge + omnivision mount
 *    LOADED off the shipped seed; verticals is proven mountable via a sandbox
 *    forced mount (`x-vertical` resolves + canHandle 判别对) while its production
 *    row stays skipped; a broken barrel row fails MOUNT only with siblings
 *    mounted (fail-open lock); and an entry unload/remount recheck closes the
 *    A-card lifecycle leftover (service withdraws on dispose, returns on remount).
 *  - TC-B3-MM1b (this file's current extension): the seed grew to FIVE rows
 *    with `core/filehub` + `core/plugin-center` (both enabledAtBoot=false,
 *    installed-on-disk but held out of the mount spectrum until the R-A
 *    loader-side flip). Their P4 probes are authored from the REAL pinned-tree
 *    export shapes (single-package repos, `lib/index.js`); the production-boot
 *    P5 test gains two held assertions (installed + mount skipped with the
 *    enabledAtBoot=false reason); and the restart-matrix loop assertions now
 *    carry the offending `row.id` in their messages (the K-B2 改进 folded in),
 *    alongside the host-side admit replay fix that keeps a false row disabled
 *    across re-admission (see preinstall.spec.ts TC-B3-MM1b block).
 *  - TC-B3-MM2 (this file's current extension): the seed grew to SIX rows with
 *    `core/autopilot`. Its P4 probe is authored from the REAL installed-tree
 *    export shape (single-package repo, `lib/index.js`; apply function, inject
 *    empty, the hard name literal `@deepseek-ai/dsh-autopilot`, no default, no
 *    canHandle, runtimeFor/memoryAuditMirror hooks present — captured by an
 *    import() probe of the pinned artifact, never invented). The production-boot
 *    P5 test gains a third held assertion (installed + mount skipped with the
 *    enabledAtBoot=false reason — mechanically identical to filehub/plugin-center,
 *    though autopilot's posture is product-design-off (ADJ-3), not harness-honest).
 *    Per the MM1b lesson, the restart-matrix test now ALSO reads the durable
 *    `registry.json` off disk and asserts every boot-disabled row (including
 *    autopilot) is still `disabled` there after boot-2 re-admission — an in-memory
 *    roster check alone can be masked by the construction-time read-back + tail
 *    restore, so the disk assertion is the real drift tripwire.
 *
 *    NOTE (card-face arithmetic slip, resolved by the seed as single source of
 *    truth): the MM2 card's "P5 六行谱 (3 mounted / 3 skipped)" is wrong — the
 *    shipped seed declares only omnivision + webstack-bridge boot-enabled, so the
 *    real six-row spectrum is 2 mounted / 4 skipped (verticals + filehub +
 *    plugin-center + autopilot). The matrix is seed-driven and would fail any
 *    fabricated 3rd mount, so it asserts the truth.
 *  - TC-O3 (this file's current extension): the seed grew to EIGHT rows with
 *    `core/workbench`, enabledAtBoot=true per the user's O-3 ruling「默认安装
 *    可停用」(the disable face = governance disable/uninstall + tombstone, same
 *    as the seven siblings) — seeded only AFTER the phase-1 source
 *    modernization (capabilities + dsh.client + factory-form client bundle +
 *    RA1d-family teardown wiring) went green and was pushed (W3 discipline:
 *    never seed a boot-enabled row ahead of its source fixes). Its P4 probe is
 *    authored from the REAL pinned-tree export shape at pin 9467c65
 *    (single-package repo, `lib/index.js` node half; phase-1 exit dump
 *    ['apply','inject'] captured, never invented): apply function + inject
 *    exactly ['webServer'] + no default (the filehub camp, interlocked with
 *    plugin-center's default) + no canHandle (not a channel artifact). The
 *    production-boot P5 test gains the sixth mounted row (6 mounted / 2
 *    skipped); its bare-harness probe is the honest service-gated PENDING —
 *    inject=['webServer'] only exists on the real host faces and the ra1
 *    fixture (filehub/webstack precedent) — and the ACTIVE + route-family
 *    positive proof lives in the ra1 spec's workbench leg, whose fixture
 *    gained the registerUpgrade capture face for the ws upgrade route.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import PluginGovernanceGateway, { type PluginGovernanceId } from '../../plugin-governance-host/src/index.ts'

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
})

/** Brand a raw id for gateway calls. */
function gid(value: string): PluginGovernanceId {
  return value as PluginGovernanceId
}

// The repository's frozen factory seed, resolved from this spec's own location
// (…/packages/zdsh/factory-bundle/tests → up four → repo root).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const SEED_PATH = join(REPO_ROOT, 'zdsh-factory', 'seed.json')

/** The five seed columns this matrix walks. Everything else is prose. */
interface SeedRow {
  readonly id: string
  readonly source: string
  readonly enabledAtBoot: boolean
}
const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { entries: SeedRow[] }

/** Resolve a seed row's `local:` artifact directory, rejecting other states. */
function localSourceDir(row: SeedRow): string {
  if (!row.source.startsWith('local:')) {
    throw new Error(`Gate-P: seed row ${row.id} declares a non-local source (${row.source}); the probe matrix only walks local: artifacts`)
  }
  return resolve(REPO_ROOT, row.source.slice('local:'.length))
}

// The M1 lifecycle pilot stays on verticals; its id, entry and on-disk
// directory are read back from the seed so the test can never drift from the
// shipped manifest.
const PILOT_ID = 'core/webstack-verticals'
const pilotEntry = seed.entries.find(entry => entry.id === PILOT_ID)
if (pilotEntry === undefined) throw new Error(`the repository seed is missing the ${PILOT_ID} pilot entry`)
const PILOT_ABS_SOURCE = localSourceDir(pilotEntry)

/**
 * Per-artifact P4 shape probes, keyed by the seed id they belong to. Each
 * receives the already-imported factory module and asserts the live export
 * shape; every assertion is deterministic and never touches the network (the
 * same bar the verticals canHandle probe set in S1b).
 */
type ShapeProbe = (mod: Record<string, unknown>) => void

const SHAPE_PROBES: Record<string, ShapeProbe> = {
  // The verticals service exit is its `XVerticalChannel` barrel (S1b probe):
  // stable id + deterministic canHandle + run.
  'core/webstack-verticals': (mod) => {
    const VerticalChannelCtor = mod.XVerticalChannel
    expect(
      typeof VerticalChannelCtor,
      'Gate-P P4: factory module import() resolved but exports no XVerticalChannel constructor',
    ).toBe('function')
    const channel = new (VerticalChannelCtor as new () => {
      id: string
      canHandle: (hints: unknown) => boolean
      run: unknown
    })()
    expect(channel.id).toBe('x-vertical')
    expect(typeof channel.run).toBe('function')
    // 正例：x.com 限域须出手，佐证导出的确是活实现。
    expect(channel.canHandle({ hard: [], soft: [], siteFilter: 'x.com' })).toBe(true)
    // 负例（TC-REVIEW-EXEC11 建议-3 / TC-B2-2.1b 卡面「ADJ 建议-3 封恒 true 逃逸」）：
    // 域外站点与空 hints 均必须不出手——恒 true 桩在此红灯。
    expect(channel.canHandle({ hard: [], soft: [], siteFilter: 'example.com' })).toBe(false)
    expect(channel.canHandle({ hard: [], soft: [] })).toBe(false)
  },
  // The omnivision service exit is the plugin assembly barrel published
  // prebuilt by TC-B2-2.1a (`dist/index.js`): factory + class + tool registry
  // + config validator. Construction composes provider objects only — zero
  // network, zero timers — so a disposable instance is probed for real.
  'core/omnivision': (mod) => {
    expect(typeof mod.createOmnivisionPlugin, 'Gate-P P4: omnivision factory exit exports no createOmnivisionPlugin').toBe('function')
    expect(typeof mod.OmniVisionPlugin, 'Gate-P P4: omnivision factory exit exports no OmniVisionPlugin class').toBe('function')
    expect(typeof mod.DEFAULT_CONFIG, 'Gate-P P4: omnivision factory exit exports no DEFAULT_CONFIG').toBe('object')
    const plugin = (mod.createOmnivisionPlugin as (ctx: unknown) => {
      processMessage: unknown
      callTool: unknown
      stats: () => { providers: number }
      dispose: () => void
    })({ config: mod.DEFAULT_CONFIG, workspace: tmpdir() })
    expect(typeof plugin.processMessage, 'Gate-P P4: instantiated plugin lacks processMessage').toBe('function')
    expect(typeof plugin.callTool, 'Gate-P P4: instantiated plugin lacks callTool').toBe('function')
    expect(typeof plugin.stats().providers).toBe('number')
    plugin.dispose()
    // 判别对（同 canHandle 正负例纪律，封「恒有/恒空」两侧逃逸）：真实出厂
    // 工具必须带 handler 在场，捏造名必须缺席——恒定义的桩注册表在此红灯。
    const getTool = mod.getTool as (name: string) => { handler: unknown } | undefined
    expect(getTool('vision_crop')?.handler, 'Gate-P P4: vision_crop registered but carries no handler').toBeTypeOf('function')
    expect(getTool('vision__definitely_not_registered')).toBeUndefined()
    // validateConfig 判别对：出厂默认（负例）不得报 non-local 警告；故意配坏
    // localOllama.baseURL（正例）必须报——恒 [] 与恒 warn 两种桩同时红灯。
    const validateConfig = mod.validateConfig as (config: Record<string, unknown>) => string[]
    const defaults = mod.DEFAULT_CONFIG as Record<string, unknown>
    expect(validateConfig(defaults).some(warning => /non-local/.test(warning))).toBe(false)
    const broken = {
      ...defaults,
      localOllama: { ...(defaults.localOllama as Record<string, unknown>), enabled: true, baseURL: 'https://ollama.example.com/v1' },
    }
    expect(validateConfig(broken).some(warning => /non-local/.test(warning))).toBe(true)
  },
  // The bridge service exit is the cordis assembly barrel published prebuilt by
  // TC-B2-2.2a (`lib/index.js`): name + inject + Config + apply + BridgeRenderer.
  // bridge is NOT a channel artifact — it registers no `canHandle` face (2.2a
  // evidence: zero tools/commands/hooks; apply(ctx) provides the named `bridge`
  // service). So per TC-B2-2.2b 卡面「无 canHandle 面则按其真实导出契约, 禁造」,
  // the probe asserts the REAL cordis-plugin contract + its Standard Schema
  // config validator as the discriminative pair. It never calls apply() (that
  // starts a loopback WS server + heartbeat timers) — the zero-network /
  // zero-timer bar the verticals canHandle and omnivision instantiation probes
  // both hold to stays intact.
  'core/webstack-bridge': (mod) => {
    expect(mod.name, 'Gate-P P4: bridge factory exit exports no plugin name').toBe('bridge')
    expect(typeof mod.apply, 'Gate-P P4: bridge factory exit exports no cordis apply()').toBe('function')
    expect(typeof mod.BridgeRenderer, 'Gate-P P4: bridge factory exit exports no BridgeRenderer class').toBe('function')
    // 负例（真实导出契约）：bridge 不是 channel 型工件，捏造的 canHandle 在此必
    // 缺席——封「照抄 verticals 通道形状」的伪造，兑现卡面「无 canHandle 面」。
    expect(mod.canHandle, 'Gate-P P4: bridge has no canHandle face (it provides a service, not a channel)').toBeUndefined()
    // 无强依赖接缝：inject 是真实空数组（web/logger 均为 optional 探测）。
    expect(Array.isArray(mod.inject), 'Gate-P P4: bridge inject is not an array').toBe(true)
    expect((mod.inject as unknown[]).length, 'Gate-P P4: bridge declares unexpected hard deps').toBe(0)
    // Config 判别对（Standard Schema V1，对应 omnivision validateConfig 的
    // 「恒通过 / 恒拒绝」两侧逃逸封锁）：合法布尔与缺省必须过，非法类型必须拒。
    const config = mod.Config as { '~standard': { version: number; validate: (v: unknown) => { value?: { enabled?: boolean }; issues?: unknown[] } } }
    expect(config['~standard'].version, 'Gate-P P4: bridge Config is not Standard Schema v1').toBe(1)
    const ok = config['~standard'].validate({ enabled: true })
    expect(ok.issues, 'Gate-P P4: bridge Config rejected a valid boolean config').toBeUndefined()
    expect(ok.value?.enabled, 'Gate-P P4: bridge Config dropped a valid enabled=true').toBe(true)
    const bad = config['~standard'].validate({ enabled: 'yes' })
    expect(Array.isArray(bad.issues), 'Gate-P P4: bridge Config accepted a non-boolean enabled (always-valid stub)').toBe(true)
    expect(bad.value, 'Gate-P P4: bridge Config returned a coerced value for invalid input (always-valid stub)').toBeUndefined()
  },
  // TC-B3-MM1b：filehub 服务出口 = 真源仓 732c0d4 的装配 barrel（`lib/index.js`，
  // 单包仓无子路径）。形制取实不造（scratch-mm1b-shapecapture 实测 dump）：
  // apply 函数 + inject 恰六项逐位相符 + 无 default + 无 canHandle 面 + 两个具名
  // builder 在场。判别锁：捏造的 default/canHandle 在此必缺席、恰等 inject 封
  // 「多声明/少声明接缝」两侧逃逸（与 bridge/omnivision 探针同纪律）。
  'core/filehub': (mod) => {
    expect(typeof mod.apply, 'Gate-P P4: filehub factory exit exports no cordis apply()').toBe('function')
    expect(Array.isArray(mod.inject), 'Gate-P P4: filehub inject is not an array').toBe(true)
    expect(
      mod.inject,
      'Gate-P P4: filehub hard deps drifted from the pinned manifest export face',
    ).toEqual(['fs', 'sessions', 'storage', 'webServer', 'tools', 'systemPrompt'])
    expect('default' in mod, 'Gate-P P4: filehub exports a default (the pinned tree has none)').toBe(false)
    expect(mod.canHandle, 'Gate-P P4: filehub is not a channel artifact; canHandle must be absent').toBeUndefined()
    expect(typeof mod.createFileHubDomain, 'Gate-P P4: filehub exit has no createFileHubDomain').toBe('function')
    expect(typeof mod.registerReadingTools, 'Gate-P P4: filehub exit has no registerReadingTools').toBe('function')
  },
  // TC-B3-MM1b：plugin-center 服务出口 = 真源仓 46df212 的装配 barrel
  // （`lib/index.js`）。形制取实（同一 capture）：包面 name 字面
  // 'zdsh-plugin-center'（roster 位 core/plugin-center 由 normalizePluginId
  // 派生，不冲突）+ apply 函数 + inject 恰空数组 + default 存在（filehub 探针
  // 断「无」、本探针断「有」——两件形状互锁，互为伪造红灯）+ ROUTES 具 ≥10
  // 键且含 'market' + handleApiRequest 函数。不启动 apply()：零网络/零计时器
  // 纪律与 bridge 同源。
  'core/plugin-center': (mod) => {
    expect(mod.name, 'Gate-P P4: plugin-center factory exit name is not the shipped literal').toBe('zdsh-plugin-center')
    expect(typeof mod.apply, 'Gate-P P4: plugin-center exit exports no cordis apply()').toBe('function')
    expect(Array.isArray(mod.inject), 'Gate-P P4: plugin-center inject is not an array').toBe(true)
    expect((mod.inject as unknown[]).length, 'Gate-P P4: plugin-center declares unexpected hard deps').toBe(0)
    expect('default' in mod, 'Gate-P P4: plugin-center ships no default export (the pinned tree has one)').toBe(true)
    const routes = mod.ROUTES as Record<string, unknown> | undefined
    expect(routes !== undefined && typeof routes === 'object', 'Gate-P P4: plugin-center ROUTES is not an object').toBe(true)
    const routeKeys = Object.keys(routes ?? {})
    expect(routeKeys.length, 'Gate-P P4: plugin-center ROUTES covers fewer than 10 routes').toBeGreaterThanOrEqual(10)
    expect(routeKeys, 'Gate-P P4: plugin-center ROUTES lost its market route').toContain('market')
    expect(typeof mod.handleApiRequest, 'Gate-P P4: plugin-center exit has no handleApiRequest').toBe('function')
  },
  // TC-B3-MM2：autopilot 服务出口 = 真源仓 3ed2d4c（33C2 prebuilt）的装配 barrel
  // （`lib/index.js`，单包仓无子路径）。形制取实不造（安装态 import 探针实测，
  // 与 AutoPilot 自测 smoke.spec 同源）：apply 函数 + inject 恰空数组 +
  // name 字面 '@deepseek-ai/dsh-autopilot'（非包名 dsh-autopilot——插件导出名与
  // roster 位 core/autopilot 由 normalizePluginId 派生，互不冲突）+ 无 default
  // （归 filehub「无 default」阵营，与 plugin-center「有 default」互锁）+ 无
  // canHandle 面（非通道件）+ runtimeFor/memoryAuditMirror 两 inspection 钩子在场。
  // 不启动 apply()：与 bridge/filehub/PC 同零网络零计时器纪律（其内部虽裹
  // try/catch「永不抛」，但 P4 只锁导出契约形状，挂载兑现归 P5/后续装配卡）。
  'core/autopilot': (mod) => {
    expect(typeof mod.apply, 'Gate-P P4: autopilot factory exit exports no cordis apply()').toBe('function')
    expect(Array.isArray(mod.inject), 'Gate-P P4: autopilot inject is not an array').toBe(true)
    expect((mod.inject as unknown[]).length, 'Gate-P P4: autopilot declares unexpected hard deps').toBe(0)
    // 判别锁（硬字面，封「照抄他件 name」伪造）：导出名字面必须是插件名常量。
    expect(mod.name, 'Gate-P P4: autopilot factory exit name is not the shipped literal').toBe('@deepseek-ai/dsh-autopilot')
    expect('default' in mod, 'Gate-P P4: autopilot exports a default (the pinned tree has none)').toBe(false)
    expect(mod.canHandle, 'Gate-P P4: autopilot is not a channel artifact; canHandle must be absent').toBeUndefined()
    expect(typeof mod.runtimeFor, 'Gate-P P4: autopilot exit has no runtimeFor inspection hook').toBe('function')
    expect(Array.isArray(mod.memoryAuditMirror), 'Gate-P P4: autopilot exit has no memoryAuditMirror array').toBe(true)
  },
  // TC-B4-W3：webstack 服务出口 = W2 prebuilt 整树反转入库的聚合内核 barrel
  // （6 件分片树，factory './lib/index.js'）。形制取实不造（装件导出面 22 键
  // 实测）：cordis 四出口 name/inject/apply/Config + buildEngineRegistry 装配面
  // + checkTarget SSRF 闸出口。判别对骑 Config 的 Standard Schema 面（bridge
  // 探针先例同款）：零 config 必须解析到冻结默认（layer='free'/enabled=true），
  // 非法 layer 必须拒——恒收/恒拒两侧桩同时红灯。零网络零计时器 P4 纪律：
  // 不启动 apply()（引擎构建与 provider 注册归 P5/ra1 装载面）。
  'core/webstack': (mod) => {
    expect(typeof mod.apply, 'Gate-P P4: webstack factory exit exports no cordis apply()').toBe('function')
    expect(mod.name, 'Gate-P P4: webstack factory exit name is not the shipped literal').toBe('webstack')
    expect(mod.inject, 'Gate-P P4: webstack inject must declare exactly the web service').toEqual(['web'])
    expect('default' in mod, 'Gate-P P4: webstack exports a default (the pinned tree has none)').toBe(false)
    expect(typeof mod.buildEngineRegistry, 'Gate-P P4: webstack exit has no buildEngineRegistry assembly face').toBe('function')
    expect(typeof mod.checkTarget, 'Gate-P P4: webstack exit has no SSRF checkTarget gate').toBe('function')
    const config = mod.Config as { '~standard': { version: number; validate: (v: unknown) => { value?: { layer?: string; enabled?: boolean }; issues?: unknown[] } } }
    expect(config['~standard'].version, 'Gate-P P4: webstack Config is not Standard Schema v1').toBe(1)
    const ok = config['~standard'].validate({})
    expect(ok.issues, 'Gate-P P4: webstack Config rejected the zero config (must resolve to the frozen defaults)').toBeUndefined()
    expect(ok.value?.layer, 'Gate-P P4: webstack default layer is not the free pool').toBe('free')
    expect(ok.value?.enabled, 'Gate-P P4: webstack default enabled is not true').toBe(true)
    const bad = config['~standard'].validate({ layer: 'definitely-not-a-tier' })
    expect(Array.isArray(bad.issues), 'Gate-P P4: webstack Config accepted a bogus layer (always-valid stub)').toBe(true)
    expect(bad.value, 'Gate-P P4: webstack Config returned a coerced value for invalid input (always-valid stub)').toBeUndefined()
  },
  // TC-O3：workbench 服务出口 = 真源 9467c65 的 node 半 barrel（lib/index.js，单包仓无子路径）。
  // 形制取实不造（阶段 1 出口 dump 留证 ['apply','inject']）：apply 函数（async，含
  // guardWorkbench 短路语义）+ inject 恰 ['webServer']（src/index.ts:25 硬依赖，逐位
  // 相符封「多声明/少声明接缝」两侧逃逸）+ 无 default（归 filehub/autopilot「无
  // default」阵营，与 plugin-center「有 default」互锁）+ 无 canHandle 面（非通道件）。
  // 不启动 apply()：零网络/零计时器纪律与 bridge/filehub/PC/webstack 同源
  // （apply 会注册路由族+起 TaskLedger init——P4 只锁导出契约形状，挂载兑现归 P5/ra1）。
  'core/workbench': (mod) => {
    expect(typeof mod.apply, 'Gate-P P4: workbench factory exit exports no cordis apply()').toBe('function')
    expect(Array.isArray(mod.inject), 'Gate-P P4: workbench inject is not an array').toBe(true)
    expect(mod.inject, 'Gate-P P4: workbench hard deps drifted from the pinned manifest export face').toEqual(['webServer'])
    expect('default' in mod, 'Gate-P P4: workbench exports a default (the pinned tree has none)').toBe(false)
    expect(mod.canHandle, 'Gate-P P4: workbench is not a channel artifact; canHandle must be absent').toBeUndefined()
  },
}

// The seed is the single source of truth: a seed row without a P4 probe here is
// a hard error, mechanically enforcing the seed.json discipline「entries 增项
// 须配 Gate-P 探针」(TC-B2-2.1b 卡面双件矩阵的防漂移锁).
for (const row of seed.entries) {
  if (SHAPE_PROBES[row.id] === undefined) {
    throw new Error(`Gate-P: seed row ${row.id} ships without a P4 shape probe (seed.json discipline: "entries 增项须配 Gate-P 探针")`)
  }
}

/** The roster status a seed row's boot posture must land on (K-B2: status column, not just the row). */
function expectedBootStatus(row: SeedRow): 'active' | 'disabled' {
  return row.enabledAtBoot ? 'active' : 'disabled'
}

interface Boot {
  gateway: PluginGovernanceGateway
  storageRoot: string
  resultsPath: string
}

/** Boot a gateway over a fresh temp home pointed at the real repository seed. */
async function boot(storageRoot: string): Promise<Boot> {
  const ctx = new Context()
  contexts.push(ctx)
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot, seedPath: SEED_PATH })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return { gateway, storageRoot, resultsPath: join(storageRoot, 'data', 'preinstall-results.json') }
}

function pilotSummary(gateway: PluginGovernanceGateway) {
  return gateway.list().plugins.find(plugin => plugin.pluginId === gid(PILOT_ID))
}

describe.each(seed.entries)('Gate-P P1 (matrix) — real seed + real cold-installed artifact: $id', (row) => {
  it('first boot admits it, lands the seed-declared boot posture, and badges factory origin', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'gate-p-home-'))
    storageRoots.push(storageRoot)
    const { gateway } = await boot(storageRoot)
    await gateway.settlePreinstall()

    // Admitted exactly once, clean install status.
    expect(gateway.preinstallReport().entries[row.id]?.status).toBe('installed')

    // Present in the roster, and — the K-B2 anti-false-green check — actually in
    // the posture the seed row itself declares: verticals DEFAULT DISABLED
    // (enabledAtBoot=false), omnivision boot-ENABLED (enabledAtBoot=true).
    const summary = gateway.list().plugins.find(plugin => plugin.pluginId === gid(row.id))
    expect(summary).toBeDefined()
    expect(summary?.status).toBe(expectedBootStatus(row))
    expect(summary?.source).toBe('native')
    expect(summary?.origin).toBe('preinstall')
  })
})

describe('Gate-P pilot — restart idempotency over the whole seed', () => {
  it('a restart over the same home re-settles every seed row byte-identically', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'gate-p-home-'))
    storageRoots.push(storageRoot)

    const boot1 = await boot(storageRoot)
    await boot1.gateway.settlePreinstall()
    const bytes1 = readFileSync(boot1.resultsPath, 'utf8')

    const boot2 = await boot(storageRoot)
    await boot2.gateway.settlePreinstall()
    // 逐字节：台账整体（含全部 seed 行 + ranAt）重启后必须一毫不差。
    expect(readFileSync(boot2.resultsPath, 'utf8'), 'Gate-P restart: preinstall ledger is not byte-identical across boots').toBe(bytes1)

    // The ledger really carries exactly the seed's rows, all installed.
    const ledger = JSON.parse(bytes1) as { entries: Record<string, { status: string }> }
    expect(Object.keys(ledger.entries).sort()).toEqual(seed.entries.map(entry => entry.id).sort())
    for (const row of seed.entries) {
      expect(ledger.entries[row.id]?.status, `Gate-P restart: ledger row ${row.id} must stay installed`).toBe('installed')
    }

    // Roster postures survive the restart for every row — 断言消息带 row.id
    // （K-B2 改进并入，TC-B3-MM1b）：八件谱下漂移必须一眼定位到行。
    for (const row of seed.entries) {
      const summary = boot2.gateway.list().plugins.find(plugin => plugin.pluginId === gid(row.id))
      expect(summary, `Gate-P restart: seed row ${row.id} missing from the roster after boot 2`).toBeDefined()
      expect(summary?.status, `Gate-P restart: seed row ${row.id} drifted off its declared posture ${expectedBootStatus(row)}`).toBe(expectedBootStatus(row))
      expect(summary?.origin, `Gate-P restart: seed row ${row.id} lost its preinstall badge`).toBe('preinstall')
    }

    // MM1b 固化教训（TC-B3-MM2 带入 autopilot）：内存 roster 断言会被 boot-2
    // 构造期读回 + 尾扫 restore 同步掩盖——真正锁死「seed=false 件首见漂移」的
    // 证据链必须落到磁盘 registry.json。逐出厂 disabled 行断言其持久行为
    // 'disabled'（含新增的 core/autopilot）：若复准入把某行覆写回 active，此处
    // 红灯，且与准入点重放修复（host admitManifest）互为回归闸。
    const diskRegistry = JSON.parse(readFileSync(join(storageRoot, 'registry.json'), 'utf8')) as {
      plugins: Array<{ id: string; status: string }>
    }
    for (const row of seed.entries) {
      if (row.enabledAtBoot) continue
      const diskRow = diskRegistry.plugins.find(plugin => plugin.id === row.id)
      expect(diskRow, `Gate-P restart: seed=false row ${row.id} has no durable registry line`).toBeDefined()
      expect(diskRow?.status, `Gate-P restart: seed=false row ${row.id} drifted on disk after boot 2 re-admission (must stay disabled)`).toBe('disabled')
    }
  })
})

describe('Gate-M M1 pilot lifecycle (verticals) — disable → restart → uninstall → no-resurrect → reinstall', () => {
  it('walks the five-step operator lifecycle without ever deleting the node_modules artifact', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'gate-p-home-'))
    storageRoots.push(storageRoot)

    // 1. 停用： the factory preset ships it disabled; the operator's own disable
    //    of the seeded entry is a no-op against that default but must succeed.
    const boot1 = await boot(storageRoot)
    await boot1.gateway.settlePreinstall()
    expect(pilotSummary(boot1.gateway)?.status).toBe('disabled')
    expect((await boot1.gateway.disable({ pluginId: gid(PILOT_ID), reason: 'pilot M1' })).ok).toBe(true)

    // 2. 重启仍停： a fresh gateway over the same home keeps the disabled state
    //    (the factory posture + the persisted decision both say disabled).
    const boot2 = await boot(storageRoot)
    await boot2.gateway.settlePreinstall()
    expect(pilotSummary(boot2.gateway)?.status).toBe('disabled')

    // 3. 卸载： removes it from the roster and writes the tombstone.
    const removed = await boot2.gateway.uninstall({ pluginId: gid(PILOT_ID) })
    expect(removed.ok).toBe(true)
    expect(pilotSummary(boot2.gateway)).toBeUndefined()
    expect(boot2.gateway.preinstallReport().entries[PILOT_ID]?.userUninstalled).toBe(true)
    // 整改④ (EXEC8, TC-B1-CLOSER): DIRECT in-place assertion of the
    // node_modules artifact right after the uninstall — symmetric with the
    // governance-host S3 case — instead of only inferring survival from the
    // step-5 reinstall succeeding.
    expect(existsSync(join(PILOT_ABS_SOURCE, 'package.json'))).toBe(true)

    // 4. 不复活： the next boot's preinstall pass must NOT resurrect it.
    const boot3 = await boot(storageRoot)
    await boot3.gateway.settlePreinstall()
    expect(boot3.gateway.list().plugins.some(p => p.pluginId === gid(PILOT_ID))).toBe(false)
    expect(boot3.gateway.preinstallReport().entries[PILOT_ID]?.userUninstalled).toBe(true)
    // 整改④ again after the no-resurrect boot: what governance refused to
    // delete is still physically on disk at the seed's own source path.
    expect(existsSync(join(PILOT_ABS_SOURCE, 'package.json'))).toBe(true)

    // 5. 重装： the operator can still install it explicitly, which also proves
    //    governance never deleted the node_modules closure (the artifact dir and
    //    its manifest survived every prior step).
    expect(pilotEntry.source.startsWith('local:')).toBe(true)
    const reinstalled = await boot3.gateway.install({ source: PILOT_ABS_SOURCE })
    expect(reinstalled.ok).toBe(true)
    expect(boot3.gateway.list().plugins.some(p => p.pluginId === gid(PILOT_ID))).toBe(true)
  })
})

describe.each(seed.entries)('Gate-P P4 (matrix) — real import() of every service factory: $id', (row) => {
  it('imports each declared factory exit and runs the artifact shape probe', async () => {
    const sourceDir = localSourceDir(row)
    // The exits under probe are the installed artifact's OWN manifest
    // declarations — read the service `factory` paths back from its
    // package.json so this test can never drift from what governance would
    // actually load (mirrors reading the seed above rather than hard-coding a
    // relative path).
    const manifest = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as {
      dsh?: { capabilities?: Array<{ service?: { factory?: string } }> }
    }
    // 多 factory 遍历（ADJ 建议-3：不再 `.find()` 只取首个）：manifest 声明几
    // 条 service factory，就逐条装载几条。
    const factories = (manifest.dsh?.capabilities ?? [])
      .map(cap => cap.service?.factory)
      .filter((factory): factory is string => typeof factory === 'string' && factory.length > 0)
    if (factories.length === 0) {
      throw new Error(`the installed ${row.id} manifest declares no service factory path`)
    }

    for (const factoryRel of factories) {
      const factoryAbs = resolve(sourceDir, factoryRel)

      // F8/U-1 前置事实：service factory 指向纯库产物，必须先物理落盘。断言文件
      // 存在把「pin 未含 prebuilt」这一回归锁死为红灯（S1b 之 6e31341→43732b7
      // 先例；omnivision 之 9818405 由 TC-B2-2.1a 入库 dist/），而不是让下面的
      // import 抛出难懂的错。
      expect(
        existsSync(factoryAbs),
        `Gate-P P4: ${row.id} service factory '${factoryRel}' is absent under ${sourceDir} — the pinned tree is not prebuilt-inclusive`,
      ).toBe(true)

      // 装载语义实证：真 import() 一次 factory 出口（纯库 re-export barrel），
      // 销 F8/U-1——不是纸面推断，是把 dsh manifest 里那条 factory 路径交给
      // Node ESM 装载器实际跑一遍。
      const mod = (await import(pathToFileURL(factoryAbs).href)) as Record<string, unknown>
      SHAPE_PROBES[row.id]!(mod)
    }
  })
})

// ============================================================================
// Gate-P P5 — real `loader.create` MOUNT probes (TC-B2-23D, DESIGN §9.5-D).
// P4 above proves `import()` + export shape; P5 proves each artifact is a VALID
// cordis plugin that the governance mount channel (TC-B2-23A) actually loads:
// the entry reaches LOADED (fiber ACTIVE) and its capability is live off the
// context — the "can import" vs "can mount" gap §9.5 closed. It drives the real
// SeedPreinstaller over a throwaway home + the genuine cordis Loader (V2 §5-1,
// non-fake). verticals is exercised at a SANDBOX forced posture (enabledAtBoot
// =true) to prove its mountability + provide `x-vertical`; its PRODUCTION seed
// row stays disabled (FIX9) — asserted in the P1 matrix and the skipped ledger
// check below. omnivision's ported apply returns the plugin and records it via
// `mountedFor` but registers NO cordis-named service (a契约偏差 flagged in the
// TC-B2-23D receipt), so its mount-success signal is the entry reaching ACTIVE
// plus a live plugin construction, not a `ctx.get('vision')`.
// ============================================================================

// The full seed rows (mount fixtures need the executor contract fields — pin /
// package / version / failPolicy — not just the three the matrix column narrows).
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

/** Copy a real seed row onto its absolute in-repo `local:` source (with overrides). */
function mountRow(id: string, overrides: Partial<FullSeedRow> = {}): FullSeedRow {
  const base = FULL_SEED.find(entry => entry.id === id)
  if (base === undefined) throw new Error(`Gate-P P5: seed is missing the ${id} row`)
  const merged = { ...base, ...overrides }
  return { ...merged, source: `local:${localSourceDir(merged)}` }
}

/**
 * A seed document over given rows. F7 fixture root-posture migration
 * (TC-B4-H1 face 6): mountRow rows carry ABSOLUTE in-repo `local:` sources,
 * which the containment gate only accepts when repoRoot=REPO_ROOT — exactly
 * what deriveRepoRoot gives for a seed under `<REPO_ROOT>/zdsh-factory/`. The
 * REAL seed.json is never touched; the temp file is PID-keyed and removed in
 * afterEach (a worker killed mid-test would leave a visible untracked
 * residue under zdsh-factory/ — delete it by hand; it never merges silently).
 */
function writeMountSeed(rows: FullSeedRow[]): string {
  const path = join(REPO_ROOT, 'zdsh-factory', `seed.gatep-fixture-${process.pid}-${mountSeedSeq++}.json`)
  repoSeedFiles.push(path)
  writeFileSync(path, JSON.stringify({ version: 1, entries: rows }))
  return path
}

/** Boot a gateway over a throwaway home with the REAL cordis Loader mounted. */
async function bootRealLoader(seedPath: string): Promise<{ ctx: Context; gateway: PluginGovernanceGateway }> {
  const ctx = new Context()
  contexts.push(ctx)
  const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  await ctx.plugin(Loader)
  const storageRoot = mkdtempSync(join(tmpdir(), 'gate-p-p5-home-'))
  storageRoots.push(storageRoot)
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot, seedPath })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return { ctx, gateway }
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
  if (factory === undefined) throw new Error(`Gate-P P5: ${row.id} declares no service factory`)
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

// The P5 authored-per-artifact capability probes — the §9.5-D③ data-table
// extension of SHAPE_PROBES (same "authored per contract, not a harness gap"
// qualification the fix8 design ruled for escalate 2.2b-§3). Runs after a real
// mount; asserts the loaded entry + its live capability off the context.
type MountProbe = (ctx: Context, row: FullSeedRow) => void | Promise<void>
const MOUNT_PROBES: Record<string, MountProbe> = {
  'core/webstack-bridge': (ctx) => {
    // bridge's apply provides the named `bridge` service (2.2a contract).
    expect(entryState(ctx, 'factory/core/webstack-bridge'), 'Gate-P P5: bridge entry not ACTIVE').toBe(2)
    expect(tryGet(ctx, 'bridge'), 'Gate-P P5: bridge mounted but `bridge` service did not resolve').toBeTruthy()
  },
  'core/omnivision': async (ctx, row) => {
    // omnivision provides no cordis service; entry ACTIVE is the mount proof,
    // plus its admitted barrel constructs a live plugin (zero network/timer).
    expect(entryState(ctx, 'factory/core/omnivision'), 'Gate-P P5: omnivision entry not ACTIVE').toBe(2)
    const mod = (await import(firstFactoryHref(row))) as Record<string, unknown>
    expect(typeof mod.apply, 'Gate-P P5: omnivision exit has no cordis apply()').toBe('function')
    const scratchCtx = { provide: () => {}, effect: () => {}, logger: { info: () => {}, warn: () => {} } }
    const plugin = (mod.apply as (c: unknown) => { processMessage: unknown; stats: () => { providers: number } })(scratchCtx)
    expect(typeof plugin.processMessage, 'Gate-P P5: mounted omnivision plugin lacks processMessage').toBe('function')
    expect(typeof plugin.stats().providers, 'Gate-P P5: mounted omnivision plugin stats invalid').toBe('number')
  },
  // TC-B4-RA-2: filehub + plugin-center flipped boot-enabled. Their probes are
  // authored at the same bar as the siblings, split by inject shape:
  //  - plugin-center (`inject=[]`) passes the cordis gate instantly, so its
  //    entry reaches ACTIVE even in THIS bare harness — asserted here.
  //  - filehub (six hard injects) mounts through the real channel (ledger
  //    `mounted`, asserted in the production-boot test) but its fiber stays
  //    PENDING in this bare harness — the six services exist only on the real
  //    host faces (web-app / headless CLI) and the ra1 host-services fixture.
  //    Asserting ACTIVE here would be dishonest (the services are genuinely
  //    absent); the ACTIVE + full-capability proof lives in the ra1 spec under
  //    the real-service fixture. The probe instead pins the honest bare shape:
  //    the fiber is PENDING (service-gated), never FAILED — a FAILED state
  //    here would mean the artifact itself broke, which is exactly what this
  //    probe must catch (e.g. the pre-RA1c undeclared-llm crash flipped the
  //    ledger to 'failed', which the ledger assertions above already catch).
  'core/filehub': (ctx) => {
    expect(entryState(ctx, 'factory/core/filehub'), 'Gate-P P5: filehub fiber must be service-gated PENDING in the bare harness, not FAILED/ACTIVE — a FAILED state means the artifact broke').toBe(0)
  },
  'core/plugin-center': (ctx) => {
    expect(entryState(ctx, 'factory/core/plugin-center'), 'Gate-P P5: plugin-center entry not ACTIVE in the production posture').toBe(2)
  },
  // TC-B4-W3: webstack is the seventh factory artifact (enabledAtBoot=true per
  // the W-DEC ruling). Its single hard inject is `web`, which only exists on
  // the real host faces (the base patch's web row) and in the ra1
  // host-services fixture — so the honest bare-harness shape is a
  // service-gated PENDING fiber, the SAME qualification the filehub probe
  // above carries: asserting ACTIVE here would be dishonest (the service is
  // genuinely absent), and the positive ACTIVE + capability proof lives in the
  // ra1 spec's webstack leg. PENDING — never FAILED — is the artifact-integrity
  // lock: FAILED would mean the artifact itself broke during load (e.g. an
  // F2-class schema rejection at tools registration).
  'core/webstack': (ctx) => {
    expect(entryState(ctx, 'factory/core/webstack'), 'Gate-P P5: webstack fiber must be service-gated PENDING in the bare harness, not FAILED/ACTIVE — a FAILED state means the artifact broke').toBe(0)
  },
  // TC-O3：workbench 唯一硬 inject 是 `webServer`，只存在于真实宿主面（web-app/
  // headless CLI）与 ra1 host-services fixture——裸 harness 诚实形=service-gated
  // PENDING（断 ACTIVE 即不诚实），ACTIVE+路由族（含 registerUpgrade 的
  // /workbench/ws/terminal 升级面）正证在 ra1 spec workbench 腿（filehub/webstack
  // 同款先例）。PENDING——never FAILED——是工件完整性锁：FAILED=工件本体在装载期破损。
  'core/workbench': (ctx) => {
    expect(entryState(ctx, 'factory/core/workbench'), 'Gate-P P5: workbench fiber must be service-gated PENDING in the bare harness, not FAILED/ACTIVE — a FAILED state means the artifact broke').toBe(0)
  },
}

// §9.5-D①: a boot-enabled local: seed row with no P5 mount probe is a module-
// level hard error (mirrors the P4 "no shape probe" anti-drift lock). verticals
// is NOT boot-enabled (production false → skipped), so it needs no table probe;
// its mountability rides the explicit sandbox test below.
for (const row of FULL_SEED) {
  if (row.enabledAtBoot && row.source.startsWith('local:') && MOUNT_PROBES[row.id] === undefined) {
    throw new Error(`Gate-P P5: boot-enabled local: seed row ${row.id} ships without a mount probe (DESIGN §9.5-D①)`)
  }
}

describe('Gate-P P5 — real mount spectrum over the seed rows + fail-open + lifecycle', () => {
  it('production boot: bridge + omnivision + filehub + plugin-center + webstack + workbench mount LOADED; verticals + autopilot stay skipped (FIX9 / TC-B3-MM1b/MM2 → TC-B4-RA-2 → TC-B4-W3 → TC-O3)', async () => {
    // The shipped seed posture after TC-O3 (verticals + autopilot false,
    // omnivision + bridge + filehub + plugin-center + webstack + workbench
    // true — workbench boot-enabled per the user's O-3 ruling「默认安装可停用」,
    // seeded only after its phase-1 source modernization went green), mounted
    // through the real channel: the six boot-enabled rows load and their
    // probes pass; the verticals + autopilot rows are tried-by-nothing and
    // record skipped.
    const { ctx, gateway } = await bootRealLoader(SEED_PATH)
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    for (const id of ['core/webstack-bridge', 'core/omnivision', 'core/filehub', 'core/plugin-center', 'core/webstack', 'core/workbench']) {
      expect(report.entries[id]?.status, `Gate-P P5: ${id} production row must be installed`).toBe('installed')
      expect(report.entries[id]?.mount?.status, `Gate-P P5: ${id} must mount in the W3 production posture`).toBe('mounted')
    }
    // verticals production stays factory-off: never mounted, ledger skipped.
    expect(report.entries['core/webstack-verticals']?.status).toBe('installed')
    expect(report.entries['core/webstack-verticals']?.mount?.status).toBe('skipped')
    expect(report.entries['core/webstack-verticals']?.mount?.reason).toMatch(/enabledAtBoot=false/)
    expect(tryGet(ctx, 'x-vertical'), 'Gate-P P5: verticals must NOT be mounted in the production posture').toBeUndefined()

    // autopilot stays product-design-off (ADJ-3: the whole engine ships
    // disabled by default — NOT a harness-honesty hold like filehub/PC were
    // before RA-2; it does not flip with the R-A work and rides no probe).
    expect(report.entries['core/autopilot']?.status, 'Gate-P P5: core/autopilot production row must be installed').toBe('installed')
    expect(report.entries['core/autopilot']?.mount?.status, 'Gate-P P5: core/autopilot must stay held out of the mount spectrum').toBe('skipped')
    expect(report.entries['core/autopilot']?.mount?.reason, 'Gate-P P5: core/autopilot skipped-mount reason must cite the seed posture').toMatch(/enabledAtBoot=false/)

    // Run the authored capability probes for the six boot-enabled rows.
    for (const id of ['core/webstack-bridge', 'core/omnivision', 'core/filehub', 'core/plugin-center', 'core/webstack', 'core/workbench']) {
      await MOUNT_PROBES[id]!(ctx, FULL_SEED.find(row => row.id === id)!)
    }
  })

  it('sandbox verticals forced mount: LOADED, x-vertical resolves, canHandle 判别对 (reuses 23C 自证)', async () => {
    // FIX9: production verticals stays disabled; mountability is proven HERE by
    // forcing enabledAtBoot=true on a scratch row and driving the real channel.
    const { ctx, gateway } = await bootRealLoader(writeMountSeed([mountRow('core/webstack-verticals', { enabledAtBoot: true })]))
    await gateway.settlePreinstall()

    expect(gateway.preinstallReport().entries['core/webstack-verticals']?.mount?.status).toBe('mounted')
    expect(entryState(ctx, 'factory/core/webstack-verticals'), 'Gate-P P5: verticals entry not ACTIVE').toBe(2)
    const service = tryGet(ctx, 'x-vertical') as {
      channel: { id: string }
      canHandle: (hints: unknown) => boolean
    }
    expect(service, 'Gate-P P5: mounted verticals `x-vertical` service did not resolve').toBeTruthy()
    expect(service.channel.id).toBe('x-vertical')
    // 判别对（正/负各一，封恒真/恒假桩，与 P4 canHandle 同源口径）：限域命中、
    // 域外与空 hints 均不命中。
    expect(service.canHandle({ hard: [], soft: [], siteFilter: 'x.com' })).toBe(true)
    expect(service.canHandle({ hard: [], soft: [], siteFilter: 'example.com' })).toBe(false)
    expect(service.canHandle({ hard: [], soft: [] })).toBe(false)
  })

  it('fail-open regression lock: a broken factory row fails MOUNT only, siblings unaffected', async () => {
    // §9.5-D②: inject a library-only barrel (no apply → cordis `invalid plugin`)
    // beside the two real boot-enabled artifacts. The broken row's ADMISSION
    // still lands installed, its MOUNT is failed, and both real siblings mount.
    //
    // F7 fixture root-posture (TC-B4-H1 face 6): this pass MIXES real in-repo
    // rows (writeMountSeed anchors repoRoot=REPO_ROOT) with the broken
    // fixture row — so the fixture dir must live inside REPO_ROOT too, else
    // the containment gate (correctly) rejects it as an escape. node_modules/
    // is gitignored territory: a crash residue never pollutes the porcelain.
    const brokenDir = mkdtempSync(join(REPO_ROOT, 'node_modules', '.gate-p-p5-broken-'))
    scratchDirs.push(brokenDir)
    writeFileSync(join(brokenDir, 'package.json'), JSON.stringify({
      name: '@fixture/p5-barrel',
      version: '1.0.0',
      dsh: {
        autoApprove: true,
        compatible: '>=0.0.0',
        capabilities: [{ type: 'service', service: { name: 'p5-barrel/widget', factory: './index.js', singleton: true } }],
      },
    }))
    writeFileSync(join(brokenDir, 'index.js'), 'export const LIB_ONLY = "no apply, no default: a pure library barrel"\n')
    const brokenRow: FullSeedRow = {
      id: 'fixture/p5-barrel',
      package: '@fixture/p5-barrel',
      version: '1.0.0',
      pin: 'd'.repeat(40),
      source: `local:${brokenDir}`,
      integrity: null,
      enabledAtBoot: true,
      family: 'fixture',
      failPolicy: 'fail-open',
    }
    const { gateway } = await bootRealLoader(writeMountSeed([
      brokenRow,
      mountRow('core/webstack-bridge'),
      mountRow('core/omnivision'),
    ]))
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    expect(report.entries['fixture/p5-barrel']?.status).toBe('installed')
    expect(report.entries['fixture/p5-barrel']?.mount?.status).toBe('failed')
    expect(report.entries['fixture/p5-barrel']?.mount?.reason).toMatch(/invalid plugin/)
    // 兄弟不受累（同一 pass 内两件真件均 mounted）：fail-open per-item 隔离铁证。
    expect(report.entries['core/webstack-bridge']?.mount?.status).toBe('mounted')
    expect(report.entries['core/omnivision']?.mount?.status).toBe('mounted')
  })

  it('entry unload/reload recheck (A 卡遗留①): dispose → service unresolvable → remount restores', async () => {
    // §9.5-A① / 批次 2.3 M1 装载面复验: mount verticals (sandbox forced), observe
    // `x-vertical` live, dispose the loader entry fiber, observe the service is
    // withdrawn, then re-create and observe it resolved again.
    const { ctx, gateway } = await bootRealLoader(writeMountSeed([mountRow('core/webstack-verticals', { enabledAtBoot: true })]))
    await gateway.settlePreinstall()
    expect(tryGet(ctx, 'x-vertical'), 'Gate-P P5: pre-dispose x-vertical should resolve').toBeTruthy()

    const channelId = 'factory/core/webstack-verticals'
    const loader = (ctx as unknown as {
      loader: {
        resolve: (id: string) => { fiber?: { dispose?: () => unknown; await?: () => Promise<unknown> } }
        create: (o: { name: string; id?: string; disabled?: boolean | null }) => Promise<unknown>
      }
    }).loader
    await loader.resolve(channelId).fiber?.dispose?.()
    expect(tryGet(ctx, 'x-vertical'), 'Gate-P P5: x-vertical still resolves after the mount entry was disposed').toBeUndefined()

    // 重挂恢复: re-create the same channel id from the artifact's factory exit.
    await loader.create({ name: firstFactoryHref(mountRow('core/webstack-verticals')), id: channelId, disabled: false })
    await settleEntry(loader, channelId)
    expect(tryGet(ctx, 'x-vertical'), 'Gate-P P5: x-vertical did not come back after a remount').toBeTruthy()
  })
})
