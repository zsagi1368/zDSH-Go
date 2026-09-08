/**
 * 六家 keyed 引擎适配器离线测试（全离线，不出网）：
 * - 描述符契约：tier/keyed、keysRequired、延迟预算、深冻结、credSlot 唯一；
 * - 共享辅助：requireCredential / keyedHttpStatusError / attachPostBody；
 * - 各家纯解析器合成 fixture 回放（坏行跳过、截断、零结果语义）；
 * - 假 outbound 注入（stub global fetch 走真安全管道）：鉴权头与方法装配、
 *   429/401/403/5xx 错误映射、缺密钥不打网。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))

import {
  ANYSEARCH_CRED_SLOT,
  ANYSEARCH_DESCRIPTOR,
  AnysearchEngine,
  buildAnysearchPayload,
  parseAnysearchJson,
} from '../src/engines/anysearch.ts'
import {
  BRAVE_CRED_SLOT,
  BRAVE_DESCRIPTOR,
  BraveEngine,
  buildBraveUrl,
  parseBraveJson,
} from '../src/engines/brave.ts'
import {
  attachPostBody,
  KEYED_ENGINE_IDS,
  keyedHttpStatusError,
  requireCredential,
} from '../src/engines/engine.ts'
import {
  buildExaPayload,
  EXA_CRED_SLOT,
  EXA_DESCRIPTOR,
  ExaEngine,
  parseExaJson,
  resolveExaEndpoint,
} from '../src/engines/exa.ts'
import {
  buildFirecrawlPayload,
  FIRECRAWL_CRED_SLOT,
  FIRECRAWL_DESCRIPTOR,
  FirecrawlEngine,
  parseFirecrawlJson,
} from '../src/engines/firecrawl.ts'
import {
  buildJinaUrl,
  JINA_CRED_SLOT,
  JINA_DESCRIPTOR,
  JinaEngine,
  parseJinaJson,
} from '../src/engines/jina.ts'
import {
  buildTavilyPayload,
  parseTavilyJson,
  TAVILY_CRED_SLOT,
  TAVILY_DESCRIPTOR,
  TavilyEngine,
} from '../src/engines/tavily.ts'
import { keyedEngineMessagesEn, keyedEngineMessagesZh } from '../src/i18n/keyed-engines.ts'
import type { EngineDescriptor, EngineSearchRequest } from '../src/kernel/types.ts'

// ---------------------------------------------------------------------------
// 公共夹具
// ---------------------------------------------------------------------------

/** 六家凭据槽位的明文假键（仅进程内测试夹具）。 */
const CREDENTIALS = {
  tavilyKey: 'tvly-test',
  braveKey: 'brv-test',
  exaKey: 'exa-test',
  jinaKey: 'jina-test',
  firecrawlKey: 'fc-test',
  anysearchKey: 'as-test',
}

const CRED_SLOTS = [
  TAVILY_CRED_SLOT,
  BRAVE_CRED_SLOT,
  EXA_CRED_SLOT,
  JINA_CRED_SLOT,
  FIRECRAWL_CRED_SLOT,
  ANYSEARCH_CRED_SLOT,
]

const ALL_DESCRIPTORS: readonly EngineDescriptor[] = [
  TAVILY_DESCRIPTOR,
  BRAVE_DESCRIPTOR,
  EXA_DESCRIPTOR,
  JINA_DESCRIPTOR,
  FIRECRAWL_DESCRIPTOR,
  ANYSEARCH_DESCRIPTOR,
]

function makeReq(opts: { creds?: boolean; count?: number } = {}): EngineSearchRequest {
  const { creds = true, count = 5 } = opts
  return {
    query: 'keyed probe',
    hints: { topic: 'keyed probe', hard: [], soft: [] },
    count,
    layer: 'api',
    band: 'simple',
    ...(creds ? { credentials: CREDENTIALS } : {}),
  }
}

type FetchMock = ReturnType<
  typeof vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>
>

