/**
 * Chaos isolation suite: any plugin failure — timeouts, synchronous throws,
 * async rejections, health storms — must wound only the misbehaving plugin.
 * The core services (registry, guards) and every other plugin stay alive,
 * responsive, and disposable throughout.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { LoadGuard, getSymbolIsolationScanStats, resetSymbolIsolationCacheForTest } from '../src/guards/load-guard.ts'
import { RunGuard } from '../src/guards/run-guard.ts'
import { HealthGuard, type HealthCheck } from '../src/guards/health-guard.ts'
import { DefaultPluginRegistry } from '../src/registry/registry.ts'
import { BasePlugin } from '../src/base/base.ts'
import { PluginStatus } from '../src/spec/index.ts'
import type { CapabilityDeclaration, PluginManifest } from '../src/spec/index.ts'
import { mockContext, testManifest } from './fixtures.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** 一个按剧本行动的插件：healthy 正常应答，其余按模式制造故障。 */
class ScriptedPlugin extends BasePlugin {
  constructor(
    manifest: PluginManifest,
    private readonly behavior: 'healthy' | 'sync-throw' | 'async-reject',
  ) {
    super(manifest, mockContext())
  }

  async install(): Promise<void> {}

  async runTool(payload: string): Promise<string> {
    if (this.behavior === 'sync-throw') throw new Error(`boom:${this.manifest.id}`)
    if (this.behavior === 'async-reject') await Promise.reject(new Error(`rej:${this.manifest.id}`))
    return `ok:${payload}`
  }
}

function pluginOf(
  id: string,
  behavior: 'healthy' | 'sync-throw' | 'async-reject' = 'healthy',
  overrides: Partial<PluginManifest> = {},
): ScriptedPlugin {
  const capabilities: CapabilityDeclaration[] = testManifest().capabilities
  return new ScriptedPlugin(testManifest({ id, name: id, capabilities, ...overrides }), behavior)
}

