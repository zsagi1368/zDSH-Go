/**
 * TC-B4-G3 (Gate-C C4, DESIGN §6.1:201) — 出厂逐件预装混沌矩阵（host 面）。
 *
 * 三形态注入机制（卡面定夺）= scratch seed 行 + tmpdir 伪造坏工件 `local:` 源：
 * 真 seed（zdsh-factory/seed.json）只读回枚举与行字段（单一真源，never
 * re-declared），伪造工件全部落在一次性 tmpdir——**禁触真装件**（真工件树
 * packages/zdsh/factory-bundle/node_modules/** 零读写）。seed 行
 * `enabledAtBoot` 沙箱强制 true（gate-p P5 verticals 先例）：生产 seed 姿态
 * 不动（seed=禁改面），混沌面以强制姿态驱动 mount 通道。
 *
 * 三形态与断言（fail-open per-item 四件套：台账逐项记录 + 其余件照常装载 +
 * boot 完成 + 肇事者归因可查询）：
 *  - ① apply 崩（throw）：准入面 installed（崩发生在运行期 mount 面）+
 *    mount failed 行 + reason 含肇事标记；兄弟七件 installed+mounted+active。
 *  - ② apply 挂起（bounded release 形制，G3 裁决②诚实标注——**本腿不证明
 *    超时切断：永久挂起在 host mount 层无切断 = G3-F1 已登记，生产修归
 *    批次 4.2+ 独立裁决〔与 governed mount §9.7 同域〕**。超时形态的真
 *    fail-open 证明在 kernel RunGuard 层兑现〔chaos.spec.ts G3-C4 超时腿，
 *    治理域唯一现成超时 seam〕）。本腿证明面 = 三命题：挂起期间 boot 不阻断
 *    （Service.init fire-and-forget，R-1.1.4 启动半）+ roster/report 读面活 +
 *    前序兄弟在位；释放后 pass 全 settle + 台账逐项 + 兄弟零连坐。
 *    G3-F1 证据链（SYNC-P3 轮转）：gateway src/index.ts mount 钩子三段捕获
 *    await entry.fiber.await() → vendor/cordis fiber.ts:704-710
 *    while(inertia) 等的就是 apply 本体；preinstaller.ts:236-256 pass 单锁
 *    串行、台账写在 mutate 返回后 ⇒ 永久挂起 = pass 永挂 + 台账 0 行 +
 *    后序兄弟全不装载（R-1.1.4「其余继续」对永久挂起类有缺口；对崩/畸形类
 *    成立——本文件①③腿即证）。
 *  - ③ 畸形 manifest（package.json dsh 段缺损/坏形）：分层判据以 admission
 *    实际行为亲测为准（裁决④，臆测形禁写；本轮亲测纠正了「dsh 全缺=宽容
 *    准入」的初版假设）——真契约三分：
 *      · 硬畸形（package.json 不可解析）→ manifestFromLocalSource 直接
 *        request-invalid → failed 行（parse 归因，fail-closed 于「伪装成功」）。
 *      · dsh 段全缺 → capabilities 回退空表 → registry.validate「At least one
 *        capability required」fail-closed 拒绝（registry.ts:192-195）→
 *        admitManifest 归因 request-invalid（index.ts:484-486）→ failed 行
 *        （capability 归因）。即「dsh 缺损致空能力」并不宽容准入，而是被拒。
 *      · dsh 段退化但 capabilities 非空、无 service factory 出口（tool-only）
 *        → 过 validate → installed；mountEntry resolveFactoryUrls 得空 →
 *        mount skipped（'no service factory' 归因；既有 preinstall-mount
 *        「no-factory」绿测已证此路径）。此即真「宽容准入但无可装载出口」面。
 *    亚形 b（空能力被拒 failed）与亚形 c（退化能力准入 skipped）构成判别对，
 *    封「恒 failed / 恒 admitted」两侧逃逸；三形兄弟件均照常装载、boot 完成。
 *
 * 预装单项失败不阻断 boot 复验 = A-1.1.4/P2 既有探针**并入枚举，不重造**：
 * 探针本体在 preinstall.spec.ts（'records a fail-open row for a broken entry
 * and still installs the rest' + P2 regression）与 gate-p.spec.ts（P5
 * fail-open lock）；本文件把同一语义泛化到八件谱逐件枚举（describe.each
 * 各腿的 boot-完成断言）+ 一条重启持久腿（台账逐项跨重启不漂移）。
 *
 * G1 联动：host 准入/mount 不经 PreLoad 五检链（preinstaller.ts:31-38 隔离
 * 宣言自证），SymbolIsolationCheck 在本面无触点——G1 不误报复验的 chaos 面
 * 载体 = chaos.spec.ts G3 块（kernel preLoad 面）；本文件不重复断言、不触碰
 * symbol-isolation* spec（G1 产物，勿触）。
 *
 * 运行姿态（SYNC-P3-CFIX）：boot 期出厂种子预装现由插件 Config `factorySeeds`
 * 门控，默认 `auto` = src 态跳过（src-launch compat 契约要求，见 src/index.ts
 * Config.factorySeeds）。本文件锁的命题含「pass 由 Service.init fire-and-forget
 * 发出而不阻断 boot」（上文 R-1.1.4 启动半），所以 bootRealLoader 显式钉
 * `factorySeeds: 'boot'`，让被测的仍是 boot 发出的那一趟 pass——姿态由 Config
 * 显式控制而非依赖运行模式探测。断言体一字未动。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { normalizePluginId } from '@deepseek-ai/dsh-plugin-governance'
import PluginGovernanceGateway, { type PluginGovernanceId } from '../src/index.ts'
import { SEED_SCHEMA_VERSION } from '../src/preinstall/seed.ts'

const storageRoots: string[] = []
const dirs: string[] = []
const contexts: Context[] = []
const seedFiles: string[] = []
let seedSeq = 0

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of storageRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const file of seedFiles.splice(0)) rmSync(file, { force: true })
  // REVIEW-G3 [建议]2（TC-B4-H1 面八）：挂起闸门会合点常规由各 it 内 finally
  // 收敛（removeHangGate）；it 级超时杀 worker 时 finally 不执行，留有理论残留
  // 窗口——这里在 dispose 与目录清理之后无条件全清，彻底封跨用例残留。纯防御
  // 性加固：正常路径 map 已空，clear() 为零行为变化（G3 44 例语义零触碰）。
  G3_GATES.clear()
})

/** A throwaway directory registered for cleanup. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gov-chaos-'))
  dirs.push(dir)
  return dir
}

/** The canonical governance id of one package/seed id (seed-key space). */
function cid(value: string): PluginGovernanceId {
  return normalizePluginId(value) as PluginGovernanceId
}

