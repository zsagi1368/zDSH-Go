/**
 * W9 装配层聚合器回归：凭据端到端（mock）、缓存键随凭据轮换换键、
 * mode on 强制 fresh、mcp 层池注入、垂直腿条件加发与 T3 桥接兜底 via 标注。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SearchCache } from '../src/cache/store.ts'
import type { EngineLike } from '../src/engines/engine.ts'
import { WebstackAggregator } from '../src/kernel/aggregator.ts'
import { engineError } from '../src/kernel/errors.ts'
import { EngineRegistry } from '../src/kernel/registry.ts'
import type {
  EngineDescriptor,
  EngineSearchRequest,
  EngineSearchResponse,
  EngineTier,
  NormalizedHit,
} from '../src/kernel/types.ts'

// ---------------------------------------------------------------------------
// 出站客户端替身：拦截 fetchPipeline 的动态导入（桥接兜底用例）。
// ---------------------------------------------------------------------------
const outboundMock = vi.hoisted(() => ({ impl: undefined as unknown }))
vi.mock('../src/safety/outbound.ts', () => ({
  get outboundFetch(): unknown {
    return outboundMock.impl
  },
}))

function fakeEngine(
  id: string,
  tier: EngineTier,
  impl: (req: EngineSearchRequest) => NormalizedHit[],
): EngineLike & { calls: EngineSearchRequest[] } {
  const calls: EngineSearchRequest[] = []
  return {
    calls,
    descriptor: {
      id,
      kind: 'search',
      tier,
      caps: {},
      cost: { keysRequired: tier === 'keyed' ? 1 : 0, quotaHint: 'unknown' },
      latencyBudgetMs: 1000,
    } as EngineDescriptor,
    async search(req: EngineSearchRequest): Promise<EngineSearchResponse> {
      calls.push(req)
      const hits = impl(req)
      return {
        hits,
        attempts: [{ engineId: id, startedAt: Date.now(), durationMs: 1, outcome: 'ok' }],
      }
    },
  }
}

const hitOf = (engine: string, url: string): NormalizedHit => ({
  url,
  title: `t-${url}`,
  provenance: { engine },
})

function baseSnapshot(
  overrides?: Partial<Parameters<typeof WebstackAggregator.prototype.updateSnapshot>[0]>,
): Parameters<typeof WebstackAggregator.prototype.updateSnapshot>[0] {
  return {
    enabled: true,
    layer: 'api',
    autoFallback: true,
    maxResults: 8,
    fusionEnabled: false,
    complexityRouting: true,
    fetchMode: 'raw',
    maxContentChars: 12_000,
    ssrfExempts: [],
    cacheEnabled: true,
    ...overrides,
  }
}

afterEach(() => {
  outboundMock.impl = undefined
})

describe('凭据流端到端（W9 装配层）', () => {
  it('configValues 明文按槽位装进引擎请求（仅进程内），缺键即 auth', async () => {
    let received: string | undefined
    const tavily = fakeEngine('tavily', 'keyed', (req) => {
      received = req.credentials?.tavilyKey
      return [hitOf('tavily', 'https://ok.test/a')]
    })
    const reg = new EngineRegistry()
    reg.register(tavily)
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot(),
      registry: reg,
      cache: new SearchCache(),
      credsSource: () => ({ configValues: { tavily: 'sk-live-abc123456' } }),
    })
    const hits = await agg.searchHits({ query: 'cred probe' })
    expect(hits).toHaveLength(1)
    expect(received).toBe('sk-live-abc123456')
  })

  it('无凭据时 keyed 引擎抛 auth → fallback 换下一候选成功', async () => {
    const tavily = fakeEngine('tavily', 'keyed', () => {
      throw engineError('auth', 'no key', { engineId: 'tavily' })
    })
    const brave = fakeEngine('brave', 'keyed', () => [hitOf('brave', 'https://b.test/x')])
    const reg = new EngineRegistry()
    reg.register(tavily)
    reg.register(brave)
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot(),
      registry: reg,
      cache: new SearchCache(),
    })
    const hits = await agg.searchHits({ query: 'fallback probe with several words' })
    expect(hits[0]?.provenance.engine).toBe('brave')
    expect(brave.calls.length).toBe(1)
  })

  it('凭据轮换改变 credFingerprint → 换缓存键（宁可 miss 不可错 hit）', async () => {
    let currentKey = 'key-one-123456'
    const tavily = fakeEngine('tavily', 'keyed', () => [hitOf('tavily', 'https://k.test/a')])
    const reg = new EngineRegistry()
    reg.register(tavily)
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot(),
      registry: reg,
      cache: new SearchCache(),
      credsSource: () => ({ configValues: { tavily: currentKey } }),
    })
    await agg.searchHits({ query: 'rotate probe' })
    expect(tavily.calls).toHaveLength(1)
    // 同键第二次：缓存命中，不再打引擎。
    await agg.searchHits({ query: 'rotate probe' })
    expect(tavily.calls).toHaveLength(1)
    // 换键：指纹变化 → 新键 → 引擎再次被调。
    currentKey = 'key-two-654321'
    await agg.searchHits({ query: 'rotate probe' })
    expect(tavily.calls).toHaveLength(2)
  })

  it('mode.sessionOnline=on（forceFresh）跳过缓存读但照常写缓存', async () => {
    const ddg = fakeEngine('ddg', 'free', () => [hitOf('ddg', 'https://f.test/a')])
    const reg = new EngineRegistry()
    reg.register(ddg)
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot({ layer: 'free' }),
      registry: reg,
      cache: new SearchCache(),
    })
    await agg.searchHits({ query: 'fresh probe' })
    expect(ddg.calls).toHaveLength(1)
    // off：命中缓存。
    await agg.searchHits({ query: 'fresh probe' })
    expect(ddg.calls).toHaveLength(1)
    // on：强制 fresh，重新执行；写侧照常。
    agg.updateSnapshot(baseSnapshot({ layer: 'free', forceFresh: true }))
    await agg.searchHits({ query: 'fresh probe' })
    expect(ddg.calls).toHaveLength(2)
    // 回落 off：上轮 fresh 结果已入缓存，再次命中。
    agg.updateSnapshot(baseSnapshot({ layer: 'free' }))
    await agg.searchHits({ query: 'fresh probe' })
    expect(ddg.calls).toHaveLength(2)
  })

  it('layerPools 注入 mcp 动态池并进入计划（candidates 扩展 mcp→mcp 集）', async () => {
    const mcp = fakeEngine('mcp-x', 'mcp', () => [hitOf('mcp-x', 'https://m.test/a')])
    const reg = new EngineRegistry()
    reg.register(mcp)
    expect(reg.candidates('mcp').map(e => e.descriptor.id)).toEqual(['mcp-x'])
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot({
        layer: 'mcp',
        layerPools: { mcp: ['mcp-x'] },
      }),
      registry: reg,
      cache: new SearchCache(),
    })
    const hits = await agg.searchHits({ query: 'mcp probe' })
    expect(hits[0]?.url).toBe('https://m.test/a')
    expect(mcp.calls).toHaveLength(1)
  })

  it('垂直腿条件加发：hints 命中 X 触发矩阵时追加 x-vertical', async () => {
    const ddg = fakeEngine('ddg', 'free', () => [hitOf('ddg', 'https://d.test/a')])
    const xv = fakeEngine('x-vertical', 'free', () => [hitOf('x-vertical', 'https://x.test/1')])
    const reg = new EngineRegistry()
    reg.register(ddg)
    reg.register(xv)
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot({
        layer: 'free',
        verticalEngineIds: ['x-vertical'],
      }),
      registry: reg,
      cache: new SearchCache(),
    })
    await agg.searchHits({ query: 'site:x.com latest news' })
    expect(xv.calls).toHaveLength(1)
  })

  it('autoFallback=false 尊重单引擎纪律：不加发垂直腿', async () => {
    const ddg = fakeEngine('ddg', 'free', () => [hitOf('ddg', 'https://d.test/a')])
    const xv = fakeEngine('x-vertical', 'free', () => [hitOf('x-vertical', 'https://x.test/1')])
    const reg = new EngineRegistry()
    reg.register(ddg)
    reg.register(xv)
    const agg = new WebstackAggregator({
      snapshot: baseSnapshot({
        layer: 'free',
        autoFallback: false,
        verticalEngineIds: ['x-vertical'],
      }),
      registry: reg,
      cache: new SearchCache(),
    })
    await agg.searchHits({ query: 'site:x.com latest news' })
    expect(ddg.calls).toHaveLength(1)
    expect(xv.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// T3 桥接兜底（fetch 面）
// ---------------------------------------------------------------------------

interface FakeBridge {
  render(url: string, timeoutMs: number): Promise<{ content: string; statusCode: number }>
}

function bridgeAggregator(renderImpl?: (url: string, timeoutMs: number) => unknown) {
  const renderCalls: Array<[string, number]> = []
  const bridge: FakeBridge | undefined =
    renderImpl === undefined
      ? undefined
      : {
        async render(url: string, timeoutMs: number) {
          renderCalls.push([url, timeoutMs])
          return (await renderImpl(url, timeoutMs)) as { content: string; statusCode: number }
        },
      }
  const agg = new WebstackAggregator({
    snapshot: baseSnapshot({ layer: 'free' }),
    registry: new EngineRegistry(),
    cache: new SearchCache(),
    ...(bridge === undefined ? {} : { bridge }),
  })
  return { agg, renderCalls }
}

describe('T3 桥接兜底（fetchPipeline 失败 / 内容过短 → 单次渲染，via=bridge）', () => {
  it('管道故障 → 桥接管：statusCode=0（非 HTTP 通道）、via 标注 bridge、8s 预算', async () => {
    outboundMock.impl = async () => {
      throw engineError('transport', 'dns failure', {})
    }
    const { agg, renderCalls } = bridgeAggregator(() => ({
      content: 'BRIDGED BODY',
      statusCode: 0,
    }))
    const res = await agg.fetch({ url: 'https://js-heavy.example/page' })
    expect(res.body.content).toBe('BRIDGED BODY')
    expect(res.statusCode).toBe(0)
    expect(res.truncated).toBe(false)
    expect(agg.lastFetchVia).toBe('bridge')
    expect(renderCalls).toEqual([['https://js-heavy.example/page', 8000]])
  })

  it('静态正文过短且桥更长 → 采纳桥结果并标注 via=bridge', async () => {
    outboundMock.impl = async (req: { url: string }) => ({
      status: 200,
      finalUrl: req.url,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      bytes: 32,
      text: async () => '<html><body><p>tiny</p></body></html>',
    })
    const { agg } = bridgeAggregator(() => ({
      content: `rendered ${'x'.repeat(300)}`,
      statusCode: 200,
    }))
    const res = await agg.fetch({ url: 'https://spa.example/app' })
    expect(res.body.content.startsWith('rendered ')).toBe(true)
    expect(agg.lastFetchVia).toBe('bridge')
  })

  it('桥缺席时管道故障原样透传；ssrf-blocked 绝不绕行', async () => {
    outboundMock.impl = async () => {
      throw engineError('transport', 'boom', {})
    }
    const noBridge = bridgeAggregator(undefined)
    await expect(noBridge.agg.fetch({ url: 'https://x.example/a' })).rejects.toMatchObject({
      code: 'transport',
    })

    outboundMock.impl = async () => {
      throw engineError('ssrf-blocked', 'loopback blocked', {})
    }
    const { agg, renderCalls } = bridgeAggregator(() => ({
      content: 'SHOULD NOT RENDER',
      statusCode: 0,
    }))
    await expect(agg.fetch({ url: 'http://127.0.0.1:9/x' })).rejects.toMatchObject({
      code: 'ssrf-blocked',
    })
    expect(renderCalls).toHaveLength(0)
  })

  it('桥渲染失败/返回空 → 降级回原错误（绝不致命，也绝不空壳上呈）', async () => {
    outboundMock.impl = async () => {
      throw engineError('transport', 'net down', {})
    }
    const failing = bridgeAggregator(() => {
      throw new Error('bridge crashed')
    })
    await expect(failing.agg.fetch({ url: 'https://y.example/a' })).rejects.toMatchObject({
      code: 'transport',
    })
    const empty = bridgeAggregator(() => ({ content: '', statusCode: 0 }))
    await expect(empty.agg.fetch({ url: 'https://y.example/b' })).rejects.toMatchObject({
      code: 'transport',
    })
  })

  it('正常长文走管线直出：via=pipeline 且不打桥', async () => {
    outboundMock.impl = async (req: { url: string }) => ({
      status: 200,
      finalUrl: req.url,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      bytes: 1024,
      text: async () => `<html><body><article>${'long '.repeat(120)}</article></body></html>`,
    })
    const { agg, renderCalls } = bridgeAggregator(() => ({ content: 'unused', statusCode: 0 }))
    const res = await agg.fetch({ url: 'https://plain.example/article' })
    expect(res.statusCode).toBe(200)
    expect(agg.lastFetchVia).toBe('pipeline')
    expect(renderCalls).toHaveLength(0)
  })
})