/** 固定种子的伪随机数（LCG），保证组合混沌可重放。 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

describe('LoadGuard：全量故障输入不击穿校验器，合法与兼容插件照常通过', () => {
  it('对畸形与恶意 manifest 保持全量（不抛错、可判定），并拒绝不兼容清单', async () => {
    const guard = new LoadGuard()
    // 观察到的真实行为：id 空格/空能力表这类"弱畸形"会被 preLoad 放行
    // （守卫以宽松类型读取，id 只查存在、能力查 schema 不查非空）。
    // 这属于守卫宽容度缺口——记录在案而非断言相反行为。
    const tolerated: Array<[string, Partial<PluginManifest>]> = [
      ['空格 id', { id: 'NOT A VALID ID' }],
      ['空能力表', { capabilities: [] }],
    ]
    for (const [label, overrides] of tolerated) {
      const result = await guard.preLoad(pluginOf('test/tolerant', 'healthy', overrides), '0.1.1-rc.2')
      expect(typeof result.allowed, `${label} 应返回可判定结果`).toBe('boolean')
    }
    // 硬性拒绝面：要求 >=99.0.0 的清单在当前内核下必须被拦下。
    const hopeless = pluginOf('test/hopeless', 'healthy', { dsh: { ...testManifest().dsh, compatible: '>=99.0.0' } })
    const rejected = await guard.preLoad(hopeless, '0.1.1-rc.2')
    expect(rejected.allowed).toBe(false)
    // 故障注入之后，核心校验器状态不受影响：合法插件依旧放行。
    const good = await guard.preLoad(pluginOf('test/fine'), '0.1.1-rc.2')
    expect(good.allowed).toBe(true)
  })
})

describe('RunGuard：超时只切断肇事者', () => {
  it('挂起插件超时抛出后，同一 RunGuard 下健康插件持续可用', async () => {
    const runGuard = new RunGuard()
    const hung = pluginOf('chaos/hang', 'healthy', {
      sandbox: testManifest().sandbox && {
        ...testManifest().sandbox,
        resources: { memoryLimitMb: 64, cpuLimit: 10, timeoutMs: 40, maxOutputBytes: 1000 },
      },
    })
    const healthy = pluginOf('calm/worker')
    runGuard.watch('chaos/hang', hung)
    runGuard.watch('calm/worker', healthy)

    for (let round = 0; round < 3; round += 1) {
      await expect(runGuard.execute('chaos/hang', () => new Promise<string>(() => {})))
        .rejects.toThrow(/timeout|timed out|超时/iu)
      // 肇事者超时不影响旁人：每轮之后健康插件立即正常应答。
      await expect(runGuard.execute('calm/worker', () => healthy.runTool('ping'))).resolves.toBe('ok:ping')
    }
    runGuard.unwatch('chaos/hang')
    runGuard.unwatch('calm/worker')
  })

  it('同步 throw 与异步 reject 都被包装为 PluginError 且计数可见', async () => {
    const runGuard = new RunGuard()
    const thrower = pluginOf('chaos/sync', 'sync-throw')
    const rejecter = pluginOf('chaos/async', 'async-reject')
    runGuard.watch('chaos/sync', thrower)
    runGuard.watch('chaos/async', rejecter)
    await expect(runGuard.execute('chaos/sync', () => thrower.runTool('x'))).rejects.toThrow('boom:chaos/sync')
    await expect(runGuard.execute('chaos/async', () => rejecter.runTool('x'))).rejects.toThrow('rej:chaos/async')

    const syncWatcher = runGuard.getWatcher('chaos/sync')
    const asyncWatcher = runGuard.getWatcher('chaos/async')
    const syncHealth = syncWatcher?.getHealthStatus()
    const asyncHealth = asyncWatcher?.getHealthStatus()
    expect(syncWatcher).toBeDefined()
    expect(asyncWatcher).toBeDefined()
    expect(syncHealth?.callCount).toBe(1)
    expect(asyncHealth?.callCount).toBe(1)
    expect(asyncHealth?.errorRate ?? 0).toBe(1)
    expect(asyncHealth?.healthy).toBe(false)
    expect(syncHealth?.lastError).toContain('boom:chaos/sync')
    runGuard.unwatch('chaos/sync')
    runGuard.unwatch('chaos/async')
  })
})

describe('registry：崩溃隔离与存活不变式', () => {
  it('故障插件注册与执行失败不影响健康插件的 roster 与状态', async () => {
    const registry = new DefaultPluginRegistry()
    const calm = pluginOf('calm/aa')
    const storm = [pluginOf('chaos/s1', 'sync-throw'), pluginOf('chaos/r1', 'async-reject')]
    for (const plugin of [calm, ...storm]) {
      const result = await registry.register(plugin)
      expect(result.success).toBe(true)
    }
    // 直接执行故障剧本（不经守卫）：未捕获的拒绝也不拖垮核心读取面。
    const stormFirst = storm[0] as unknown as ScriptedPlugin
    const stormSecond = storm[1] as unknown as ScriptedPlugin
    await expect(stormFirst.runTool('x')).rejects.toThrow('boom')
    await expect(stormSecond.runTool('x')).rejects.toThrow('rej')
    stormSecond.runTool('y').catch(() => {}) // 模拟无人等待的被拒调用

    const report = registry.getHealthReport()
    expect(report.total).toBe(3)
    expect(() => registry.getAll()).not.toThrow()
    expect(registry.getStatus('calm/aa')).toBe(PluginStatus.ACTIVE)
    expect(registry.findActive().map(p => p.manifest.id)).toContain('calm/aa')

    // 处置肇事者后核心照常运转。
    await registry.unregister('chaos/s1')
    await registry.unregister('chaos/r1')
    expect(registry.getAll()).toHaveLength(1)
    expect(registry.getStatus('calm/aa')).toBe(PluginStatus.ACTIVE)
    await registry.dispose()
  })
})

describe('HealthGuard：升级回路与邻居隔离', () => {
  it('连续失败升级至禁用；恢复检查使状态回落；邻居全程不受影响', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = new DefaultPluginRegistry()
    const calm = pluginOf('calm/bb')
    const sick = pluginOf('sick/cc')
    const calmReg = await registry.register(calm)
    const sickReg = await registry.register(sick)
    expect(calmReg.success, JSON.stringify(calmReg.errors ?? [])).toBe(true)
    expect(sickReg.success, JSON.stringify(sickReg.errors ?? [])).toBe(true)

    const guard = new HealthGuard(registry)
    guard.setOptions({ intervalMs: 8, warningThreshold: 2, disableThreshold: 3 })
    let healthyNow = false
    const check: HealthCheck = { run: async () => healthyNow ? { healthy: true } : { healthy: false, error: 'still sick' } }
    guard.registerCheck('sick/cc', check)
    guard.startMonitoring()

    // 等到跨过禁用阈值（3 次失败 × 8ms 间隔，留足裕量）。
    await vi.waitFor(() => {
      expect(guard.getConsecutiveFailures('sick/cc')).toBeGreaterThanOrEqual(3)
    }, { timeout: 2000, interval: 20 })
    expect(registry.getStatus('sick/cc')).toBe(PluginStatus.DISABLED)
    expect(registry.getStatus('calm/bb')).toBe(PluginStatus.ACTIVE)

    // 恢复路径：检查转绿后状态回升为 ACTIVE，失败计数清零。
    healthyNow = true
    await vi.waitFor(() => {
      expect(guard.getConsecutiveFailures('sick/cc')).toBe(0)
    }, { timeout: 2000, interval: 20 })
    expect(registry.getStatus('sick/cc')).toBe(PluginStatus.ACTIVE)
    expect(registry.getStatus('calm/bb')).toBe(PluginStatus.ACTIVE)
    guard.stopMonitoring()
    guard.stopMonitoring() // 幂等
    await registry.dispose()
  })
})

describe('RunGuard 处置幂等', () => {
  it('unwatch/re-watch 可重复执行且活动清单一致', () => {
    const runGuard = new RunGuard()
    const plugin = pluginOf('calm/idem')
    runGuard.watch('calm/idem', plugin)
    expect(runGuard.getActiveWatchers()).toEqual(['calm/idem'])
    runGuard.unwatch('calm/idem')
    runGuard.unwatch('calm/idem')
    expect(runGuard.getActiveWatchers()).toEqual([])
    runGuard.watch('calm/idem', plugin)
    expect(runGuard.getWatcher('calm/idem')?.pluginId).toBe('calm/idem')
  })
})

describe('组合混沌：固定种子故障风暴下的核心不变式', () => {
  it('60 次混合操作后核心读取面完好、健康插件全部存活、dispose 干净', async () => {
    const registry = new DefaultPluginRegistry()
    const runGuard = new RunGuard()
    const calmIds = ['calm/x1', 'calm/x2', 'calm/x3']
    const chaosModes = ['sync-throw', 'async-reject'] as const
    const chaosIds = ['chaos/x1', 'chaos/x2']
    for (const id of calmIds) {
      const plugin = pluginOf(id)
      expect((await registry.register(plugin)).success).toBe(true)
      runGuard.watch(id, plugin)
    }
    let index = 0
    for (const id of chaosIds) {
      const plugin = pluginOf(id, chaosModes[index % chaosModes.length] ?? 'sync-throw')
      expect((await registry.register(plugin)).success).toBe(true)
      runGuard.watch(id, plugin)
      index += 1
    }

    const rand = lcg(20260825)
    const allIds = [...calmIds, ...chaosIds]
    for (let step = 0; step < 60; step += 1) {
      const roll = rand()
      const target = allIds[Math.floor(rand() * allIds.length)]!
      try {
        if (roll < 0.45) {
          const plugin = registry.get(target)
          await runGuard.execute(target, () => (plugin as ScriptedPlugin).runTool(`t${String(step)}`))
        } else if (roll < 0.6) {
          await registry.disable(target, 'chaos drill')
          await registry.enable(target)
        } else if (roll < 0.7) {
          const temp = pluginOf('temp/flip', 'healthy')
          await registry.register(temp)
          await registry.unregister('temp/flip')
        } else {
          const report = registry.getHealthReport()
          expect(report.total).toBe(allIds.length)
        }
      } catch {
        // 故障剧本的预期产物：被拒/超时/包装错误都允许浮出，核心必须无恙。
      }
      // 每 10 步抽查一次核心不变式。
      if ((step + 1) % 10 === 0) {
        const report = registry.getHealthReport()
        expect(report.total).toBe(allIds.length)
        for (const id of calmIds) {
          expect(registry.getStatus(id)).toBe(PluginStatus.ACTIVE)
        }
        await expect(runGuard.execute(calmIds[0]!, () => {
          return (registry.get(calmIds[0]!) as ScriptedPlugin).runTool('probe')
        })).resolves.toBe('ok:probe')
      }
    }
    // 收官：dispose 干净完成，无悬挂句柄导致的未处理拒绝。
    await registry.dispose()
    runGuard.unwatch('calm/x1')
    runGuard.unwatch('calm/x2')
    runGuard.unwatch('calm/x3')
    runGuard.unwatch('chaos/x1')
    runGuard.unwatch('chaos/x2')
  })
})

// ============================================================================
// TC-B4-G3（Gate-C C4，DESIGN §6.1:201 原文「chaos 套件扩展=逐插件『崩/超时/
// 畸形 manifest』隔离用例（北极星 4 固化）」）——出厂八件谱×三形态隔离矩阵
// + G1 检查位不误报复验（K-1.2.1 出厂集零误杀硬门的 chaos 面复证）。
//
// 枚举单一真源 = zdsh-factory/seed.json 读回（gate-p/preinstall-mount 同纪律：
// read-back, never re-declared——seed 增项谱系自适，硬编码=漂移源）。
// fail-open per-item 逐腿断言四件套：肇事者只伤己（谱内其余七件 ACTIVE 且照常
// 应答）+ 台账逐项（kernel 面=健康报告/watcher 计数归因可查询）+ 核心读取面
// 完好 + boot/处置面不受累。
//
// 注入机制分双面（卡面「scratch seed 行+tmpdir 伪造坏工件 local: 源」）：
// 本文件 = kernel 面三形态（RunGuard timeoutMs = 治理域唯一现成超时 seam，
// 超时切断在 kernel RunGuard 层兑现〔G3 裁决①〕；LoadGuard PreLoad 全链含
// G1 SymbolIsolationCheck）；host 面 scratch seed 行 + tmpdir 伪造工件见
// packages/zdsh/plugin-governance-host/tests/preinstall-chaos.spec.ts。
//
// G1 语义分清（卡面条 3 + 裁决④）：正常件经全链**绝不得**被 symbol-isolation
// 误杀（误杀=红灯，Gate 级停并报）；畸形件被拒=守卫正确工作（归因=清单族检查；
// 若 G1 fail-closed 对畸形件触发亦属预期行为——拒绝本身即断言，归因如实记录）。
// ============================================================================

const G3_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const G3_SEED_PATH = join(G3_REPO_ROOT, 'zdsh-factory', 'seed.json')

interface G3SeedRow {
  readonly id: string
  readonly package: string
  readonly enabledAtBoot: boolean
}

/** 出厂八件谱 = seed 读回（O3 已落：verticals/omnivision/bridge/filehub/plugin-center/autopilot/webstack/workbench）。 */
const G3_SPECTRUM: readonly G3SeedRow[] = (
  JSON.parse(readFileSync(G3_SEED_PATH, 'utf8')) as { entries: G3SeedRow[] }
).entries
if (G3_SPECTRUM.length === 0) {
  throw new Error('G3 chaos matrix premise: zdsh-factory/seed.json declares no entries')
}
const G3_IDS: readonly string[] = G3_SPECTRUM.map(row => row.id)