// ---- 八件谱单一真源：真 seed 读回（gate-p/preinstall-mount 同纪律） ----------

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
if (FULL_SEED.length === 0) {
  throw new Error('G3 preinstall chaos premise: zdsh-factory/seed.json declares no entries')
}

/** A seed document over given rows. F7 fixture root-posture migration
 * (TC-B4-H1 face 6): written directly under the tmpdir root so deriveRepoRoot
 * anchors repoRoot=tmpdir — the forged artifact dirs every row points at
 * (also under tmpdir, `local:` absolute) stay strictly inside the containment
 * root. Row shapes and assertions untouched; cleanup is per-file. */
function writeSeed(rows: readonly FullSeedRow[]): string {
  const path = join(tmpdir(), `gov-chaos-seed-${process.pid}-${seedSeq++}.json`)
  seedFiles.push(path)
  writeFileSync(path, JSON.stringify({ version: SEED_SCHEMA_VERSION, entries: rows }))
  return path
}

/**
 * One spectrum-wide scratch seed: every row re-pointed at a tmpdir forged
 * artifact (`local:` absolute), the culprit at its forged broken dir, the six
 * siblings at valid forges. `enabledAtBoot` forced true (sandbox posture,
 * gate-p P5 verticals precedent) — the production seed file is never touched.
 */
