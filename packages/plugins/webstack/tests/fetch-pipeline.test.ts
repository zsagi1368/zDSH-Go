/** 抓取管线：档位闭集 + fetchPipeline 全链路（离线：vi.mock 注入假出站客户端）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchPipeline,
  PIPELINE_TIERS,
  type PipelineOutboundRequest,
} from '../src/fetch/pipeline.ts'
import { fetchMessagesEn, fetchMessagesZh, formatStatusPrefix } from '../src/i18n/fetch-safety.ts'
import { engineError } from '../src/kernel/errors.ts'
import type { ContentBudgets, FetchMode, FetchRequest } from '../src/kernel/types.ts'

// ---------------------------------------------------------------------------
// 出站客户端替身：vi.mock 拦截动态导入路径（与 src/fetch/pipeline.ts 内的
// 字面量 import('../safety/outbound.ts') 解析到同一文件）。经 getter 委托，
// 允许逐用例替换 impl（含「导出缺失」的未接线场景）。
// ---------------------------------------------------------------------------
const outboundMock = vi.hoisted(() => ({ impl: undefined as unknown }))
vi.mock('../src/safety/outbound.ts', () => ({
  get outboundFetch(): unknown {
    return outboundMock.impl
  },
}))

interface FakeInit {
  readonly status: number
  readonly finalUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

interface RecordedCall {
  readonly req: PipelineOutboundRequest
  readonly opts?: { exemptions?: readonly string[] } | undefined
}

let calls: RecordedCall[] = []

function fakeOutbound(init: FakeInit): unknown {
  return async (req: PipelineOutboundRequest, opts?: { exemptions?: readonly string[] }) => {
    calls.push({ req, opts })
    return {
      status: init.status,
      finalUrl: init.finalUrl,
      headers: init.headers,
      bytes: init.body.length,
      text: async () => init.body,
    }
  }
}

const BUDGETS: ContentBudgets = {
  canonicalChars: 4096,
  renderedChars: 4096,
  errorChars: 512,
}

/** 组装请求：显式判别 signal 缺省，规避 exactOptionalPropertyTypes 的 undefined 渗透。 */
function mkReq(opts?: {
  readonly budgets?: ContentBudgets
  readonly mode?: FetchMode
  readonly signal?: AbortSignal
}): FetchRequest {
  const mode: FetchMode = opts?.mode ?? 'raw'
  const budgets: ContentBudgets = opts?.budgets ?? BUDGETS
  const base = { url: 'https://origin.example/a', mode, budgets }
  return opts?.signal === undefined ? base : { ...base, signal: opts.signal }
}

describe('PIPELINE_TIERS', () => {
  it('t1 / t1+t2 / t1+t2+t3 三档（T3 依赖桥接卫星）', () => {
    expect([...PIPELINE_TIERS]).toEqual(['t1', 't1+t2', 't1+t2+t3'])
  })
})