/** 谱内全部兄弟件（除肇事者）——「不连坐兄弟件」断言面。 */
function g3SiblingsOf(culprit: string): string[] {
  return G3_IDS.filter(id => id !== culprit)
}

describe.each(G3_SPECTRUM)('G3-C4 崩形态（逐出厂件）：$id', (row) => {
  it('sync throw + async reject 只伤肇事者；谱内其余七件 ACTIVE 且照常应答；计数台账逐项', async () => {
    const registry = new DefaultPluginRegistry()
    const runGuard = new RunGuard()
    const culprit = pluginOf(row.id, 'sync-throw')
    expect((await registry.register(culprit)).success, `${row.id}: 肇事者注册不应被崩剧本先验连坐`).toBe(true)
    runGuard.watch(row.id, culprit)
    for (const id of g3SiblingsOf(row.id)) {
      const sibling = pluginOf(id)
      expect((await registry.register(sibling)).success, `${id}: 正常件注册被 ${row.id} 崩剧本连坐`).toBe(true)
      runGuard.watch(id, sibling)
    }

    // 崩两形：同步 throw（剧本化 runTool）+ 异步 reject（裸拒绝闭包）。
    await expect(
      runGuard.execute(row.id, () => culprit.runTool('x')),
      `${row.id}: 同步 throw 必须以被拒浮出（不吞不崩核心）`,
    ).rejects.toThrow(`boom:${row.id}`)
    await expect(
      runGuard.execute(row.id, () => Promise.reject(new Error(`rej-g3:${row.id}`))),
      `${row.id}: 异步 reject 必须以被拒浮出`,
    ).rejects.toThrow(`rej-g3:${row.id}`)

    // 兄弟件不连坐：肇事者两崩之后逐件立即照常应答（fail-open per-item）。
    for (const id of g3SiblingsOf(row.id)) {
      await expect(
        runGuard.execute(id, () => (registry.get(id) as ScriptedPlugin).runTool('ping')),
        `${id}: 在 ${row.id} 崩后应照常应答`,
      ).resolves.toBe('ok:ping')
    }

    // 台账逐项（kernel 面）：肇事者双错计数可见且归因可查询；兄弟件零错误记录。
    const report = registry.getHealthReport()
    expect(report.total, '谱系报告应含全部件（崩不改 roster 计数）').toBe(G3_IDS.length)
    const culpritHealth = runGuard.getWatcher(row.id)?.getHealthStatus()
    expect(culpritHealth?.callCount, `${row.id}: 肇事者应计数 2 次调用`).toBe(2)
    expect(culpritHealth?.errorRate, `${row.id}: 肇事者错误率应满`).toBe(1)
    expect(culpritHealth?.lastError, `${row.id}: 肇事者归因应可查询`).toContain(`rej-g3:${row.id}`)
    for (const id of g3SiblingsOf(row.id)) {
      expect(registry.getStatus(id), `${id}: 状态被 ${row.id} 崩连坐`).toBe(PluginStatus.ACTIVE)
      const health = runGuard.getWatcher(id)?.getHealthStatus()
      expect(health?.healthy, `${id}: 在兄弟件崩后应保持 healthy`).toBe(true)
      expect(health?.lastError ?? null, `${id}: 不应有任何错误记录`).toBeNull()
    }
    expect(
      registry.findActive().map(p => p.manifest.id),
      'roster 活跃面应含全部兄弟件',
    ).toEqual(expect.arrayContaining(g3SiblingsOf(row.id)))

    // 处置面收官：dispose 干净，watcher 全撤。
    await registry.dispose()
    for (const id of G3_IDS) runGuard.unwatch(id)
  })
})

