/** 出站客户端：G1–G4 全链路离线回放（mock fetch/dns），冻结错误语义（分册 05 §1.3）。 */
import { afterEach, beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

import { lookup } from 'node:dns/promises'
import { isEngineError } from '../src/kernel/errors.ts'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECT_HOPS,
  OUTBOUND_PROTOCOLS,
  outboundFetch,
  USER_AGENT_PRODUCT,
} from '../src/safety/outbound.ts'

interface LookupAddress {
  address: string
  family: number
}
type AllLookupFn = (hostname: string, options: { all: boolean }) => Promise<LookupAddress[]>
const mockLookup = lookup as unknown as MockedFunction<AllLookupFn>

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

/** 按请求 URL 路由的 fetch mock：记录每次调用的 init 供断言。 */
type FetchMock = MockedFunction<(input: string | URL, init?: RequestInit) => Promise<Response>>
const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit): Promise<Response> => {
  throw new Error('fetch mock 未配置该 URL')
}) as FetchMock

beforeEach(() => {
  fetchMock.mockReset() // vitest restoreMocks 不重置裸 vi.fn 的调用历史，显式清零
  mockLookup.mockReset()
  mockLookup.mockImplementation(async () => PUBLIC)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    ...(headers === undefined ? {} : { headers }),
  })
}

describe('出站白名单', () => {
  it('仅允许 http/https 协议', () => {
    expect([...OUTBOUND_PROTOCOLS]).toEqual(['http:', 'https:'])
    expect(USER_AGENT_PRODUCT).toBe('webstack')
  })
})

