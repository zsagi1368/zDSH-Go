/** 诊断：runDoctor 编排 + renderDoctor 双语渲染快照断言（W-B-113/114）。 */
import { describe, expect, it } from 'vitest'
import { SearchCache } from '../src/cache/store.ts'
import { prescriptionKeyFor, renderDoctor, runDoctor } from '../src/diag/doctor.ts'
import { BaseEngine } from '../src/engines/engine.ts'
import { doctorMessagesEn, doctorMessagesZh } from '../src/i18n/doctor.ts'
import { engineError } from '../src/kernel/errors.ts'
import { EngineRegistry } from '../src/kernel/registry.ts'
import type {
  CapabilityBitmap,
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  TierMode,
} from '../src/kernel/types.ts'

const REQ: EngineSearchRequest = {
  query: 'doctor probe',
  hints: { topic: 'doctor probe', hard: [], soft: [] },
  count: 3,
  layer: 'free',
  band: 'simple',
}

/** 最小脚本化引擎（恒抛注入错误；不触真实管道）。 */
class ScriptedEngine extends BaseEngine {
  constructor(
    id: string,
    private readonly failure: () => Error,
  ) {
    super({
      id,
      kind: 'search',
      tier: 'free',
      caps: {},
      cost: { keysRequired: 0 },
      latencyBudgetMs: 10,
    } as EngineDescriptor)
  }
  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    return await this.runSearch(req, async () => {
      throw this.failure()
    })
  }
}

const BITMAP: CapabilityBitmap = {
  webSeam: true,
  selectorPatchable: false,
  settingsSection: true,
  inputSlot: false,
  credentialsDomain: false,
  storageService: false,
  bridgeOnline: false,
}

function makeRegistry(): EngineRegistry {
  return new EngineRegistry()
}

describe('runDoctor 结构化报告', () => {
  it('空注册表 + 零缓存计数基线', () => {
    const report = runDoctor({
      bitmap: BITMAP,
      tier: 'coexist',
      registry: makeRegistry(),
      cache: new SearchCache(),
    })
    expect(report.tier).toBe('coexist')
    expect(report.engines).toEqual([])
    expect(report.cache).toEqual({ hits: 0, misses: 0, size: 0 })
  })

  it('配置面已知但未注册的引擎以 unwired 态列出', () => {
    const report = runDoctor({
      bitmap: BITMAP,
      tier: 'diagnostic',
      registry: makeRegistry(),
      cache: new SearchCache(),
      configuredEngineIds: ['ddg'],
    })
    expect(report.engines).toEqual([{ id: 'ddg', state: 'unwired' }])
  })

  it('冷却中的引擎带剩余毫秒与 lastCode（经真实错误路径制造）', async () => {
    const registry = makeRegistry()
    const limited = new ScriptedEngine('ddg', () =>
      engineError('rate-limited', '429', { engineId: 'ddg' }),
    )
    registry.register(limited)
    await registry.runWithFallback(REQ).catch(() => undefined)

    const report = runDoctor({
      bitmap: BITMAP,
      tier: 'coexist',
      registry,
      cache: new SearchCache(),
    })
    const entry = report.engines.find(e => e.id === 'ddg')
    expect(entry?.state).toBe('cooldown')
    expect(entry?.cooldownRemainingMs).toBeGreaterThan(0)
    expect(entry?.lastCode).toBe('rate-limited')
  })

  it('prescriptionKeyFor 数据化派生三档处方键', () => {
    for (const tier of ['takeover', 'coexist', 'diagnostic'] as readonly TierMode[]) {
      expect(prescriptionKeyFor(tier)).toBe(`webstack.doctor.rx.${tier}`)
    }
  })
})

describe('renderDoctor 双语渲染快照断言', () => {
  const REPORT = runDoctor({
    bitmap: BITMAP,
    tier: 'coexist',
    registry: makeRegistry(),
    cache: new SearchCache(),
    configuredEngineIds: ['ddg', 'bing-lite', 'searxng'],
  })

  it('zh 渲染包含档位、处方、未接线引擎与缓存统计', () => {
    const text = renderDoctor(REPORT, 'zh')
    expect(text).toContain('WebStack 引擎体检报告')
    expect(text).toContain('运行档位：共存')
    expect(text).toContain('DSH_WEB_SEARCH_PROVIDER')
    expect(text).toContain('[未接线] ddg')
    expect(text).toContain('[未接线] bing-lite')
    expect(text).toContain('缓存统计：命中 0 次 / 未命中 0 次 / 当前条目 0 条')
  })

  it('en 渲染镜像同结构（英文文案）', () => {
    const text = renderDoctor(REPORT, 'en')
    expect(text).toContain('WebStack engine doctor report')
    expect(text).toContain('Tier mode: coexist')
    expect(text).toContain('[UNWIRED] searxng')
    expect(text).toContain('Cache stats: 0 hits / 0 misses / 0 entries')
  })

  it('未知 locale 安全回落中文', () => {
    const text = renderDoctor(REPORT, 'fr' as never)
    expect(text).toContain('运行档位：共存')
  })

  it('冷却态渲染含秒数占位替换', () => {
    const text = renderDoctor(
      {
        tier: 'coexist',
        engines: [
          {
            id: 'bing-lite',
            state: 'cooldown',
            cooldownRemainingMs: 61_000,
            lastCode: 'rate-limited',
          },
        ],
        cache: { hits: 3, misses: 1, size: 2 },
      },
      'zh',
    )
    expect(text).toContain('[冷却] bing-lite（约 61 秒后自动恢复）')
    expect(text).toContain('上次错误码 rate-limited')
    expect(text).toContain('缓存统计：命中 3 次 / 未命中 1 次 / 当前条目 2 条')
  })

  it('doctor 文案 zh/en 键集奇偶一致（W-B-79 锁死）', () => {
    expect(Object.keys(doctorMessagesZh).toSorted()).toEqual(
      Object.keys(doctorMessagesEn).toSorted(),
    )
  })

  it('处方键在两册文案中均存在（数据化规则完整性）', () => {
    for (const tier of ['takeover', 'coexist', 'diagnostic'] as readonly TierMode[]) {
      const key = prescriptionKeyFor(tier)
      expect(doctorMessagesZh[key]).toBeTruthy()
      expect(doctorMessagesEn[key]).toBeTruthy()
    }
  })
})