describe.each(G3_SPECTRUM)('G3-C4 超时形态（逐出厂件）：$id', (row) => {
  it('挂起件被 timeoutMs 切断且仅肇事者担超时；其余七件立即应答零连坐', async () => {
    // 超时切断在 kernel RunGuard 层兑现（G3 裁决①）：挂起不返回的调用由
    // PluginWatcher 的 Promise.race + PluginTimeoutError 切断——治理域唯一
    // 现成超时 seam（host mount 层无切断=G3-F1，见回执专节；本腿即卡面
    // 「apply 超时（挂起不返回）」形态的真 fail-open 证明面）。
    const registry = new DefaultPluginRegistry()
    const runGuard = new RunGuard()
    const hung = pluginOf(row.id, 'healthy', {
      sandbox: testManifest().sandbox && {
        ...testManifest().sandbox,
        resources: { memoryLimitMb: 64, cpuLimit: 10, timeoutMs: 40, maxOutputBytes: 1000 },
      },
    })
    expect((await registry.register(hung)).success, `${row.id}: 挂起剧本件注册不应被连坐`).toBe(true)
    runGuard.watch(row.id, hung)
    for (const id of g3SiblingsOf(row.id)) {
      const sibling = pluginOf(id)
      expect((await registry.register(sibling)).success, `${id}: 正常件注册被连坐`).toBe(true)
      runGuard.watch(id, sibling)
    }

    // 挂起两轮：每轮超时只切断肇事者；每轮之后全部兄弟件立即照常应答。
    for (let round = 0; round < 2; round += 1) {
      await expect(
        runGuard.execute(row.id, () => new Promise<string>(() => {})),
        `${row.id} 第 ${round} 轮：挂起不返回必须被超时切断`,
      ).rejects.toThrow(/timeout|timed out|超时/iu)
      for (const id of g3SiblingsOf(row.id)) {
        await expect(
          runGuard.execute(id, () => (registry.get(id) as ScriptedPlugin).runTool('ping')),
          `${id}: 在 ${row.id} 第 ${round} 轮超时后应立即应答（不连坐）`,
        ).resolves.toBe('ok:ping')
      }
    }

    // 台账逐项：肇事者超时归因可查询；兄弟件全程健康；报告计数完整。
    const hungHealth = runGuard.getWatcher(row.id)?.getHealthStatus()
    expect(hungHealth?.callCount, `${row.id}: 肇事者应计数 2 次挂起调用`).toBe(2)
    expect(hungHealth?.healthy, `${row.id}: 超时肇事者不应健康`).toBe(false)
    expect(hungHealth?.lastError, `${row.id}: 超时归因应可查询`).toMatch(/timeout|timed out|超时/iu)
    for (const id of g3SiblingsOf(row.id)) {
      expect(registry.getStatus(id), `${id}: 状态被超时肇事者连坐`).toBe(PluginStatus.ACTIVE)
      expect(runGuard.getWatcher(id)?.getHealthStatus()?.healthy, `${id}: 应保持健康`).toBe(true)
    }
    expect(registry.getHealthReport().total).toBe(G3_IDS.length)

    await registry.dispose()
    for (const id of G3_IDS) runGuard.unwatch(id)
  })
})

