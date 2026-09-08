/** 注册表：注册/candidates/错误三分类决策/冷却/statusSnapshot（W-B-10/11/40，假引擎表驱动）。 */
import { describe, expect, it } from 'vitest'
import { BingLiteEngine } from '../src/engines/bing-lite.ts'
import { DDG_DESCRIPTOR, DdgEngine } from '../src/engines/ddg.ts'
import { BaseEngine } from '../src/engines/engine.ts'
import { SEARXNG_DESCRIPTOR, SearxngEngine } from '../src/engines/searxng.ts'
import { engineError } from '../src/kernel/errors.ts'
import {
  EngineRegistry,
  QUOTA_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
} from '../src/kernel/registry.ts'
import type {
  EngineDescriptor,
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

/** 脚本化假引擎：按注入函数取数，不触任何真实管道。 */
class ScriptedEngine extends BaseEngine {
  calls = 0
  constructor(
    descriptor: EngineDescriptor,
    private readonly script: (req: EngineSearchRequest) => Promise<NormalizedHit[]>,
  ) {
    super(descriptor)
  }

  async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
    this.calls++
    return await this.runSearch(req, () => this.script(req))
  }
}

let seq = 0
function fakeDescriptor(overrides: Partial<EngineDescriptor> = {}): EngineDescriptor {
  seq++
  return {
    id: overrides.id ?? `fake-${seq}`,
    kind: 'search',
    tier: overrides.tier ?? 'free',
    caps: {},
    cost: { keysRequired: 0 },
    latencyBudgetMs: 50,
    ...overrides,
  }
}

function hit(url: string, engine: string): NormalizedHit {
  return { url, title: url, provenance: { engine } }
}

describe('EngineRegistry 注册与候选', () => {
  it('register→describe→dispose 全链；重复 id 拒绝', () => {
    const registry = new EngineRegistry()
    const engine = new DdgEngine()
    const dispose = registry.register(engine)
    expect(registry.listIds()).toEqual(['ddg'])
    expect(registry.describe('ddg')?.tier).toBe('free')
    expect(() => registry.register(new DdgEngine())).toThrow(/already registered/)
    dispose()
    expect(registry.listIds()).toEqual([])
  })

  it('candidates 按 layer 过滤：free 只含免费池，native 只含原生档', () => {
    const registry = new EngineRegistry()
    registry.register(new DdgEngine())
    registry.register(new BingLiteEngine())
    registry.register(new SearxngEngine(SEARXNG_DESCRIPTOR, 'https://searx.example.org'))
    expect(registry.candidates('free').map(e => e.descriptor.id)).toEqual(['ddg', 'bing-lite'])
    expect(registry.candidates('selfhosted').map(e => e.descriptor.id)).toEqual(['searxng'])
    expect(registry.candidates('api')).toEqual([])
    expect(registry.candidates('mcp')).toEqual([])
  })

  it('runWithFallback 显式 ids：未知 id 安全跳过、顺序保持', async () => {
    const registry = new EngineRegistry()
    const a = new ScriptedEngine(fakeDescriptor({ id: 'a' }), async () => [
      hit('https://a.example/1', 'a'),
    ])
    registry.register(a)
    const res = await registry.runWithFallback(REQ, ['ghost', 'a'])
    expect(res.hits).toHaveLength(1)
    expect(res.attempts.map(x => x.engineId)).toEqual(['a'])
  })
})