function spectrumSeed(culpritId: string, culpritDir: string, siblingForge: (row: FullSeedRow) => string): string {
  return writeSeed(FULL_SEED.map(row => (
    row.id === culpritId
      ? { ...row, source: `local:${culpritDir}`, enabledAtBoot: true }
      : { ...row, source: `local:${siblingForge(row)}`, enabledAtBoot: true }
  )))
}

// ---- tmpdir 伪造工件（禁触真装件：全部一次性目录，零真实工件读写） ----------

/** The dsh section every valid forge carries (service factory exit for mount). */
function validDsh(row: FullSeedRow): Record<string, unknown> {
  return {
    autoApprove: true,
    compatible: '>=0.0.0',
    capabilities: [{ type: 'service', service: { name: row.id.split('/')[1], factory: './index.js' } }],
  }
}

function writeForgeManifest(dir: string, row: FullSeedRow, dsh: unknown): void {
  // name = seed 行 package 字段 ⇒ normalizePluginId('dsh-xxx')='core/xxx' 与
  // seed id 逐一对齐（gate-p P1 对真工件已证同一映射；伪造件身份同源）。
  // type:module——forge 携 index.js（ESM），免 Node 重解析告警；admission 只读
  // name/version/dsh（manifestFromLocalSource），本字段对准入零影响。
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: row.package, version: row.version, type: 'module', dsh }))
}

/** A valid forge: admitted + mountable (apply registers one trivial effect). */
function validForge(row: FullSeedRow): string {
  const dir = scratch()
  writeForgeManifest(dir, row, validDsh(row))
  writeFileSync(join(dir, 'index.js'), [
    `export const name = 'g3-valid-${row.id.replace('/', '-')}'`,
    'export const inject = []',
    'export function apply(ctx) { ctx.effect(() => () => {}) }',
    '',
  ].join('\n'))
  return dir
}

/** 形态① forge: apply 同步 throw（cordis create 以 start failure 拒绝）。 */
function crashForge(row: FullSeedRow): string {
  const dir = scratch()
  writeForgeManifest(dir, row, validDsh(row))
  writeFileSync(join(dir, 'index.js'), [
    `export const name = 'g3-crash-${row.id.replace('/', '-')}'`,
    'export const inject = []',
    'export function apply() {',
    `  throw new Error('boom-g3:${row.id}')`,
    '}',
    '',
  ].join('\n'))
  return dir
}

// 形态②挂起闸门：fixture apply 经 globalThis 会合点（Map）挂起，测试端控制释放。
interface HangGate {
  started: boolean
  readonly promise: Promise<void>
  release(): void
}
const G3_GATES: Map<string, HangGate> = ((globalThis as { __g3ChaosGates?: Map<string, HangGate> }).__g3ChaosGates ??= new Map())

function installHangGate(key: string): HangGate {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  const gate: HangGate = { started: false, promise, release }
  G3_GATES.set(key, gate)
  return gate
}

function removeHangGate(key: string): void {
  G3_GATES.delete(key)
}

/**
 * 形态② forge: apply 挂起不返回（等闸门 promise）。**bounded release 形制**
 * （G3 裁决②）：本 forge 只服务「boot 不阻断 + 释放后全落定」两命题——
 * 它**不证明超时切断**；永久挂起在 host mount 层无切断 = G3-F1（见文件头注）。
 */
function hangForge(row: FullSeedRow, gateKey: string): string {
  const dir = scratch()
  writeForgeManifest(dir, row, validDsh(row))
  writeFileSync(join(dir, 'index.js'), [
    `export const name = 'g3-hang-${row.id.replace('/', '-')}'`,
    'export const inject = []',
    'export async function apply(ctx) {',
    `  const gate = globalThis.__g3ChaosGates.get(${JSON.stringify(gateKey)})`,
    '  gate.started = true',
    '  await gate.promise',
    '  ctx.effect(() => () => {})',
    '}',
    '',
  ].join('\n'))
  return dir
}

/** 形态③硬畸形 forge: package.json 截断不可解析（→ request-invalid failed 行）。 */
function hardMalformedForge(row: FullSeedRow): string {
  const dir = scratch()
  writeFileSync(join(dir, 'package.json'), `{ "name": ${JSON.stringify(row.package)}, "version": `)
  return dir
}