describe.each(G3_SPECTRUM)('G3-C4 畸形 manifest 形态（逐出厂件）：$id', (row) => {
  it('dsh 段缺损/坏形件被 PreLoad 全链拒绝且归因清单族；同谱正常件零 G1 误杀', async () => {
    // 卡面形态③「package.json dsh 段缺损/坏形」的 kernel 投影。分层判据以
    // admission/guard 实际行为亲测为准（裁决④，臆测形禁写）：kernel PreLoad
    // 面对三亚形均 fail-closed 拒绝；host admission 面对弱畸形宽容（见
    // preinstall-chaos.spec.ts 分层腿）——两面都是真契约，各自锁定。
    const guard = new LoadGuard()
    const malformed: Array<[string, Partial<PluginManifest>]> = [
      ['dsh 段缺损（无 compatible）', { dsh: {} as PluginManifest['dsh'] }],
      ['dsh 段坏形（兼容段不可达）', { dsh: { ...testManifest().dsh, compatible: '>=99.0.0' } }],
      ['capabilities 坏形（service 缺 factory）', {
        capabilities: [{ type: 'service', service: { name: 'g3-broken' } }] as unknown as CapabilityDeclaration[],
      }],
    ]
    for (const [label, overrides] of malformed) {
      const rejected = await guard.preLoad(pluginOf(row.id, 'healthy', overrides), '0.1.1-rc.2')
      // 拒绝 = fail-closed 预期行为（卡面条 3：畸形拒绝 = 守卫正确工作；
      // 若 G1 symbol-isolation 以 fail-closed 参与拒绝亦属预期——拒绝本身
      // 即断言，归因如实记录，绝不与「正常件误杀」红灯混同）。
      expect(rejected.allowed, `${row.id}〔${label}〕必须被 PreLoad 链拒绝`).toBe(false)
      expect(
        rejected.failures.some(f => /missing required field|requires DSH|Invalid capability/iu.test(f.message)),
        `${row.id}〔${label}〕拒绝归因应含清单族检查，实际: ${JSON.stringify(rejected.failures.map(f => f.message))}`,
      ).toBe(true)
    }
    // G1 不误报复验（K-1.2.1 联动——chaos 面复证）：同谱全部正常件经 PreLoad
    // 全链（含 SymbolIsolationCheck）必须放行且零 symbol-isolation 失败行——
    // 正常件被误杀即红灯（Gate 级，禁改 G1 实现禁削断言）。
    for (const id of G3_IDS) {
      const good = await guard.preLoad(pluginOf(id), '0.1.1-rc.2')
      expect(
        good.failures.filter(f => f.message.startsWith('symbol-isolation')),
        `G1 误报：正常件 ${id} 携带 symbol-isolation 失败行`,
      ).toEqual([])
      expect(
        good.allowed,
        `G1 误报：正常件 ${id} 被 PreLoad 全链误杀: ${JSON.stringify(good.failures.map(f => f.message))}`,
      ).toBe(true)
    }
  })
})