describe('outboundFetch 直连', () => {
  it('200 正常返回：status/finalUrl/bytes/text 一致；fetch 收到 redirect=manual', async () => {
    const calls: RequestInit[] = []
    fetchMock.mockImplementation(async (_input, init) => {
      calls.push(init ?? {})
      return jsonResponse('hello webstack', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await outboundFetch({
      url: 'https://a.example/page',
      maxBytes: 1024,
    })
    expect(res.status).toBe(200)
    expect(res.finalUrl).toBe('https://a.example/page')
    expect(res.bytes).toBe(14)
    await expect(res.text()).resolves.toBe('hello webstack')
    expect(calls[0]?.redirect).toBe('manual')
    expect(String(calls[0]?.signal)).toBeTruthy() // 双态取消信号已挂载
  })

  it('非 2xx 如实上呈不抛错（status 是数据不是异常）', async () => {
    fetchMock.mockImplementation(async () => jsonResponse('server exploded', 503))
    vi.stubGlobal('fetch', fetchMock)
    const res = await outboundFetch({
      url: 'https://a.example/x',
      maxBytes: 100,
    })
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('server exploded')
  })

  it('体超 maxBytes 截断：bytes=实收上限，text 为已收内容，连接被 abort', async () => {
    fetchMock.mockImplementation(async () => jsonResponse('A'.repeat(1000), 200))
    vi.stubGlobal('fetch', fetchMock)
    const res = await outboundFetch({
      url: 'https://a.example/big',
      maxBytes: 10,
    })
    expect(res.bytes).toBe(10)
    expect((await res.text()).length).toBe(10)
  })
})

describe('outboundFetch G3 重定向复验', () => {
  it('同源 3xx 链逐跳复验后放行，Authorization 头同源保留', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/start'))
        return jsonResponse('', 302, { location: 'https://a.example/mid' })
      if (url.endsWith('/mid')) return jsonResponse('', 302, { location: 'https://a.example/end' })
      return jsonResponse('final body', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await outboundFetch({
      url: 'https://a.example/start',
      headers: { Authorization: 'Bearer tok' },
      maxBytes: 100,
    })
    expect(res.finalUrl).toBe('https://a.example/end')
    expect(await res.text()).toBe('final body')
    // 三次调用均带 Authorization（同源不剥）
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer tok')
    }
  })

  it('跨源跳转剥 Cookie（放行但第二跳请求头不再携带）', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://a.example'))
        return jsonResponse('', 302, { location: 'https://b.example/land' })
      return jsonResponse('cross body', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await outboundFetch({
      url: 'https://a.example/start',
      headers: { Cookie: 'session=xyz' },
      maxBytes: 100,
    })
    expect(res.finalUrl).toBe('https://b.example/land')
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>
    expect(secondHeaders.Cookie).toBeUndefined()
  })

  it('带 Authorization 的跨源跳转硬拒 redirect-cross-origin-auth', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://a.example'))
        return jsonResponse('', 302, { location: 'https://b.example/' })
      return jsonResponse('should not reach', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    const err = await outboundFetch({
      url: 'https://a.example/start',
      headers: { Authorization: 'Bearer tok' },
      maxBytes: 100,
    }).catch((e: unknown) => e)
    expect(isEngineError(err)).toBe(true)
    expect(err).toMatchObject({
      code: 'ssrf-blocked',
      detail: 'redirect-cross-origin-auth',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1) // 拒绝发生在第二跳发起前
  })

  it(`超过 ${MAX_REDIRECT_HOPS} 跳拒绝（transport / redirect-limit-exceeded）`, async () => {
    let n = 0
    fetchMock.mockImplementation(async () => {
      n += 1
      return jsonResponse('', 302, { location: `https://a.example/hop${n}` })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      outboundFetch({ url: 'https://a.example/hop0', maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'transport',
      detail: 'redirect-limit-exceeded',
    })
    // 初始 + MAX_REDIRECT_HOPS 跳后，第 6 个 3xx 响应触发拒绝
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECT_HOPS + 1)
  })

  it(`${MAX_REDIRECT_HOPS} 跳整随后 200 → 边界内放行`, async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
        if (url === `https://a.example/h${i}`)
          return jsonResponse('', 302, {
            location: `https://a.example/h${i + 1}`,
          })
      }
      return jsonResponse('arrived', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await outboundFetch({
      url: 'https://a.example/h0',
      maxBytes: 100,
    })
    expect(res.finalUrl).toBe(`https://a.example/h${MAX_REDIRECT_HOPS}`)
  })

  it('重定向到内网目标 → ssrf-blocked / redirect-to-blocked', async () => {
    mockLookup.mockImplementation(async hostname =>
      hostname === 'internal.example' ? [{ address: '192.168.1.10', family: 4 }] : PUBLIC,
    )
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('https://a.example'))
        return jsonResponse('', 302, {
          location: 'http://internal.example/admin',
        })
      return jsonResponse('should not reach', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      outboundFetch({ url: 'https://a.example/start', maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'ssrf-blocked',
      detail: 'redirect-to-blocked',
    })
  })

  it('Location 相对路径按当前 URL 解析后再复验', async () => {
    let called = false
    fetchMock.mockImplementation(async () => {
      if (!called) {
        called = true
        return jsonResponse('', 302, { location: '/next' })
      }
      return jsonResponse('done', 200)
    })
    vi.stubGlobal('fetch', fetchMock)
    // 首跳目标公网放行；相对 Location 解析为同源 https://public.example/next
    const res = await outboundFetch({
      url: 'https://public.example/start',
      maxBytes: 10,
    })
    expect(res.finalUrl).toBe('https://public.example/next')
    expect(await res.text()).toBe('done')
  })
})

describe('outboundFetch 错误语义（冻结）', () => {
  it('G1 静态拒绝 → ssrf-blocked 且不发网络请求', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const err = await outboundFetch({
      url: 'ftp://x.example/f',
      maxBytes: 10,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'ssrf-blocked',
      detail: 'scheme-disallowed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DNS 失败 → ssrf-blocked / dns-resolution-failed', async () => {
    mockLookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      outboundFetch({ url: 'https://nonexistent.invalid/', maxBytes: 10 }),
    ).rejects.toMatchObject({
      code: 'ssrf-blocked',
      detail: 'dns-resolution-failed',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('调用前已中止的 signal → aborted，且不发网络请求', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    await expect(
      outboundFetch({
        url: 'https://a.example/',
        maxBytes: 10,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'EngineError', code: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch 网络层异常 → transport（带 cause 透传）', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED')
    })
    vi.stubGlobal('fetch', fetchMock)
    const err = await outboundFetch({
      url: 'https://dead.example/',
      maxBytes: 10,
    }).catch((e: unknown) => e)
    expect(isEngineError(err)).toBe(true)
    expect(err).toMatchObject({ code: 'transport' })
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(TypeError)
  })

  it('timeoutMs 缺省时使用 DEFAULT_TIMEOUT_MS 预算', async () => {
    const calls: RequestInit[] = []
    fetchMock.mockImplementation(async (_input, init) => {
      calls.push(init ?? {})
      return jsonResponse('ok')
    })
    vi.stubGlobal('fetch', fetchMock)
    await outboundFetch({ url: 'https://a.example/', maxBytes: 10 })
    const signal = calls[0]?.signal as AbortSignal
    expect(signal.aborted).toBe(false)
    expect(DEFAULT_TIMEOUT_MS).toBe(8000)
  })
})

// ---------------------------------------------------------------------------
// W10 审计回归：错误消息拼接面的凭据泄漏与注入截断
// ---------------------------------------------------------------------------

describe('W10 回归：错误消息脱敏', () => {
  it('DNS 失败消息经 redactUrl：api_key query 值不得出现在 message', async () => {
    mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    vi.stubGlobal('fetch', fetchMock)
    const err = await outboundFetch({
      url: 'https://leak.example/search?q=x&api_key=TOPSECRET',
      maxBytes: 10,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'ssrf-blocked', detail: 'dns-resolution-failed' })
    expect(String((err as Error).message)).not.toContain('TOPSECRET')
    expect(String((err as Error).message)).toContain('REDACTED') // searchParams.set 会百分号编码占位符
  })

  it('非法 Location 头：进消息前被 scrub+截断，敏感 query 与超长串不透传', async () => {
    const hostile = `http://evil.example/?key=TOPSECRET&token=LEAKME%zz${'x'.repeat(4000)}`
    mockLookup.mockImplementation(async () => PUBLIC)
    fetchMock.mockImplementation(async () => jsonResponse('', 302, { location: hostile }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await outboundFetch({
      url: 'https://public.example/start',
      maxBytes: 10,
    }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'transport' })
    const message = String((err as Error).message)
    expect(message).not.toContain('TOPSECRET')
    expect(message).not.toContain('LEAKME')
    expect(message.length).toBeLessThan(400)
  })
})