/** 注入假出站：stub global fetch（真安全管道照常执行 G1–G4，DNS 已顶层 mock）。 */
function stubFetch(handler: (url: string | URL, init?: RequestInit) => Response): FetchMock {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function runWithStub(run: (fetchMock: FetchMock) => unknown): Promise<void> {
  const fetchMock = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    await run(fetchMock)
  } finally {
    vi.unstubAllGlobals()
  }
}

/** 从首次 fetch 调用提取请求头视图。 */
function firstHeaders(fetchMock: FetchMock): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1]
  return (init?.headers ?? {}) as Record<string, string>
}

/** 从首次 fetch 调用提取目标 URL 文本。 */
function firstUrl(fetchMock: FetchMock): string {
  return String(fetchMock.mock.calls[0]?.[0] ?? '')
}

// ---------------------------------------------------------------------------
// 跨引擎描述符契约
// ---------------------------------------------------------------------------

describe('跨引擎描述符契约', () => {
  it('KEYED_ENGINE_IDS 与六家描述符 id 一一对应且顺序固定', () => {
    expect(KEYED_ENGINE_IDS).toEqual(['tavily', 'brave', 'exa', 'jina', 'firecrawl', 'anysearch'])
    expect(ALL_DESCRIPTORS.map(d => d.id)).toEqual([...KEYED_ENGINE_IDS])
  })

  it('全部 tier=keyed、kind=search、keysRequired=1、quotaHint=paid', () => {
    for (const d of ALL_DESCRIPTORS) {
      expect(d.tier).toBe('keyed')
      expect(d.kind).toBe('search')
      expect(d.cost.keysRequired).toBe(1)
      expect(d.cost.quotaHint).toBe('paid')
    }
  })

  it('延迟预算：firecrawl 放宽至 8000，其余恒 4000', () => {
    expect(FIRECRAWL_DESCRIPTOR.latencyBudgetMs).toBe(8000)
    for (const d of [
      TAVILY_DESCRIPTOR,
      BRAVE_DESCRIPTOR,
      EXA_DESCRIPTOR,
      JINA_DESCRIPTOR,
      ANYSEARCH_DESCRIPTOR,
    ]) {
      expect(d.latencyBudgetMs).toBe(4000)
    }
  })

  it('六家描述符运行期深冻结（含嵌套 caps/cost）', () => {
    for (const d of ALL_DESCRIPTORS) {
      expect(Object.isFrozen(d)).toBe(true)
      expect(Object.isFrozen(d.caps)).toBe(true)
      expect(Object.isFrozen(d.cost)).toBe(true)
    }
  })

  it('credSlot 形如 <id>Key 且两两唯一', () => {
    expect(new Set(CRED_SLOTS).size).toBe(CRED_SLOTS.length)
    for (const slot of CRED_SLOTS) expect(slot.endsWith('Key')).toBe(true)
    expect(TAVILY_CRED_SLOT).toBe('tavilyKey')
    expect(FIRECRAWL_CRED_SLOT).toBe('firecrawlKey')
  })
})

// ---------------------------------------------------------------------------
// keyed 共享辅助（engine.ts 追加面）
// ---------------------------------------------------------------------------