describe('fetchPipeline', () => {
  beforeEach(() => {
    calls = []
  })

  afterEach(() => {
    outboundMock.impl = undefined
  })

  it('安全管道未接线（导出缺失）→ 统一 transport「safety pipeline not wired yet」', async () => {
    outboundMock.impl = undefined
    await expect(fetchPipeline(mkReq())).rejects.toMatchObject({
      name: 'EngineError',
      code: 'transport',
      message: 'safety pipeline not wired yet',
      detail: 'todo-w2-safety',
    })
  })

  it('404 页是数据不是错误：statusCode 如实上呈且首行注入状态前缀', async () => {
    outboundMock.impl = fakeOutbound({
      status: 404,
      finalUrl: 'https://final.example/missing',
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>Not Found</h1><p>页面走丢了，找不到该资源。</p></body></html>',
    })
    const out = await fetchPipeline(mkReq({ mode: 'fit' }))
    expect(out.statusCode).toBe(404)
    expect(
      out.content.startsWith('[HTTP 404] 目标站返回了非 2xx 状态，以下为其原始响应内容\n'),
    ).toBe(true)
    expect(out.content).toContain('页面走丢了')
    expect(out.truncated).toBe(false)
    expect(out.budgets).toBe(BUDGETS)
  })

  it('404 空响应体也「带解释」：仅状态前缀行，绝不为空', async () => {
    outboundMock.impl = fakeOutbound({
      status: 503,
      finalUrl: 'https://final.example/down',
      headers: { 'content-type': 'text/plain' },
      body: '',
    })
    const out = await fetchPipeline(mkReq())
    expect(out.statusCode).toBe(503)
    expect(out.content).toBe(formatStatusPrefix(503))
  })

  it('JSON 分支：解析成功 → pretty-print 文本、mode 记 raw、url 取 finalUrl', async () => {
    const body = '{"b":2,"a":[1,null]}'
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://final.example/api',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
    })
    const out = await fetchPipeline(mkReq())
    expect(out.mode).toBe('raw')
    expect(out.content).toBe(JSON.stringify(JSON.parse(body), null, 2))
    expect(out.url).toBe('https://final.example/api')
    expect(out.truncated).toBe(false)
  })

  it('JSON 声明但解析失败 → 落 HTML 抽取分支（不抛 narrow 异常）', async () => {
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://final.example/broken-json',
      headers: { 'content-type': 'application/json' },
      body: '<p>这不是合法 JSON 而是一段足够长的正文文本内容。</p>',
    })
    const out = await fetchPipeline(mkReq({ mode: 'fit' }))
    expect(out.mode).toBe('fit')
    expect(out.content).toContain('足够长的正文')
  })

  it('maxBytes = min(canonicalChars × 4, 8MiB)，signal 与 exemptions 原样转发', async () => {
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://final.example/x',
      headers: { 'content-type': 'text/html' },
      body: '<div>ok</div>',
    })
    const controller = new AbortController()
    await fetchPipeline(
      mkReq({
        budgets: { canonicalChars: 1000, renderedChars: 4096, errorChars: 512 },
        signal: controller.signal,
      }),
      {
        exemptions: ['10.0.0.0/8'],
      },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.req.maxBytes).toBe(4000)
    expect(calls[0]?.req.signal).toBe(controller.signal)
    expect(calls[0]?.req.url).toBe('https://origin.example/a')
    expect(calls[0]?.opts).toEqual({ exemptions: ['10.0.0.0/8'] })

    await fetchPipeline(
      mkReq({
        budgets: {
          canonicalChars: 10_000_000,
          renderedChars: 4096,
          errorChars: 512,
        },
      }),
    )
    expect(calls[1]?.req.maxBytes).toBe(8 * 1024 * 1024)
  })

  it('truncated 传播：renderedChars 二次裁剪生效且标记为真', async () => {
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://final.example/long',
      headers: { 'content-type': 'text/html' },
      body: `<article><p>${'很长的正文句子。'.repeat(50)}</p></article>`,
    })
    const out = await fetchPipeline(
      mkReq({
        mode: 'citations',
        budgets: { canonicalChars: 4096, renderedChars: 30, errorChars: 512 },
      }),
    )
    expect(out.content.length).toBeLessThanOrEqual(30)
    expect(out.truncated).toBe(true)
  })

  it('2xx 但全文抽空 → 注入 empty-fallback 解释文案（绝不静默空白）', async () => {
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://final.example/blank',
      headers: { 'content-type': 'text/html' },
      body: '<html><body></body></html>',
    })
    const out = await fetchPipeline(mkReq({ mode: 'fit' }))
    expect(out.statusCode).toBe(200)
    expect(out.content).not.toBe('')
    expect(out.content).toBe(fetchMessagesZh['webstack.fetch.empty-fallback'])
  })

  it('管道自身故障原样透传：ssrf-blocked 不被吞掉或二次包装', async () => {
    outboundMock.impl = () => Promise.reject(engineError('ssrf-blocked', 'blocked by ssrf gate'))
    await expect(fetchPipeline(mkReq())).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ssrf-blocked',
      message: 'blocked by ssrf gate',
    })
  })

  it('管道自身故障透传之二：aborted 同样原样抛出', async () => {
    outboundMock.impl = () => Promise.reject(engineError('aborted', 'caller abort'))
    await expect(fetchPipeline(mkReq())).rejects.toMatchObject({
      code: 'aborted',
      message: 'caller abort',
    })
  })

  it('citations 模式端到端：头部 + 「来源: finalUrl」行', async () => {
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://final.example/article',
      headers: { 'content-type': 'text/html' },
      body: `<article><p>${'引用视图的正文段落。'.repeat(120)}</p></article>`,
    })
    const out = await fetchPipeline(mkReq({ mode: 'citations' }))
    expect(out.mode).toBe('citations')
    expect(out.content).toContain('\n来源: https://final.example/article')
  })
})

