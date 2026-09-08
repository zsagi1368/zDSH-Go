/**
 * W9 装配层回归：注册矩阵（keyed 六家 + native-delegate + MCP 校验注册 +
 * 垂类条件装配）、candidates 层扩展、composeSnapshot 凭据/会话联网映射、
 * credsSourceViewFrom 键位抽取，以及真实 cordis Context 的端到端装配。
 */
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { describe, expect, it } from 'vitest'
import { KEYED_ENGINE_IDS } from '../src/engines/engine.ts'
import {
  assembleWebstack,
  buildEngineRegistry,
  composeSnapshot,
  credsSourceViewFrom,
  type PluginConfig,
} from '../src/index.ts'

const BASE: PluginConfig = {}

describe('buildEngineRegistry 注册矩阵', () => {
  it('默认矩阵：免费池两家 + keyed 六家 + native-delegate', () => {
    const { registry, mcpEngineIds, invalidMcpIds, verticalLegId } = buildEngineRegistry(BASE)
    expect(registry.listIds()).toEqual(['ddg', 'bing-lite', ...KEYED_ENGINE_IDS, 'native'])
    expect(mcpEngineIds).toEqual([])
    expect(invalidMcpIds).toEqual([])
    expect(verticalLegId).toBeUndefined()
  })

  it('自托管：合法 baseUrl 才注册 searxng；非法值静默跳过', () => {
    const ok = buildEngineRegistry({ ...BASE, searxngBaseUrl: 'https://searx.example.org' })
    expect(ok.registry.listIds()).toContain('searxng')
    const bad = buildEngineRegistry({ ...BASE, searxngBaseUrl: 'not-a-url' })
    expect(bad.registry.listIds()).not.toContain('searxng')
  })

  it('keyed 引擎描述符 tier=keyed → candidates(api) 恰为六家集（注册序）', () => {
    const { registry } = buildEngineRegistry(BASE)
    expect(registry.candidates('api').map(e => e.descriptor.id)).toEqual([...KEYED_ENGINE_IDS])
    for (const engine of registry.candidates('api')) {
      expect(engine.descriptor.tier).toBe('keyed')
    }
  })

  it('native 描述符 tier=native → candidates(native)=[native]', () => {
    const { registry } = buildEngineRegistry(BASE)
    expect(registry.candidates('native').map(e => e.descriptor.id)).toEqual(['native'])
  })

  it('MCP：过 validateMcpEntry 的条目注册为 mcp-<id>；裸 npx 条目进诊断清单', () => {
    const config: PluginConfig = {
      mcpServers: [
        { id: 'good', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp@1.2.3'] },
        { id: 'bare', transport: 'stdio', command: 'npx' },
        { id: '', transport: 'http', url: 'https://m.example' },
      ],
    }
    const { registry, mcpEngineIds, invalidMcpIds } = buildEngineRegistry(config)
    expect(mcpEngineIds).toEqual(['mcp-good'])
    expect(registry.describe('mcp-good')?.tier).toBe('mcp')
    expect(invalidMcpIds).toEqual(['bare', ''])
    // candidates 扩展：注册后 mcp 层即有候选。
    expect(registry.candidates('mcp').map(e => e.descriptor.id)).toEqual(['mcp-good'])
  })

  it('垂类条件装配：packEnabled&&channels.x 全开才注册 x-vertical', () => {
    const both = buildEngineRegistry({ verticalsPackEnabled: true, verticalsChannelX: true })
    expect(both.verticalLegId).toBe('x-vertical')
    expect(both.registry.describe('x-vertical')?.caps.vertical).toBe(true)

    const packOnly = buildEngineRegistry({ verticalsPackEnabled: true })
    const chanOnly = buildEngineRegistry({ verticalsChannelX: true })
    const neither = buildEngineRegistry({})
    expect(packOnly.verticalLegId).toBeUndefined()
    expect(chanOnly.verticalLegId).toBeUndefined()
    expect(neither.verticalLegId).toBeUndefined()
  })

  it('垂类未提供 freePoolSearch 钩子时以空实现兜底（绝不递归加发）', async () => {
    const { registry } = buildEngineRegistry({
      verticalsPackEnabled: true,
      verticalsChannelX: true,
    })
    const leg = registry.candidates('free').find(e => e.descriptor.id === 'x-vertical')
    await expect(
      leg?.search({
        query: 'q',
        hints: { hard: [], soft: [] },
        count: 3,
        layer: 'free',
        band: 'simple',
      }),
    ).rejects.toMatchObject({ code: 'cooldown' }) // 默认导入缺失卫星包 → cooldown
  }, 15_000)
})

describe('composeSnapshot / credsSourceViewFrom（纯装配辅助）', () => {
  it('sessionOnline=on 映射 forceFresh；off/ask 不强制', () => {
    expect(composeSnapshot({ sessionOnline: 'on' }).forceFresh).toBe(true)
    expect(composeSnapshot({ sessionOnline: 'off' }).forceFresh).toBe(false)
    expect(composeSnapshot({ sessionOnline: 'ask' }).forceFresh).toBe(false)
    expect(composeSnapshot({}).forceFresh).toBe(false)
  })

  it('layerPools 与 verticalEngineIds 原样进快照', () => {
    const snap = composeSnapshot(
      {},
      {
        layerPools: { mcp: ['mcp-a'] },
        verticalEngineIds: ['x-vertical'],
      },
    )
    expect(snap.layerPools?.mcp).toEqual(['mcp-a'])
    expect(snap.verticalEngineIds).toEqual(['x-vertical'])
  })

  it('凭据源视图：key 规范键位优先、apiKey 历史别名兼容、credentialRef 抽取', () => {
    const view = credsSourceViewFrom({
      engines: {
        tavily: { key: 'k-tavily', credentialRef: 'ref-tavily' },
        brave: { apiKey: 'legacy-brave' },
        exa: {},
      },
    })
    expect(view.configValues?.tavily).toBe('k-tavily')
    expect(view.credentialsRef?.tavily).toBe('ref-tavily')
    expect(view.configValues?.brave).toBe('legacy-brave')
    expect(view.configValues?.exa).toBeUndefined()
    expect(view.credentialsRef?.brave).toBeUndefined()
  })

  it('engines 缺席时凭据视图全空但不缺位；免费池引擎不进 keyed 视图', () => {
    const view = credsSourceViewFrom({})
    expect(view.configValues).toBeDefined()
    expect(Object.keys(view.configValues ?? {})).toHaveLength(0)
    expect(view.seams).toBeUndefined()
    const injected = credsSourceViewFrom({ engines: { ddg: { key: 'nope' } as never } })
    expect(injected.configValues?.ddg).toBeUndefined()
  })
})

describe('assembleWebstack（真实 cordis Context 端到端）', () => {
  it('装配产物暴露状态机/快照/历史；refresh 热更新 forceFresh 与模式', async () => {
    const ctx = new Context()
    ctx.plugin(WebRuntime, {})
    const cfg: PluginConfig = { sessionOnline: 'on', layer: 'selfhosted' }
    const assembly = assembleWebstack(ctx, cfg)
    expect(assembly.sessionOnline.getMode()).toBe('on')
    expect(assembly.aggregator.snapshot.forceFresh).toBe(true)
    expect(assembly.history).toBeDefined()
    expect(assembly.mcpEngineIds).toEqual([])

    // 模拟 settings 文档变更（onChange 同款：原位改写 + refresh）。
    Object.assign(cfg, { sessionOnline: 'off', layer: 'free' })
    assembly.refresh()
    expect(assembly.sessionOnline.getMode()).toBe('off')
    expect(assembly.aggregator.snapshot.forceFresh).toBe(false)
    expect(assembly.aggregator.snapshot.layer).toBe('free')
  })

  it('cachePersist=durable 且宿主 storage 在场 → L1 生效（write-through 可读回）', async () => {
    const ctx = new Context()
    ctx.plugin(WebRuntime, {})
    const store = new Map<string, string>();
    // 探测面只看对象形状：直接挂 storage 服务。
    (ctx as unknown as Record<string, unknown>).storage = {
      getItem: async (k: string) => store.get(k),
      setItem: async (k: string, v: string) => void store.set(k, v),
    }
    const assembly = assembleWebstack(ctx, { cachePersist: 'durable' })
    await assembly.aggregator.cache.set('search', 'k1', [{ marker: true }])
    expect(store.size).toBeGreaterThan(0) // write-through 已落宿主 storage
    const back = await assembly.aggregator.cache.get('search', 'k1')
    expect(back).toEqual([{ marker: true }])
  })

  it('桥接卫星探测：ctx.bridge.render 为函数时 bridgeOnline=true 并注入聚合器', async () => {
    const ctx = new Context()
    ctx.plugin(WebRuntime, {});
    (ctx as unknown as Record<string, unknown>).bridge = {
      render: async () => ({ content: 'b', statusCode: 0 }),
    }
    const assembly = assembleWebstack(ctx, {})
    expect(assembly.bridgeOnline).toBe(true)
    expect(assembly.capabilities.bridgeOnline).toBe(true)
  })

  it('cachePersist 切换热生效：memory→durable 后 attachCache 换新栈', async () => {
    const ctx = new Context()
    ctx.plugin(WebRuntime, {})
    const store = new Map<string, string>();
    (ctx as unknown as Record<string, unknown>).storage = {
      getItem: async (k: string) => store.get(k),
      setItem: async (k: string, v: string) => void store.set(k, v),
    }
    const cfg: PluginConfig = { cachePersist: 'memory' }
    const assembly = assembleWebstack(ctx, cfg)
    const memoryCache = assembly.aggregator.cache
    Object.assign(cfg, { cachePersist: 'durable' })
    assembly.refresh()
    expect(assembly.aggregator.cache).not.toBe(memoryCache)
  })
})