/** 形态③弱畸形 forge-a: dsh 段全缺 ⇒ capabilities 空表 ⇒ registry.validate fail-closed 拒绝（→ failed 行）。 */
function noDshForge(row: FullSeedRow): string {
  const dir = scratch()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: row.package, version: row.version }))
  return dir
}

/** 形态③弱畸形 forge-b: dsh 段退化——capabilities 非空（tool-only）但无 service factory 出口（→ installed + mount skipped）。 */
function toolOnlyForge(row: FullSeedRow): string {
  const dir = scratch()
  writeForgeManifest(dir, row, {
    autoApprove: true,
    compatible: '>=0.0.0',
    capabilities: [{ type: 'tool', tool: { name: `g3_tool_${row.id.split('/')[1]}`, description: 'G3 chaos forge: tool-only, no service factory exit', schema: { type: 'object' } } }],
  })
  return dir
}

// ---- gateway boot（真 cordis Loader，preinstall-mount 同形） ----------------

interface ChaosBoot {
  readonly ctx: Context
  readonly gateway: PluginGovernanceGateway
  readonly storageRoot: string
}

async function bootRealLoader(seedPath: string, storageRoot?: string): Promise<ChaosBoot> {
  const ctx = new Context()
  contexts.push(ctx)
  const { Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  await ctx.plugin(Loader)
  const root = storageRoot ?? mkdtempSync(join(tmpdir(), 'gov-chaos-home-'))
  if (storageRoot === undefined) storageRoots.push(root)
  // `factorySeeds: 'boot'` (SYNC-P3-CFIX) — 本文件的证明面显式声明为「boot 期
  // fire-and-forget pass 不阻断启动」（头注 R-1.1.4 启动半 + 挂起腿 :332-333），
  // 所以这里必须让 pass 由 Service.init 发出，而不是由下面的 settlePreinstall()
  // 补发。默认 `auto` 姿态在 src 态（vitest 跑 .ts）会跳过 boot pass——那是
  // src-launch compat 契约的要求（见 src/index.ts Config.factorySeeds），但会把
  // 本文件锁的命题静默换成 settle 缝命题。Config 显式钉住运行姿态 = 断言语义
  // 零改动的接线形（断言体一字未动）。
  const gateway = new PluginGovernanceGateway(ctx, { storageRoot: root, seedPath, factorySeeds: 'boot' })
  const self = gateway as unknown as Record<symbol, () => Promise<void>>
  await self[Service.init]!.call(self)
  return { ctx, gateway, storageRoot: root }
}

/** fail-open per-item 的「其余件照常装载」断言面：兄弟七件三列齐证。 */
function expectSiblingsMounted(gateway: PluginGovernanceGateway, culpritId: string, context: string): void {
  const report = gateway.preinstallReport()
  const roster = gateway.list().plugins
  for (const row of FULL_SEED) {
    if (row.id === culpritId) continue
    expect(report.entries[row.id]?.status, `${context}: ${row.id} 兄弟件准入被连坐`).toBe('installed')
    expect(report.entries[row.id]?.mount?.status, `${context}: ${row.id} 兄弟件应照常装载（fail-open per-item）`).toBe('mounted')
    expect(
      roster.find(plugin => plugin.pluginId === cid(row.id))?.status,
      `${context}: ${row.id} roster 面应 active`,
    ).toBe('active')
  }
}

// ============================================================================
// 形态① apply 崩（throw）×八件谱
// ============================================================================

describe.each(FULL_SEED)('G3-C4 host 崩形态（逐出厂件）：$id', (row) => {
  it('apply throw 只落肇事件 mount failed 行（归因可查询）；兄弟七件照常装载；boot 完成', async () => {
    const { gateway } = await bootRealLoader(spectrumSeed(row.id, crashForge(row), validForge))
    // boot 完成（R-1.1.4）：pass settle 不抛——单项 apply 崩永不阻断 boot。
    await gateway.settlePreinstall()

    const report = gateway.preinstallReport()
    // 肇事件双面相清：准入面 installed（manifest 合法——崩发生在运行期 apply，
    // 非准入）+ 运行面 mount failed，reason 携带肇事标记（台账逐项归因可查询）。
    expect(report.entries[row.id]?.status, `${row.id}: 准入面应 installed（崩在运行期 mount 面）`).toBe('installed')
    expect(report.entries[row.id]?.mount?.status, `${row.id}: apply 崩必须落 mount failed 行`).toBe('failed')
    expect(report.entries[row.id]?.mount?.reason, `${row.id}: 崩归因应可查询（含肇事标记）`).toContain(`boom-g3:${row.id}`)
    // roster 行在场（准入过）——失败只记运行面，不驱逐准入面。
    expect(
      gateway.list().plugins.some(plugin => plugin.pluginId === cid(row.id)),
      `${row.id}: 准入 roster 行应在场（mount 失败不改准入）`,
    ).toBe(true)
    // 兄弟七件照常装载（不连坐）。
    expectSiblingsMounted(gateway, row.id, `${row.id} 崩腿`)
  })
})

// ============================================================================
// 形态② apply 挂起 ×八件谱 —— bounded release 形制（G3 裁决②诚实标注：
// 本腿**不证明超时切断**。永久挂起在 host mount 层无切断 = G3-F1 已登记，
// 生产修归批次 4.2+ 独立裁决；超时切断的真 fail-open 证明在 kernel RunGuard
// 层兑现（chaos.spec.ts G3-C4 超时腿）。本腿证明面 = 挂起期间 boot 不阻断 +
// 读面活 + 前序兄弟在位；释放后 pass 全 settle + 台账逐项 + 兄弟零连坐。
// ============================================================================

describe.each(FULL_SEED)('G3-C4 host 挂起形态（逐出厂件，bounded release）：$id', (row) => {
  it('apply 挂起：boot 不阻断+读面活+前序兄弟在位；释放后全 settle 台账逐项【不证明超时切断=G3-F1】', async () => {
    const gateKey = `g3-hang-${row.id}`
    const gate = installHangGate(gateKey)
    const { gateway } = await bootRealLoader(spectrumSeed(row.id, hangForge(row, gateKey), validForge))
    // boot 完成（R-1.1.4 启动半）：Service.init 已返回（上一行）——pass 是
    // fire-and-forget，apply 挂起期间 gateway 读面完全可用。
    const settlePromise = gateway.settlePreinstall()
    try {
      await vi.waitFor(() => {
        expect(gate.started, `${row.id}: 挂起 apply 应已进入 mount 通道并挂起（注入生效前提）`).toBe(true)
      }, { timeout: 15_000, interval: 10 })
      // 挂起期间读面活（R-1.1.4「不崩」半）：roster/report 查询不抛。
      const duringRoster = gateway.list().plugins.map(plugin => String(plugin.pluginId))
      expect(duringRoster, `${row.id}: 肇事件准入行应先于 mount 挂起落 roster`).toContain(row.id)
      expect(() => gateway.preinstallReport(), '挂起期间 report 读面应可查询').not.toThrow()
      // pass 串行停摆 characterization（G3-F1 实证面，**非隔离证明**）：肇事者
      // 之后的 seed 序兄弟件在挂起期间尚未被处理（单锁串行、台账后置）；之前的
      // 兄弟件已在位——「单件异常不连坐兄弟件」的挂起期间已兑现半。
      const culpritIndex = FULL_SEED.findIndex(entry => entry.id === row.id)
      for (const earlier of FULL_SEED.slice(0, culpritIndex)) {
        expect(duringRoster, `${earlier.id}: 前序兄弟应在挂起期间已装载（零连坐）`).toContain(earlier.id)
      }
      for (const later of FULL_SEED.slice(culpritIndex + 1)) {
        expect(duringRoster, `${later.id}:〔G3-F1 表征〕挂起期间尚未被处理（pass 串行单锁，超时切断缺位）`).not.toContain(later.id)
      }
    } finally {
      // 释放闸门必须无条件执行（否则 pass 永挂 → 清理面连锁红）。
      gate.release()
      removeHangGate(gateKey)
    }
    // 释放后全 settle：pass 完成且不抛——「boot 完成 + 台账逐项」兑现面。
    await settlePromise
    const report = gateway.preinstallReport()
    expect(report.entries[row.id]?.status, `${row.id}: 准入面应 installed`).toBe('installed')
    // 今日生产契约：释放后 apply 正常完成 → mounted。本断言 ≠ 超时切断证明
    // （G3-F1）；若未来生产加 mount 超时包装（4.2+ 裁决域），此行将翻 failed
    // ——届时须显式 re-pin（TC-B2-23D 翻正先例纪律），禁静默漂移。
    expect(report.entries[row.id]?.mount?.status, `${row.id}: 释放后 apply 正常完成，mount 应落定（非超时切断证明，G3-F1）`).toBe('mounted')
    // 兄弟零连坐：全谱台账逐行 installed+mounted、roster active。
    expectSiblingsMounted(gateway, row.id, `${row.id} 挂起腿（释放后）`)
  }, 60_000)
})

// ============================================================================
// 形态③ 畸形 manifest ×八件谱 —— 分层判据 = admission 实际行为亲测（裁决④）
// ============================================================================

describe.each(FULL_SEED)('G3-C4 host 畸形 manifest 形态（逐出厂件）：$id', (row) => {
  it('硬畸形/dsh 缺损=failed 行（fail-closed 于伪装成功）；dsh 退化=准入+mount skipped；兄弟照常 boot 完成', async () => {
    // 亚形 a：硬畸形——package.json 截断不可解析 ⇒ request-invalid failed 行 +
    // 归因可查询；肇事件不入 roster；兄弟七件照常装载（A-1.1.4 语义的逐件
    // 枚举化：损坏工件 → boot 完成 + 台账原因 + 其余在位）。
    {
      const { gateway } = await bootRealLoader(spectrumSeed(row.id, hardMalformedForge(row), validForge))
      await gateway.settlePreinstall()
      const report = gateway.preinstallReport()
      expect(report.entries[row.id]?.status, `${row.id}: 硬畸形必须落 failed 行（fail-closed 于「伪装成功」）`).toBe('failed')
      expect(report.entries[row.id]?.reason, `${row.id}: 硬畸形归因应可查询（指向 package.json）`).toMatch(/package\.json/iu)
      expect(
        gateway.list().plugins.some(plugin => plugin.pluginId === cid(row.id)),
        `${row.id}: failed 件不得混入 roster`,
      ).toBe(false)
      expectSiblingsMounted(gateway, row.id, `${row.id} 硬畸形腿`)
    }
    // 亚形 b：dsh 段全缺 ⇒ capabilities 回退空表 ⇒ registry.validate
    // 「At least one capability required」fail-closed 拒绝（registry.ts:192-195，
    // 亲测纠正：非宽容准入）⇒ request-invalid failed 行（capability 归因，
    // index.ts:484-486）；肇事件不入 roster；兄弟照常——「dsh 缺损」不伪装成功。
    {
      const { gateway } = await bootRealLoader(spectrumSeed(row.id, noDshForge(row), validForge))
      await gateway.settlePreinstall()
      const report = gateway.preinstallReport()
      expect(report.entries[row.id]?.status, `${row.id}: dsh 段全缺 ⇒ 空能力被 validate 拒绝 ⇒ failed（fail-closed，非宽容准入）`).toBe('failed')
      expect(report.entries[row.id]?.reason, `${row.id}: dsh 缺损归因应可查询（指向能力表被拒）`).toMatch(/capabilit/iu)
      expect(
        gateway.list().plugins.some(plugin => plugin.pluginId === cid(row.id)),
        `${row.id}: 空能力被拒件不得混入 roster`,
      ).toBe(false)
      expectSiblingsMounted(gateway, row.id, `${row.id} 弱畸形（dsh 全缺→failed）腿`)
    }
    // 亚形 c：dsh 段退化——capabilities 非空（tool-only）但无 service factory
    // 出口 ⇒ 过 validate ⇒ installed；mountEntry resolveFactoryUrls 得空 ⇒
    // mount skipped（'no service factory'，既有 preinstall-mount「no-factory」
    // 绿测已证）。与亚形 b 的 failed 构成判别对：封「恒 failed / 恒 admitted」
    // 两侧逃逸（gate-p P4 判别对同纪律）。
    {
      const { gateway } = await bootRealLoader(spectrumSeed(row.id, toolOnlyForge(row), validForge))
      await gateway.settlePreinstall()
      const report = gateway.preinstallReport()
      expect(report.entries[row.id]?.status, `${row.id}: dsh 退化但能力非空 ⇒ 宽容准入 installed`).toBe('installed')
      expect(report.entries[row.id]?.mount?.status, `${row.id}: 无 service factory 出口 ⇒ mount skipped 而非 failed`).toBe('skipped')
      expect(report.entries[row.id]?.mount?.reason, `${row.id}: skipped 归因应指向无 service factory`).toMatch(/no service factory/iu)
      expect(
        gateway.list().plugins.find(plugin => plugin.pluginId === cid(row.id))?.status,
        `${row.id}: autoApprove 在场的退化件应 active（与亚形 b failed 互锁，封恒拒/恒纳）`,
      ).toBe('active')
      expectSiblingsMounted(gateway, row.id, `${row.id} 弱畸形（dsh 退化→skipped）腿`)
    }
  }, 30_000)
})

// ============================================================================
// A-1.1.4/P2 既有探针并入枚举——预装单项失败不阻断 boot 复验（重启持久腿）
// ============================================================================

describe('G3-C4 × A-1.1.4/P2 并入枚举 — 预装单项失败不阻断 boot 复验（八件谱）', () => {
  it('硬畸形肇事 + 七件正常：boot 完成、台账逐项、跨重启逐字节持久且 failed 行不复活为假成功', async () => {
    // 探针语义 = preinstall.spec.ts 'records a fail-open row for a broken
    // entry and still installs the rest'（A-1.1.4/R-1.1.4）+ gate-p P5
    // fail-open lock 的八件枚举化（并入不重造）；本腿增维度 = §9.4 重启
    // 逐字节纪律覆盖混沌行（failed 行跨重启不漂移、不复活、不假成功）。
    const culprit = FULL_SEED[0]!
    const seedPath = spectrumSeed(culprit.id, hardMalformedForge(culprit), validForge)
    const storageRoot = mkdtempSync(join(tmpdir(), 'gov-chaos-home-'))
    storageRoots.push(storageRoot)
    const resultsPath = join(storageRoot, 'data', 'preinstall-results.json')

    const boot1 = await bootRealLoader(seedPath, storageRoot)
    await boot1.gateway.settlePreinstall() // boot 完成：单项失败不阻断
    const report1 = boot1.gateway.preinstallReport()
    expect(report1.entries[culprit.id]?.status, `${culprit.id}: 硬畸形应落 failed 行`).toBe('failed')
    expect(report1.entries[culprit.id]?.reason, 'failed 归因应可查询（R-1.1.4 可查询失败）').toBeTruthy()
    expectSiblingsMounted(boot1.gateway, culprit.id, 'A-1.1.4 并入枚举腿 boot-1')
    expect(
      boot1.gateway.list().plugins.some(plugin => plugin.pluginId === cid(culprit.id)),
      'boot-1: failed 件不得混入 roster',
    ).toBe(false)
    const bytes1 = readFileSync(resultsPath, 'utf8')

    // 重启（同 storage 同 seed）：failed 行重试仍 failed（同归因 ⇒ 行不变 ⇒
    // 台账逐字节）；七件正常行 isRegistered 短路 ⇒ 零动作；无复活、无假成功。
    const boot2 = await bootRealLoader(seedPath, storageRoot)
    await boot2.gateway.settlePreinstall() // 重启 boot 同样不被单项失败阻断
    expect(readFileSync(resultsPath, 'utf8'), '台账跨重启必须逐字节（§9.4 纪律覆盖混沌行）').toBe(bytes1)
    const report2 = boot2.gateway.preinstallReport()
    expect(report2.entries[culprit.id]?.status, 'boot-2: failed 行不得复活为 installed').toBe('failed')
    expectSiblingsMounted(boot2.gateway, culprit.id, 'A-1.1.4 并入枚举腿 boot-2')
  }, 30_000)
})
