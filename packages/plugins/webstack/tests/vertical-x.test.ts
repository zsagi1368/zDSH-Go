/**
 * 垂直腿适配器回归（W9 装配收尾）：卫星包缺失静默 + 诊断键、假包注入的
 * 频道执行与免费池回调映射、signal 透传、provenance 盖章。
 */
import { describe, expect, it } from 'vitest'
import { type VerticalRequestView, VerticalXLegEngine } from '../src/engines/vertical-x.ts'
import type { EngineSearchRequest, SearchHints } from '../src/kernel/types.ts'

const HINTS: SearchHints = { topic: 'x news', hard: [], soft: [] }

function req(overrides?: Partial<EngineSearchRequest>): EngineSearchRequest {
  return {
    query: 'x news',
    hints: HINTS,
    count: 5,
    layer: 'free',
    band: 'medium',
    ...overrides,
  }
}

/** 最小假包：XVerticalChannel 记录入参并回放预置命中。 */
function fakePack() {
  const calls: Array<{
    req: { query: string; count: number; signal?: AbortSignal }
    deps: { search: (r2: VerticalRequestView) => Promise<unknown> }
  }> = []
  const pack = {
    XVerticalChannel: class {
      readonly id = 'x-vertical'
      async run(
        r: { query: string; count: number; signal?: AbortSignal },
        deps: { search: (r2: VerticalRequestView) => Promise<unknown> },
      ) {
        calls.push({ req: r, deps })
        await deps.search({
          query: `site:x.com OR site:twitter.com ${r.query}`,
          count: r.count,
          hints: { hard: [], soft: [] },
        })
        return [
          {
            url: 'https://x.com/u/status/1',
            title: 'tweet',
            provenance: { engine: 'ddg', via: 'site-search' },
          },
        ]
      }
    },
  }
  return { pack, calls }
}

describe('VerticalXLegEngine（W9 垂类条件装配）', () => {
  it('卫星包缺失 → cooldown + i18n 诊断键 detail（静默降级不致命）', async () => {
    const engine = new VerticalXLegEngine({
      loadPack: async () => undefined,
      freePoolSearch: async () => ({ hits: [], attempts: [] }),
    })
    await expect(engine.search(req())).rejects.toMatchObject({
      code: 'cooldown',
      detail: 'webstack.verticals.disabled-notice',
    })
  })

  it('默认动态导入（模块缺失路径）同样收敛为 cooldown 诊断键', async () => {
    // 不注入 loadPack：真实 import('dsh-webstack-verticals') 在测试环境缺依赖
    // → catch → undefined → 与显式缺失同语义。
    const engine = new VerticalXLegEngine({
      freePoolSearch: async () => ({ hits: [], attempts: [] }),
    })
    await expect(engine.search(req())).rejects.toMatchObject({ code: 'cooldown' })
  }, 15_000)

  it('假包注入：频道执行 + 免费池回调映射 + provenance 盖章 x-vertical', async () => {
    const { pack, calls } = fakePack()
    const freeCalls: string[] = []
    const engine = new VerticalXLegEngine({
      loadPack: async () => pack,
      freePoolSearch: async (freereq) => {
        freeCalls.push(freereq.query)
        return {
          hits: [
            {
              url: 'https://x.com/u/status/1',
              title: 'tweet',
              provenance: { engine: 'ddg', via: 'site-search' },
            },
          ],
          attempts: [],
        }
      },
    })
    const res = await engine.search(req({ count: 3 }))
    expect(res.hits).toHaveLength(1)
    expect(freeCalls).toEqual(['site:x.com OR site:twitter.com x news'])
    expect(calls[0]?.req.count).toBe(3)
    // BaseEngine 统一盖章：出处引擎 = 本描述符 id，via 如实保留。
    expect(res.hits[0]?.provenance.engine).toBe('x-vertical')
    expect(res.hits[0]?.provenance.via).toBe('site-search')
    expect(res.attempts[0]?.outcome).toBe('ok')
  })

  it('signal 经频道请求透传；描述符为免凭据免费档 + caps.vertical', async () => {
    const { pack, calls } = fakePack()
    const controller = new AbortController()
    const engine = new VerticalXLegEngine({
      loadPack: async () => pack,
      freePoolSearch: async () => ({ hits: [], attempts: [] }),
    })
    await engine.search(req({ signal: controller.signal }))
    expect(calls[0]?.req.signal).toBe(controller.signal)
    expect(engine.descriptor.tier).toBe('free')
    expect(engine.descriptor.caps.vertical).toBe(true)
    expect(engine.descriptor.cost.keysRequired).toBe(0)
  })
})