describe('keyed 共享辅助', () => {
  it('requireCredential 有键返回原值', () => {
    expect(requireCredential(makeReq(), 'tavily', 'tavilyKey')).toBe('tvly-test')
    expect(requireCredential(makeReq(), 'jina', 'jinaKey')).toBe('jina-test')
  })

  it('requireCredential 缺席槽位 → auth（W-B-55 只经头下发）', () => {
    expect(() => requireCredential(makeReq({ creds: false }), 'brave', 'braveKey')).toThrowError(
      expect.objectContaining({ name: 'EngineError', code: 'auth' }),
    )
  })

  it('空串密钥视同缺席 → auth', () => {
    const req = {
      ...makeReq(),
      credentials: { ...CREDENTIALS, exaKey: '' },
    } as EngineSearchRequest
    expect(() => requireCredential(req, 'exa', 'exaKey')).toThrowError(
      expect.objectContaining({ name: 'EngineError', code: 'auth' }),
    )
  })

  it('keyedHttpStatusError 429 + Retry-After → rate-limited 且换算毫秒', () => {
    const err = keyedHttpStatusError('tavily', 429, { 'Retry-After': '12' })
    expect(err.code).toBe('rate-limited')
    expect(err.retryAfterMs).toBe(12_000)
    expect(err.httpStatus).toBe(429)
    expect(err.engineId).toBe('tavily')
  })

  it('keyedHttpStatusError 429 无 Retry-After → retryAfterMs 保持缺席', () => {
    const err = keyedHttpStatusError('anysearch', 429, {})
    expect(err.code).toBe('rate-limited')
    expect(err.retryAfterMs).toBeUndefined()
  })

  it('keyedHttpStatusError 401/403 → auth（带 httpStatus）', () => {
    expect(keyedHttpStatusError('brave', 401).code).toBe('auth')
    const forbidden = keyedHttpStatusError('exa', 403)
    expect(forbidden.code).toBe('auth')
    expect(forbidden.httpStatus).toBe(403)
  })

  it('keyedHttpStatusError 其余状态 → http-upstream', () => {
    for (const status of [400, 404, 418, 500, 503]) {
      const err = keyedHttpStatusError('jina', status)
      expect(err.code).toBe('http-upstream')
      expect(err.httpStatus).toBe(status)
    }
  })

  it('attachPostBody 序列化载荷并返回同一请求对象', () => {
    const req = { url: 'https://api.example/x', maxBytes: 1000 }
    const returned = attachPostBody(req, { query: 'q z', limit: 3 })
    expect(returned).toBe(req)
    expect((req as { body?: string }).body).toBe(JSON.stringify({ query: 'q z', limit: 3 }))
  })
})

// ---------------------------------------------------------------------------
// i18n keyed-engines 分册
// ---------------------------------------------------------------------------

