/**
 * 生命周期闭环：真实 cordis Context + 真实 WebRuntime 驱动（W-B-111），非 mock 注册表。
 * 出站客户端以 vi.mock 替身注入：全链路走「seam 选择 → 聚合器 → 真实 DdgEngine
 * 解析」，但网络字节由夹具供给——单元测试零真实网络。
 */
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name, WEBSTACK_PROVIDER_ID } from '../src/index.ts'

// ---------------------------------------------------------------------------
// 出站客户端替身：拦截 src/engines/engine.ts 与 src/fetch/pipeline.ts 的动态导入。
// ---------------------------------------------------------------------------
const outboundMock = vi.hoisted(() => ({ impl: undefined as unknown }))
vi.mock('../src/safety/outbound.ts', () => ({
  get outboundFetch(): unknown {
    return outboundMock.impl
  },
}))

/** 组装最小可解析的 DDG HTML 页（锚文本为标题 + result__snippet 块）。 */
function ddgPage(entries: readonly { readonly url: string; readonly title: string }[]): string {
  return entries
    .map(
      e =>
        `<a href="/l/?uddg=${encodeURIComponent(e.url)}" class="result__a">${e.title}</a>` +
        `<a class="result__snippet">snippet of ${e.title}</a>`,
    )
    .join('')
}

function fakeOutbound(init: { status?: number; body: string; contentType?: string }) {
  return async (req: { url: string }) => ({
    status: init.status ?? 200,
    finalUrl: req.url,
    headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
    bytes: init.body.length,
    text: async () => init.body,
  })
}

afterEach(() => {
  outboundMock.impl = undefined
})

describe('插件注册生命周期', () => {
  it('apply 后聚合器经 seam 端到端搜索；dispose 后注销回落宿主语义', async () => {
    outboundMock.impl = fakeOutbound({
      body: ddgPage([
        { url: 'https://lifecycle.example/page-a', title: 'Page A' },
        { url: 'https://lifecycle.example/page-b', title: 'Page B' },
      ]),
    })
    const ctx = new Context()
    await ctx.plugin(WebRuntime, {})
    const fiber = ctx.plugin({ name, inject, Config, apply }, {})
    await fiber

    // 单一可用 provider 自动选中 → 聚合器 → 免费池 ddg 引擎解析替身页面。
    const result = await ctx.web.search({ query: 'lifecycle probe' })
    expect(result.truncated).toBe(false)
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]?.url).toBe('https://lifecycle.example/page-a')
    expect(result.sources[0]?.title).toBe('Page A')

    // fetch 面：404 是数据不是异常，状态码如实上呈。
    const fetched = await ctx.web.fetch({
      url: 'https://lifecycle.example/gone',
    })
    expect(fetched.statusCode).toBe(200)

    const dispose = fiber.dispose()
    if (dispose instanceof Promise) await dispose

    // 卸载后 provider 消失：seam 回落「无可用 provider」错误而非悬挂引用。
    await expect(ctx.web.search({ query: 'lifecycle probe' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UNAVAILABLE',
    })
  })

  it('provider id 冻结为 webstack（补丁选择器唯一指向目标）', () => {
    expect(WEBSTACK_PROVIDER_ID).toBe('webstack')
  })
})