describe('fetchPipeline × 站选选择器规则（F-203 接线）', () => {
  it('host 命中规则 → 窄化前优先按选择器抽取（mode 记 fit），噪声不混入', async () => {
    outboundMock.impl = fakeOutbound({
      status: 200,
      finalUrl: 'https://docs.example.com/post/1',
      headers: { 'content-type': 'text/html' },
      body:
        '<html><body><nav>导航噪声</nav>' +
        '<div class="article-body"><h2>规则标题</h2><p>规则抽取的正文段落，内容完整。</p></div>' +
        '</body></html>',
    })
    const out = await fetchPipeline(mkReq({ mode: 'raw' }), {
      rulesGetter: () => [
        { hostSuffix: 'example.com', selectors: { title: 'h2', content: 'div.article-body' } },
      ],
    })
    expect(out.mode).toBe('fit')
    expect(out.content.startsWith('规则标题\n')).toBe(true)
    expect(out.content).toContain('规则抽取的正文段落')
    expect(out.content).not.toContain('导航噪声')
    expect(out.truncated).toBe(false)
  })

  it('未命中回退：host 不匹配 / 选择器抽空 / getter 抛错 → 一律落默认链路且不致命', async () => {
    const body = `<article><p>${'默认管线的可读正文。'.repeat(30)}</p></article>`
    const init = {
      status: 200,
      finalUrl: 'https://origin.example/a',
      headers: { 'content-type': 'text/html' },
      body,
    }
    // host 不在规则表内
    outboundMock.impl = fakeOutbound(init)
    const missHost = await fetchPipeline(mkReq({ mode: 'fit' }), {
      rulesGetter: () => [{ hostSuffix: 'other.org', selectors: { content: 'div.main' } }],
    })
    expect(missHost.mode).toBe('fit')
    expect(missHost.content).toContain('默认管线的可读正文')
    // host 命中但选择器抽空
    outboundMock.impl = fakeOutbound(init)
    const missSelector = await fetchPipeline(mkReq({ mode: 'raw' }), {
      rulesGetter: () => [
        { hostSuffix: 'origin.example', selectors: { content: '.no-such-node' } },
      ],
    })
    expect(missSelector.mode).toBe('raw')
    expect(missSelector.content).toContain('默认管线的可读正文')
    // getter 自身抛错同样安全回落
    outboundMock.impl = fakeOutbound(init)
    const getterThrew = await fetchPipeline(mkReq({ mode: 'fit' }), {
      rulesGetter: () => {
        throw new Error('snapshot unavailable')
      },
    })
    expect(getterThrew.mode).toBe('fit')
    expect(getterThrew.content).toContain('默认管线的可读正文')
  })
})

describe('i18n fetch-safety 双语键', () => {
  it('zh/en 键集奇偶一致；%s 占位符只替换一次', () => {
    expect(Object.keys(fetchMessagesZh).sort()).toEqual(Object.keys(fetchMessagesEn).sort())
    expect(formatStatusPrefix(403)).toBe(
      '[HTTP 403] 目标站返回了非 2xx 状态，以下为其原始响应内容',
    )
    expect(formatStatusPrefix(403, 'en')).toContain('[HTTP 403]')
    expect(formatStatusPrefix(403, 'en')).not.toContain('%s')
  })
})