describe('i18n keyed-engines 双语分册', () => {
  it('zh/en 键集完全一致且 ≥6', () => {
    const zhKeys = Object.keys(keyedEngineMessagesZh).sort()
    const enKeys = Object.keys(keyedEngineMessagesEn).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBeGreaterThanOrEqual(6)
  })

  it('两表冻结且值非空串', () => {
    expect(Object.isFrozen(keyedEngineMessagesZh)).toBe(true)
    expect(Object.isFrozen(keyedEngineMessagesEn)).toBe(true)
    for (const table of [keyedEngineMessagesZh, keyedEngineMessagesEn]) {
      for (const value of Object.values(table)) expect(value.length).toBeGreaterThan(0)
    }
  })

  it('键前缀 webstack.engine.<id>.no-key 且覆盖六家 id', () => {
    for (const id of KEYED_ENGINE_IDS) {
      const key = `webstack.engine.${id}.no-key`
      expect(key in keyedEngineMessagesZh).toBe(true)
      expect(key in keyedEngineMessagesEn).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

describe('Tavily', () => {
  const FIXTURE = {
    results: [
      {
        title: 'Alpha',
        url: 'https://a.example/1',
        content: 'Body A',
        published_date: '2025-01-02T03:04:05Z',
      },
      { title: 'NoUrl', content: 'x' },
      { url: 'https://b.example/2' },
      { title: 'BadDate', url: 'https://c.example/3', published_date: 'yesterday' },
      { title: '', url: 'https://d.example/4' },
      { title: 'EmptyContent', url: 'https://e.example/5', content: '' },
      null,
      'garbage',
      { title: 'Omega', url: 'https://f.example/6', content: 'Body F' },
    ],
  }

  it('buildTavilyPayload：max_results=count；freshness 直映 days；缺席不带 days 键', () => {
    expect(buildTavilyPayload('q term', 3)).toEqual({ query: 'q term', max_results: 3 })
    expect(buildTavilyPayload('q', 5, 'week')).toEqual({ query: 'q', max_results: 5, days: 7 })
    expect(buildTavilyPayload('q', 5, 'day')).toEqual({ query: 'q', max_results: 5, days: 1 })
    expect('days' in buildTavilyPayload('q', 5)).toBe(false)
  })

  it('parseTavilyJson：content→snippet、published_date 仅 ISO、坏行整条跳过', () => {
    const hits = parseTavilyJson(FIXTURE, 10)
    expect(hits.map(h => h.url)).toEqual([
      'https://a.example/1',
      'https://c.example/3',
      'https://e.example/5',
      'https://f.example/6',
    ])
    expect(hits[0]).toMatchObject({
      title: 'Alpha',
      snippet: 'Body A',
      publishedAt: '2025-01-02T03:04:05Z',
      provenance: { engine: 'tavily' },
    })
    // 非 ISO 日期与空串内容 → 字段保持缺席
    expect('publishedAt' in (hits[1] ?? {})).toBe(false)
    expect('snippet' in (hits[2] ?? {})).toBe(false)
  })

  it('parseTavilyJson：count 截断；根/results 异常一律零结果（不是错误）', () => {
    expect(parseTavilyJson(FIXTURE, 2).length).toBe(2)
    expect(parseTavilyJson(FIXTURE, 0)).toEqual([])
    expect(parseTavilyJson('plain', 5)).toEqual([])
    expect(parseTavilyJson(null, 5)).toEqual([])
    expect(parseTavilyJson({ results: 'nope' }, 5)).toEqual([])
    expect(parseTavilyJson({}, 5)).toEqual([])
  })

  it('管道回放：POST + Bearer 头 + manual 重定向 → hits/attempts ok', async () => {
    await runWithStub(() => undefined) // 预热管道缓存（幂等）
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({ results: [{ title: 'Piped', url: 'https://a.example/9' }] }),
          {
            status: 200,
          },
        ),
    )
    try {
      const response = await new TavilyEngine().search(makeReq())
      expect(response.hits[0]?.provenance.engine).toBe('tavily')
      expect(response.attempts[0]?.outcome).toBe('ok')
      const init = fetchMock.mock.calls[0]?.[1]
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('manual')
      expect(firstHeaders(fetchMock).Authorization).toBe('Bearer tvly-test')
      expect(firstHeaders(fetchMock)['Content-Type']).toBe('application/json')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道 429 + Retry-After → rate-limited 且携带 retryAfterMs', async () => {
    await runWithStub(() => undefined)
    stubFetch(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } }))
    try {
      await expect(new TavilyEngine().search(makeReq())).rejects.toMatchObject({
        name: 'EngineError',
        code: 'rate-limited',
        retryAfterMs: 7000,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺密钥 → auth 且绝不打网', async () => {
    await runWithStub(async (fetchMock) => {
      await expect(new TavilyEngine().search(makeReq({ creds: false }))).rejects.toMatchObject({
        code: 'auth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Brave
// ---------------------------------------------------------------------------

describe('Brave', () => {
  const FIXTURE = {
    type: 'search',
    web: {
      results: [
        { title: 'Alpha', url: 'https://a.example/1', description: 'Desc A', age: '2 hours ago' },
        { title: 'IsoAge', url: 'https://b.example/2', description: 'd', age: '2025-06-30' },
        { url: 'https://missing.example/3' },
        { title: 'OnlyTitle' },
        { title: 'Gamma', url: 'https://c.example/4', description: 'Desc C' },
      ],
    },
  }

  it('buildBraveUrl：q 编码；count/freshness 存在才拼（month→pm）', () => {
    expect(buildBraveUrl('hello world')).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=hello%20world',
    )
    expect(buildBraveUrl('q', { count: 5 })).toContain('&count=5')
    expect(buildBraveUrl('q', { freshness: 'month' })).toContain('&freshness=pm')
    expect(buildBraveUrl('q', { freshness: 'day' })).toContain('&freshness=pd')
  })

  it('parseBraveJson：web.results 收窄；description→snippet；age 仅 ISO 形态直用', () => {
    const hits = parseBraveJson(FIXTURE, 10)
    expect(hits.map(h => h.title)).toEqual(['Alpha', 'IsoAge', 'Gamma'])
    expect(hits[0]?.snippet).toBe('Desc A')
    expect('publishedAt' in (hits[0] ?? {})).toBe(false) // 相对时间文案缺席
    expect(hits[1]?.publishedAt).toBe('2025-06-30')
    expect(hits[0]?.provenance.engine).toBe('brave')
  })

  it('parseBraveJson：count 截断；web 缺席/根异常一律零结果', () => {
    expect(parseBraveJson(FIXTURE, 2).length).toBe(2)
    expect(parseBraveJson({}, 5)).toEqual([])
    expect(parseBraveJson({ web: {} }, 5)).toEqual([])
    expect(parseBraveJson({ web: { results: 42 } }, 5)).toEqual([])
    expect(parseBraveJson([1, 2], 5)).toEqual([])
  })

  it('管道回放：GET + X-Subscription-Token + Accept json → hits/attempts ok', async () => {
    await runWithStub(() => undefined)
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({ web: { results: [{ title: 'Piped', url: 'https://a.example/9' }] } }),
          { status: 200 },
        ),
    )
    try {
      const response = await new BraveEngine().search(makeReq())
      expect(response.hits[0]?.title).toBe('Piped')
      expect(response.attempts[0]?.outcome).toBe('ok')
      const init = fetchMock.mock.calls[0]?.[1]
      expect(init?.method).toBe('GET')
      expect(firstUrl(fetchMock)).toContain('q=keyed%20probe')
      expect(firstUrl(fetchMock)).toContain('count=5')
      expect(firstHeaders(fetchMock)['X-Subscription-Token']).toBe('brv-test')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道 401 → auth', async () => {
    await runWithStub(() => undefined)
    stubFetch(() => new Response('denied', { status: 401 }))
    try {
      await expect(new BraveEngine().search(makeReq())).rejects.toMatchObject({
        code: 'auth',
        httpStatus: 401,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺密钥 → auth 且绝不打网', async () => {
    await runWithStub(async (fetchMock) => {
      await expect(new BraveEngine().search(makeReq({ creds: false }))).rejects.toMatchObject({
        code: 'auth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Exa
// ---------------------------------------------------------------------------

describe('Exa', () => {
  const FIXTURE = {
    requestId: 'req-1',
    results: [
      {
        title: 'Alpha',
        url: 'https://a.example/1',
        text: 'Text A',
        publishedDate: '2025-03-04T05:06:07',
      },
      { title: 'Beta', url: 'https://b.example/2' },
      'bad-row',
      null,
      { title: '', url: 'https://empty.example/4' },
      { title: 'Gamma', url: 'https://c.example/3', text: '', publishedDate: 'long ago' },
    ],
  }

  it('buildExaPayload：numResults=count', () => {
    expect(buildExaPayload('q term', 4)).toEqual({ query: 'q term', numResults: 4 })
  })

  it('parseExaJson：text→snippet、publishedDate 仅 ISO、坏行跳过', () => {
    const hits = parseExaJson(FIXTURE, 10)
    expect(hits.map(h => h.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(hits[0]).toMatchObject({
      url: 'https://a.example/1',
      snippet: 'Text A',
      publishedAt: '2025-03-04T05:06:07',
      provenance: { engine: 'exa' },
    })
    expect('publishedAt' in (hits[2] ?? {})).toBe(false)
    expect('snippet' in (hits[2] ?? {})).toBe(false)
  })

  it('parseExaJson：count 截断；results 异常一律零结果', () => {
    expect(parseExaJson(FIXTURE, 1).length).toBe(1)
    expect(parseExaJson(FIXTURE, 0)).toEqual([])
    expect(parseExaJson('x', 5)).toEqual([])
    expect(parseExaJson({ results: null }, 5)).toEqual([])
  })

  it('resolveExaEndpoint：默认官方端点；自定义 baseUrl 归一化拼接 /search（F-204）', () => {
    expect(resolveExaEndpoint()).toBe('https://api.exa.ai/search')
    expect(resolveExaEndpoint(undefined)).toBe('https://api.exa.ai/search')
    expect(resolveExaEndpoint('')).toBe('https://api.exa.ai/search')
    expect(resolveExaEndpoint('https://shim.example/v1')).toBe('https://shim.example/v1/search')
    expect(resolveExaEndpoint('https://shim.example/v1///')).toBe('https://shim.example/v1/search')
  })

  it('构造注入 baseUrl → 出站 URL 指认 exa-compatible shim 端点', async () => {
    await runWithStub(() => undefined)
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ results: [{ title: 'Shim', url: 'https://s.example/1' }] }), {
          status: 200,
        }),
    )
    try {
      const engine = new ExaEngine(EXA_DESCRIPTOR, { baseUrl: 'https://shim.example/v1/' })
      const response = await engine.search(makeReq())
      expect(response.hits.length).toBe(1)
      expect(firstUrl(fetchMock)).toBe('https://shim.example/v1/search')
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
      expect(firstHeaders(fetchMock)['x-api-key']).toBe('exa-test')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道回放：POST + x-api-key 头 → hits/attempts ok', async () => {
    await runWithStub(() => undefined)
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({ results: [{ title: 'Piped', url: 'https://a.example/9' }] }),
          {
            status: 200,
          },
        ),
    )
    try {
      const response = await new ExaEngine().search(makeReq())
      expect(response.hits.length).toBe(1)
      expect(response.attempts[0]?.outcome).toBe('ok')
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
      expect(firstHeaders(fetchMock)['x-api-key']).toBe('exa-test')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道 403 → auth', async () => {
    await runWithStub(() => undefined)
    stubFetch(() => new Response('forbidden', { status: 403 }))
    try {
      await expect(new ExaEngine().search(makeReq())).rejects.toMatchObject({ code: 'auth' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺密钥 → auth 且绝不打网', async () => {
    await runWithStub(async (fetchMock) => {
      await expect(new ExaEngine().search(makeReq({ creds: false }))).rejects.toMatchObject({
        code: 'auth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Jina（双形态兼容）
// ---------------------------------------------------------------------------

describe('Jina', () => {
  const WRAPPED = {
    code: 200,
    data: [
      {
        url: 'https://a.example/1',
        title: 'Alpha',
        description: 'Desc A',
        publishedAt: '2025-02-02',
      },
      { title: 'NoUrl' },
      { url: 'https://b.example/2', title: 'Beta', description: '', publishedAt: 'recently' },
    ],
  }
  const BARE = [{ url: 'https://c.example/3', title: 'Gamma', description: 'Desc G' }]

  it('buildJinaUrl：查询整体作为单个路径段编码（空格/斜杠/问号均安全）', () => {
    expect(buildJinaUrl('node js tips')).toBe('https://s.jina.ai/node%20js%20tips')
    expect(buildJinaUrl('a/b?q=1')).toBe('https://s.jina.ai/a%2Fb%3Fq%3D1')
  })

  it('parseJinaJson 包裹形 {data:[...]}：description→snippet、坏行跳过', () => {
    const hits = parseJinaJson(WRAPPED, 10)
    expect(hits.map(h => h.title)).toEqual(['Alpha', 'Beta'])
    expect(hits[0]).toMatchObject({
      url: 'https://a.example/1',
      snippet: 'Desc A',
      publishedAt: '2025-02-02',
      provenance: { engine: 'jina' },
    })
    expect('snippet' in (hits[1] ?? {})).toBe(false)
    expect('publishedAt' in (hits[1] ?? {})).toBe(false)
  })

  it('parseJinaJson 裸数组直出形等价处理；data 非数组/根异常零结果', () => {
    expect(parseJinaJson(BARE, 10)).toEqual([
      {
        url: 'https://c.example/3',
        title: 'Gamma',
        snippet: 'Desc G',
        provenance: { engine: 'jina' },
      },
    ])
    expect(parseJinaJson(WRAPPED, 10)).toEqual(parseJinaJson(WRAPPED.data, 10))
    expect(parseJinaJson({ data: 'nope' }, 5)).toEqual([])
    expect(parseJinaJson({}, 5)).toEqual([])
    expect(parseJinaJson(null, 5)).toEqual([])
    expect(parseJinaJson(BARE, 0)).toEqual([])
  })

  it('管道回放：GET + Bearer + Accept json + URL 路径段编码', async () => {
    await runWithStub(() => undefined)
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ data: [{ url: 'https://a.example/9', title: 'Piped' }] }), {
          status: 200,
        }),
    )
    try {
      const response = await new JinaEngine().search(makeReq())
      expect(response.hits.length).toBe(1)
      expect(response.attempts[0]?.outcome).toBe('ok')
      const init = fetchMock.mock.calls[0]?.[1]
      expect(init?.method).toBe('GET')
      expect(firstUrl(fetchMock)).toBe('https://s.jina.ai/keyed%20probe')
      const headers = firstHeaders(fetchMock)
      expect(headers.Authorization).toBe('Bearer jina-test')
      expect(headers.Accept).toBe('application/json')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道 500 → http-upstream', async () => {
    await runWithStub(() => undefined)
    stubFetch(() => new Response('boom', { status: 500 }))
    try {
      await expect(new JinaEngine().search(makeReq())).rejects.toMatchObject({
        code: 'http-upstream',
        httpStatus: 500,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺密钥 → auth 且绝不打网', async () => {
    await runWithStub(async (fetchMock) => {
      await expect(new JinaEngine().search(makeReq({ creds: false }))).rejects.toMatchObject({
        code: 'auth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// Firecrawl
// ---------------------------------------------------------------------------

describe('Firecrawl', () => {
  const FIXTURE = {
    success: true,
    data: [
      { title: 'Alpha', url: 'https://a.example/1', description: 'Desc A' },
      { title: 'Beta', url: 'https://b.example/2' },
      { success: true, metadata: {} },
      { title: 'Gamma', url: 'https://c.example/3', description: 'Desc C' },
    ],
  }

  it('buildFirecrawlPayload：limit=count', () => {
    expect(buildFirecrawlPayload('q term', 6)).toEqual({ query: 'q term', limit: 6 })
  })

  it('parseFirecrawlJson：description→snippet；元数据条目与非记录跳过', () => {
    const hits = parseFirecrawlJson(FIXTURE, 10)
    expect(hits.map(h => h.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ])
    expect(hits[0]).toMatchObject({ title: 'Alpha', snippet: 'Desc A' })
    expect('snippet' in (hits[1] ?? {})).toBe(false)
    expect(hits[2]?.provenance.engine).toBe('firecrawl')
  })

  it('parseFirecrawlJson：count 截断；data 缺席/根异常一律零结果', () => {
    expect(parseFirecrawlJson(FIXTURE, 2).length).toBe(2)
    expect(parseFirecrawlJson(FIXTURE, 0)).toEqual([])
    expect(parseFirecrawlJson({ success: false }, 5)).toEqual([])
    expect(parseFirecrawlJson({ data: 'nope' }, 5)).toEqual([])
    expect(parseFirecrawlJson(42, 5)).toEqual([])
  })

  it('管道回放：POST + Bearer → hits/attempts ok（延迟预算 8000 已在描述符锁定）', async () => {
    await runWithStub(() => undefined)
    const fetchMock = stubFetch(
      () =>
        new Response(JSON.stringify({ data: [{ title: 'Piped', url: 'https://a.example/9' }] }), {
          status: 200,
        }),
    )
    try {
      const response = await new FirecrawlEngine().search(makeReq())
      expect(response.hits.length).toBe(1)
      expect(response.attempts[0]?.outcome).toBe('ok')
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
      expect(firstHeaders(fetchMock).Authorization).toBe('Bearer fc-test')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道 503 → http-upstream', async () => {
    await runWithStub(() => undefined)
    stubFetch(() => new Response('unavailable', { status: 503 }))
    try {
      await expect(new FirecrawlEngine().search(makeReq())).rejects.toMatchObject({
        code: 'http-upstream',
        httpStatus: 503,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺密钥 → auth 且绝不打网', async () => {
    await runWithStub(async (fetchMock) => {
      await expect(new FirecrawlEngine().search(makeReq({ creds: false }))).rejects.toMatchObject({
        code: 'auth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// AnySearch
// ---------------------------------------------------------------------------

describe('AnySearch', () => {
  const FIXTURE = {
    results: [
      {
        title: 'Alpha',
        url: 'https://a.example/1',
        snippet: 'Snip A',
        publishedAt: '2025-05-05T05:05:05Z',
      },
      { title: 'BadDate', url: 'https://b.example/2', snippet: 's', publishedAt: 'last week' },
      { url: 'https://noname.example/3' },
      { title: 'Gamma', url: 'https://c.example/3' },
      ['nested-array'],
    ],
  }

  it('buildAnysearchPayload：count 透传', () => {
    expect(buildAnysearchPayload('q term', 8)).toEqual({ query: 'q term', count: 8 })
  })

  it('parseAnysearchJson：snippet 直用、publishedAt 仅 ISO、坏行跳过', () => {
    const hits = parseAnysearchJson(FIXTURE, 10)
    expect(hits.map(h => h.title)).toEqual(['Alpha', 'BadDate', 'Gamma'])
    expect(hits[0]).toMatchObject({
      snippet: 'Snip A',
      publishedAt: '2025-05-05T05:05:05Z',
      provenance: { engine: 'anysearch' },
    })
    expect('publishedAt' in (hits[1] ?? {})).toBe(false)
    expect('snippet' in (hits[2] ?? {})).toBe(false)
  })

  it('parseAnysearchJson：count 截断；results 异常一律零结果', () => {
    expect(parseAnysearchJson(FIXTURE, 1).length).toBe(1)
    expect(parseAnysearchJson(FIXTURE, 0)).toEqual([])
    expect(parseAnysearchJson(undefined, 5)).toEqual([])
    expect(parseAnysearchJson({ results: {} }, 5)).toEqual([])
  })

  it('管道回放：POST + Bearer → hits/attempts ok', async () => {
    await runWithStub(() => undefined)
    const fetchMock = stubFetch(
      () =>
        new Response(
          JSON.stringify({ results: [{ title: 'Piped', url: 'https://a.example/9' }] }),
          {
            status: 200,
          },
        ),
    )
    try {
      const response = await new AnysearchEngine().search(makeReq())
      expect(response.hits.length).toBe(1)
      expect(response.attempts[0]?.outcome).toBe('ok')
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
      expect(firstHeaders(fetchMock).Authorization).toBe('Bearer as-test')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('管道 429 无 Retry-After → rate-limited 且无 retryAfterMs', async () => {
    await runWithStub(() => undefined)
    stubFetch(() => new Response('limited', { status: 429 }))
    try {
      await expect(new AnysearchEngine().search(makeReq())).rejects.toMatchObject({
        code: 'rate-limited',
        retryAfterMs: undefined,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺密钥 → auth 且绝不打网；非法 JSON → narrow-failed', async () => {
    await runWithStub(async (fetchMock) => {
      await expect(new AnysearchEngine().search(makeReq({ creds: false }))).rejects.toMatchObject({
        code: 'auth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>not-json</html>', { status: 200 })),
      )
      try {
        await expect(new AnysearchEngine().search(makeReq())).rejects.toMatchObject({
          code: 'narrow-failed',
        })
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})