describe('EngineRegistry 错误三分类决策（W-B-40 表驱动）', () => {
  const TERMINAL_CASES = [
    { name: 'aborted terminal 立即整场终止', code: 'aborted' },
    { name: 'ssrf-blocked terminal 不绕行', code: 'ssrf-blocked' },
  ] as const

  const NON_RETRYABLE_CASES = [
    { name: 'auth non-retryable 直接换候选', code: 'auth' },
    { name: 'quota non-retryable 换候选并冷却', code: 'quota' },
  ] as const

  for (const c of TERMINAL_CASES) {
    it(c.name, async () => {
      const registry = new EngineRegistry()
      const bad = new ScriptedEngine(fakeDescriptor({ id: 'bad' }), async () => {
        throw engineError(c.code, `${c.code} boom`, { engineId: 'bad' })
      })
      const neverCalled = new ScriptedEngine(fakeDescriptor({ id: 'good' }), async () => [
        hit('https://ok.example/1', 'good'),
      ])
      registry.register(bad)
      registry.register(neverCalled)

      // terminal：整场立即终止并 rethrow，后续候选零调用。
      await expect(registry.runWithFallback(REQ, ['bad', 'good'])).rejects.toMatchObject({
        code: c.code,
      })
      expect(neverCalled.calls).toBe(0)
    })
  }

  for (const c of NON_RETRYABLE_CASES) {
    it(c.name, async () => {
      const registry = new EngineRegistry()
      const bad = new ScriptedEngine(fakeDescriptor({ id: 'bad' }), async () => {
        throw engineError(c.code, `${c.code} boom`, { engineId: 'bad' })
      })
      const good = new ScriptedEngine(fakeDescriptor({ id: 'good' }), async () => [
        hit('https://ok.example/1', 'good'),
      ])
      registry.register(bad)
      registry.register(good)

      const res = await registry.runWithFallback(REQ, ['bad', 'good'])
      expect(res.hits).toHaveLength(1)
      // 非重试类错误不重试同候选：bad 恰好尝试一次。
      expect(bad.calls).toBe(1)
      expect(res.attempts.map(x => x.outcome)).toEqual([c.code, 'ok'])
      if (c.code === 'quota') {
        expect(registry.inCooldown('bad')).toBe(true)
      }
    })

    it(`${c.name}（全部失败时原样 rethrow 最后错误）`, async () => {
      const registry = new EngineRegistry()
      const bad = new ScriptedEngine(fakeDescriptor({ id: 'bad' }), async () => {
        throw engineError(c.code, `${c.code} boom`, { engineId: 'bad' })
      })
      registry.register(bad)
      await expect(registry.runWithFallback(REQ)).rejects.toMatchObject({
        code: c.code,
      })
    })
  }

  it('retryable 同候选最多重试 1 次（退避后）再换下一候选', async () => {
    const registry = new EngineRegistry()
    const flaky = new ScriptedEngine(fakeDescriptor({ id: 'flaky' }), async () => {
      throw engineError('transport', 'net down', { engineId: 'flaky' })
    })
    const good = new ScriptedEngine(fakeDescriptor({ id: 'good' }), async () => [
      hit('https://ok.example/2', 'good'),
    ])
    registry.register(flaky)
    registry.register(good)

    const res = await registry.runWithFallback(REQ, ['flaky', 'good'])
    expect(flaky.calls).toBe(2) // 首试 + 1 重试
    expect(res.hits).toHaveLength(1)
    expect(res.attempts.filter(x => x.engineId === 'flaky')).toHaveLength(2)
  })

  it('rate-limited 触发默认 60s 冷却并在本次剔除', async () => {
    const registry = new EngineRegistry()
    const limited = new ScriptedEngine(fakeDescriptor({ id: 'limited' }), async () => {
      throw engineError('rate-limited', 'slow down', { engineId: 'limited' })
    })
    const good = new ScriptedEngine(fakeDescriptor({ id: 'good' }), async () => [
      hit('https://ok.example/3', 'good'),
    ])
    registry.register(limited)
    registry.register(good)

    const res = await registry.runWithFallback(REQ, ['limited', 'good'])
    expect(res.hits).toHaveLength(1)
    expect(limited.calls).toBe(1) // 冷却剔除，不做同候选重试
    expect(registry.inCooldown('limited')).toBe(true)
    const entry = registry.statusSnapshot().limited
    expect(entry?.state).toBe('cooldown')
    expect((entry?.cooldownUntil ?? 0) - Date.now()).toBeLessThanOrEqual(RATE_LIMIT_COOLDOWN_MS)
  })

  it('rate-limited 尊重服务端 retryAfterMs', async () => {
    const registry = new EngineRegistry()
    const limited = new ScriptedEngine(fakeDescriptor({ id: 'rl' }), async () => {
      throw engineError('rate-limited', 'retry later', {
        engineId: 'rl',
        retryAfterMs: 1234,
      })
    })
    registry.register(limited)
    await registry.runWithFallback(REQ).catch(() => undefined)
    const until = registry.statusSnapshot().rl?.cooldownUntil ?? 0
    expect(until - Date.now()).toBeLessThanOrEqual(1234)
    expect(until - Date.now()).toBeGreaterThan(1000)
  })

  it('quota 默认 300s 冷却', async () => {
    const registry = new EngineRegistry()
    const drained = new ScriptedEngine(fakeDescriptor({ id: 'drained' }), async () => {
      throw engineError('quota', 'exhausted', { engineId: 'drained' })
    })
    registry.register(drained)
    await registry.runWithFallback(REQ).catch(() => undefined)
    const until = registry.statusSnapshot().drained?.cooldownUntil ?? 0
    expect(until - Date.now()).toBeLessThanOrEqual(QUOTA_COOLDOWN_MS)
    expect(registry.inCooldown('drained')).toBe(true)
  })

  it('冷却期内的候选被剔除；全部冷却时抛闭集 cooldown 码', async () => {
    const registry = new EngineRegistry()
    const ddg = new ScriptedEngine({ ...DDG_DESCRIPTOR }, async () => {
      throw engineError('rate-limited', '429', { engineId: 'ddg' })
    })
    registry.register(ddg)
    await registry.runWithFallback(REQ).catch(() => undefined)
    // 冷却期内再次执行：ddg 被剔除、无任何 attempt → 闭集 cooldown 码。
    await expect(registry.runWithFallback(REQ)).rejects.toMatchObject({
      name: 'EngineError',
      code: 'cooldown',
      detail: 'all-cooling',
    })
    // 冷却中的引擎在 statusSnapshot 中可见。
    expect(registry.statusSnapshot().ddg?.state).toBe('cooldown')
  })

  it('部分候选冷却时其余照常执行且 warning 带闭集键', async () => {
    const registry = new EngineRegistry()
    const limited = new ScriptedEngine({ ...DDG_DESCRIPTOR }, async () => {
      throw engineError('rate-limited', '429', { engineId: 'ddg' })
    })
    const bing = new ScriptedEngine(fakeDescriptor({ id: 'bing-lite' }), async () => [
      hit('https://ok.example/4', 'bing-lite'),
    ])
    registry.register(limited)
    registry.register(bing)
    await registry.runWithFallback(REQ, ['ddg']).catch(() => undefined) // ddg 入冷却

    const res = await registry.runWithFallback(REQ, ['ddg', 'bing-lite'])
    expect(res.hits).toHaveLength(1)
    expect(res.warnings).toContain('webstack.engine.ddg.degraded')
  })
})

