/** 引擎适配器公共面：免费池清单、描述符冻结、BaseEngine 统一包装行为。 */
import { describe, expect, it } from 'vitest'
import { BING_LITE_DESCRIPTOR } from '../src/engines/bing-lite.ts'
import { DDG_DESCRIPTOR } from '../src/engines/ddg.ts'
import { BaseEngine, FREE_POOL_ENGINE_IDS } from '../src/engines/engine.ts'
import { NATIVE_DELEGATE_DESCRIPTOR } from '../src/engines/native-delegate.ts'
import { SEARXNG_DESCRIPTOR } from '../src/engines/searxng.ts'
import { engineMessagesEn, engineMessagesZh } from '../src/i18n/engines.ts'
import { engineError } from '../src/kernel/errors.ts'
import type {
  EngineSearchRequest,
  EngineSearchResponse,
  NormalizedHit,
} from '../src/kernel/types.ts'

const REQ: EngineSearchRequest = {
  query: 'contract freeze',
  hints: { topic: 'contract freeze', hard: [], soft: [] },
  count: 5,
  layer: 'free',
  band: 'simple',
}

/** 最小假子类：直调 runSearch 的成功/失败两条路径。 */
class FakeEngine extends BaseEngine {
  constructor() {
    super({
      id: 'fake',
      kind: 'search',
      tier: 'free',
      caps: {},
      cost: { keysRequired: 0 },
      latencyBudgetMs: 50,
    })
  }

  runOk(hits: NormalizedHit[]): Promise<EngineSearchResponse> {
    return this.runSearch(REQ, async () => hits)
  }

  runFail(thrown: unknown): Promise<EngineSearchResponse> {
    return this.runSearch(REQ, async () => {
      throw thrown
    })
  }

  /** 暴露管道探测给测试：未接线必须抛统一 transport 错。 */
  callPipeline() {
    return this.pipeline()
  }
}

describe('免费池引擎 id 清单与描述符冻结', () => {
  it('固定为 ddg/bing-lite/searxng 三家（F-003）', () => {
    expect([...FREE_POOL_ENGINE_IDS]).toEqual(['ddg', 'bing-lite', 'searxng'])
  })

  it('四个内置描述符均运行期冻结（含嵌套 caps/cost）', () => {
    for (const descriptor of [
      DDG_DESCRIPTOR,
      BING_LITE_DESCRIPTOR,
      SEARXNG_DESCRIPTOR,
      NATIVE_DELEGATE_DESCRIPTOR,
    ]) {
      expect(Object.isFrozen(descriptor)).toBe(true)
      expect(Object.isFrozen(descriptor.caps)).toBe(true)
      expect(Object.isFrozen(descriptor.cost)).toBe(true)
    }
  })

  it('引擎状态 i18n 键 zh/en 奇偶一致且不少于 6 键（W-B-79）', () => {
    const zhKeys = Object.keys(engineMessagesZh)
    const enKeys = Object.keys(engineMessagesEn)
    expect(zhKeys.length).toBe(enKeys.length)
    expect(zhKeys.length).toBeGreaterThanOrEqual(6)
    expect([...zhKeys].sort()).toEqual([...enKeys].sort())
    expect(zhKeys).toContain('webstack.engine.ddg.disabled')
    expect(zhKeys).toContain('webstack.engine.bing-lite.degraded')
    expect(zhKeys).toContain('webstack.engine.searxng.misconfigured')
  })
})

describe('BaseEngine 统一包装', () => {
  it('成功路径：attempts 记 ok、计时单调、provenance.engine 盖章为 descriptor.id', async () => {
    const engine = new FakeEngine()
    const before = Date.now()
    const response = await engine.runOk([
      {
        url: 'https://a.example/1',
        title: 'A',
        provenance: { engine: 'someone-else', score: 0.5, via: 'bridge' },
      },
      {
        url: 'https://a.example/2',
        title: 'B',
        provenance: { engine: 'fake' },
      },
    ])
    const attempt = response.attempts[0]
    expect(attempt).toBeDefined()
    expect(attempt?.engineId).toBe('fake')
    expect(attempt?.outcome).toBe('ok')
    expect(attempt?.startedAt).toBeGreaterThanOrEqual(before)
    expect(attempt?.durationMs).toBeGreaterThanOrEqual(0)
    // W-B-16：出处盖章为本引擎，其余 provenance 字段保留。
    expect(response.hits[0]?.provenance.engine).toBe('fake')
    expect(response.hits[0]?.provenance.score).toBe(0.5)
    expect(response.hits[0]?.provenance.via).toBe('bridge')
    // 已正确的 provenance 原样保留（同一引用）。
    expect(response.hits[1]?.provenance.engine).toBe('fake')
    expect(engine.lastAttempt?.outcome).toBe('ok')
  })

  it('失败路径：普通异常归一为 transport 并 rethrow，attempt 记错误码', async () => {
    const engine = new FakeEngine()
    await expect(engine.runFail(new Error('boom'))).rejects.toMatchObject({
      name: 'EngineError',
      code: 'transport',
      message: 'boom',
      engineId: 'fake',
    })
    expect(engine.lastAttempt?.outcome).toBe('transport')
    expect(engine.lastAttempt?.engineId).toBe('fake')
    expect(engine.lastAttempt?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('失败路径：已是 EngineError 则原码透传（不二次包装）', async () => {
    const engine = new FakeEngine()
    await expect(engine.runFail(engineError('rate-limited', 'slow down'))).rejects.toMatchObject({
      code: 'rate-limited',
    })
    expect(engine.lastAttempt?.outcome).toBe('rate-limited')
  })

  it('安全管道动态接线成功：outbound/narrowing 五件套就绪且均为函数', async () => {
    // 管道两模块已由集成工程师补齐导出，动态探测应成功解析（离线，无网络）。
    const engine = new FakeEngine()
    const pipeline = await engine.callPipeline()
    expect(typeof pipeline.outboundFetch).toBe('function')
    expect(typeof pipeline.parseJsonLoose).toBe('function')
    expect(typeof pipeline.narrowString).toBe('function')
    expect(typeof pipeline.narrowArray).toBe('function')
    expect(typeof pipeline.narrowRecord).toBe('function')
  })
})