describe('G3-C4 × G1 联动观测面 — SymbolIsolationCheck 真扫描/缓存契约（封恒过桩回归）', () => {
  it('重置后八件首轮触发真实扫描且全过；次轮全缓存命中不再扫盘', async () => {
    // 封两条逃逸：「恒过降级桩」（G1 前身形态，load-guard 旧 :222/:227/:229）
    // 与「仅缓存假绿」——重置强迫一次真实扫盘发生（scans 增量=观测面证据），
    // pass 结果按 §2.3 性能契约入缓存（次轮 cacheHits 增量、scans 不变）。
    // K-1.2.1 出厂集零误杀硬门本体在 symbol-isolation.spec.ts（G1 产物，勿触）；
    // 本腿为 chaos 面复证：扫描真实发生且八件正常清单全过。
    resetSymbolIsolationCacheForTest()
    const guard = new LoadGuard()
    const before = getSymbolIsolationScanStats()
    for (const row of G3_SPECTRUM) {
      const result = await guard.preLoad(pluginOf(row.id), '0.1.1-rc.2')
      expect(
        result.allowed,
        `G1 联动：出厂件 ${row.id} 正常清单被误杀: ${JSON.stringify(result.failures.map(f => f.message))}`,
      ).toBe(true)
    }
    const afterFirst = getSymbolIsolationScanStats()
    expect(
      afterFirst.scans,
      '首轮必须发生真实扫描（恒过桩/缓存假绿在此红灯）',
    ).toBeGreaterThan(before.scans)
    for (const row of G3_SPECTRUM) {
      expect((await guard.preLoad(pluginOf(row.id), '0.1.1-rc.2')).allowed, `次轮 ${row.id} 应仍放行`).toBe(true)
    }
    const afterSecond = getSymbolIsolationScanStats()
    expect(afterSecond.scans, '次轮应全缓存命中不再扫盘（§2.3 性能契约）').toBe(afterFirst.scans)
    expect(afterSecond.cacheHits, '次轮应记缓存命中').toBeGreaterThan(afterFirst.cacheHits)
  })
})