describe('EngineRegistry 诊断导出', () => {
  it('statusSnapshot：成功清除失败码、失败留痕不冷却', async () => {
    const registry = new EngineRegistry()
    const okEngine = new ScriptedEngine(fakeDescriptor({ id: 'ok-e' }), async () => [
      hit('https://o.example/1', 'ok-e'),
    ])
    const bad = new ScriptedEngine(fakeDescriptor({ id: 'bad-e' }), async () => {
      throw engineError('auth', 'nope', { engineId: 'bad-e' })
    })
    registry.register(okEngine)
    registry.register(bad)
    await registry.runWithFallback(REQ, ['ok-e'])
    await registry.runWithFallback(REQ, ['bad-e']).catch(() => undefined)

    const snap = registry.statusSnapshot()
    expect(snap['ok-e']).toEqual({ state: 'ok' }) // 成功清除失败码
    expect(snap['bad-e']).toMatchObject({ state: 'ok', lastCode: 'auth' }) // non-retryable 不冷却但留痕
  })

  it('recentAttempts 最新在前且有界（环形缓冲，非重试错误无退避等待）', async () => {
    const registry = new EngineRegistry()
    let n = 0
    const e = new ScriptedEngine(fakeDescriptor({ id: 'ring' }), async () => {
      n++
      if (n % 2 === 0) throw engineError('auth', 'blip', { engineId: 'ring' })
      return [hit(`https://r.example/${n}`, 'ring')]
    })
    registry.register(e)
    for (let i = 0; i < 25; i++) {
      await registry.runWithFallback(REQ, ['ring']).catch(() => undefined)
    }
    const history = registry.recentAttempts('ring')
    expect(history.length).toBeGreaterThan(0)
    expect(history.length).toBeLessThanOrEqual(20)
    expect(history[0]?.engineId).toBe('ring')
  })

  it('无任何候选可用时抛 transport/no-candidates 统一错误', async () => {
    const registry = new EngineRegistry()
    await expect(registry.runWithFallback(REQ)).rejects.toMatchObject({
      code: 'transport',
      detail: 'no-candidates',
    })
  })
})
