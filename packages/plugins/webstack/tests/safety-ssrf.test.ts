/** SSRF 四道闸：G1/G2 核验、IP 分类、豁免与 G3 重定向复验（W-B-50/F-007）。 */
import { beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

import { lookup } from 'node:dns/promises'
import {
  fetchSafetyBlockedEn,
  fetchSafetyBlockedKey,
  fetchSafetyBlockedZh,
} from '../src/i18n/fetch-safety.ts'
import { SAFETY_GATE_ORDER } from '../src/kernel/types.ts'
import { allow, assertSafeRedirect, checkTarget, classifyIp, reject } from '../src/safety/ssrf.ts'

/** 收窄后的 dns.lookup mock 视图（只关心 all:true 的 promise 分支）。 */
interface LookupAddress {
  address: string
  family: number
}
type AllLookupFn = (hostname: string, options: { all: boolean }) => Promise<LookupAddress[]>
const mockLookup = lookup as unknown as MockedFunction<AllLookupFn>

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

beforeEach(() => {
  mockLookup.mockReset()
  mockLookup.mockImplementation(async () => PUBLIC) // 缺省解析为公网地址
})

describe('SAFETY_GATE_ORDER', () => {
  it('执行顺序 G1→G2→G3→G4 冻结', () => {
    expect([...SAFETY_GATE_ORDER]).toEqual(['G1-static', 'G2-dns', 'G3-redirect', 'G4-body-bound'])
  })
})

describe('裁决构造', () => {
  it('reject 必须携带闸位与原因码；detail 缺席保持缺席', () => {
    const verdict = reject('G2-dns', 'loopback')
    expect(verdict).toEqual({
      allowed: false,
      gate: 'G2-dns',
      reasonCode: 'loopback',
    })
    expect(allow()).toEqual({ allowed: true })
    expect('gate' in allow()).toBe(false)
  })
})

describe('classifyIp 表驱动（≥12 例，含 ::ffff: 映射）', () => {
  const TABLE: readonly (readonly [string, string])[] = [
    ['127.0.0.1', 'loopback'],
    ['127.254.9.9', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'], // 172.16/12 边界外
    ['192.168.1.1', 'private'],
    ['169.254.10.20', 'link-local'],
    ['0.1.2.3', 'reserved'],
    ['100.64.0.1', 'reserved'], // CGNAT
    ['100.128.0.1', 'public'], // CGNAT 边界外
    ['192.0.0.5', 'reserved'],
    ['198.18.0.7', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['198.20.0.1', 'public'],
    ['224.0.0.9', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['8.8.8.8', 'public'],
    ['::1', 'loopback'],
    ['::', 'reserved'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fc00::abcd', 'private'],
    ['fd12:3456::1', 'private'],
    ['2001:db8::1', 'public'],
    // ::ffff: 映射地址必须剥前缀后按 v4 判定
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.5', 'private'],
    ['::FFFF:169.254.1.1', 'link-local'],
    ['::ffff:8.8.4.4', 'public'],
    ['not-an-ip', 'unknown'],
  ]
  it.each(TABLE)('%s → %s', (ip, expected) => {
    expect(classifyIp(ip)).toBe(expected)
  })
})

describe('checkTarget G1 静态闸', () => {
  it.each([
    ['完全非法字符串', 'not a url at all'],
    ['ftp 协议', 'ftp://files.example.com/pub'],
    ['file 协议', 'file:///etc/passwd'],
    ['javascript 协议', 'javascript:alert(1)'],
  ])('%s 拒 scheme-disallowed', (_label, url) => {
    return expect(checkTarget(url)).resolves.toMatchObject({
      allowed: false,
      gate: 'G1-static',
      reasonCode: 'scheme-disallowed',
    })
  })

  it('userinfo 段拒 userinfo-present；诊断 detail 已脱敏', async () => {
    const verdict = await checkTarget('https://alice:secret@example.com/')
    expect(verdict).toMatchObject({
      allowed: false,
      gate: 'G1-static',
      reasonCode: 'userinfo-present',
    })
    expect(verdict.detail).not.toContain('alice')
    expect(verdict.detail).not.toContain('secret')
  })

  it.each(['https://example.com:22/', 'https://example.com:6379/', 'http://example.com:27017/'])(
    '高危端口 %s 拒 nonstandard-port',
    async (url) => {
      expect(await checkTarget(url)).toMatchObject({
        allowed: false,
        gate: 'G1-static',
        reasonCode: 'nonstandard-port',
      })
      expect(mockLookup).not.toHaveBeenCalled() // G1 先于 G2
    },
  )

  it('黑名单制放行自托管常用高位端口（8080/11235 不在名单）', async () => {
    for (const port of [8080, 11235]) {
      expect(await checkTarget(`https://example.org:${port}/`)).toEqual({
        allowed: true,
      })
    }
  })
})

describe('checkTarget G2 DNS 网段判定与豁免', () => {
  it('回环地址拒 loopback（G2-dns）', async () => {
    mockLookup.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }])
    expect(await checkTarget('https://evil.example/')).toMatchObject({
      allowed: false,
      gate: 'G2-dns',
      reasonCode: 'loopback',
    })
  })

  it('多地址任一落入内网即拒（防重绑定），报 private-range', async () => {
    mockLookup.mockImplementation(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ])
    expect(await checkTarget('https://rebind.example/')).toMatchObject({
      allowed: false,
      gate: 'G2-dns',
      reasonCode: 'private-range',
    })
  })

  it.each([
    ['169.254.1.1', 'link-local'],
    ['100.64.1.1', 'reserved-range'],
  ])('%s 拒 %s', async (address, reason) => {
    mockLookup.mockImplementation(async () => [{ address, family: 4 }])
    expect(await checkTarget('https://x.example/')).toMatchObject({
      allowed: false,
      gate: 'G2-dns',
      reasonCode: reason,
    })
  })

  it('CIDR 豁免命中：10.1.2.3 在 10.0.0.0/8 内 → 放行且仍走 DNS', async () => {
    mockLookup.mockImplementation(async () => [{ address: '10.1.2.3', family: 4 }])
    expect(await checkTarget('https://intranet.example/', ['10.0.0.0/8'])).toEqual({
      allowed: true,
    })
    expect(mockLookup).toHaveBeenCalledOnce()
  })

  it('CIDR 豁免不命中：网段不覆盖时维持拒绝', async () => {
    mockLookup.mockImplementation(async () => [{ address: '10.1.2.3', family: 4 }])
    expect(await checkTarget('https://intranet.example/', ['10.64.0.0/12'])).toMatchObject({
      allowed: false,
      reasonCode: 'private-range',
    })
  })

  it('host:port 豁免命中：整段跳过 G2 且不发起 DNS', async () => {
    expect(
      await checkTarget('https://internal.example.org:8080/', ['internal.example.org:8080']),
    ).toEqual({
      allowed: true,
    })
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('host 豁免端口不符则不豁免（回落正常 G2 判定）', async () => {
    expect(
      await checkTarget('https://internal.example.org:9090/', ['internal.example.org:8080']),
    ).toEqual({
      allowed: true,
    }) // 默认公网解析下放行，但 DNS 必须被调用
    expect(mockLookup).toHaveBeenCalledOnce()
  })

  it('正常 https 公网目标放行', async () => {
    expect(await checkTarget('https://example.com/search?q=1')).toEqual({
      allowed: true,
    })
  })

  it('DNS 解析失败原样上抛（由 outbound 归一为 ssrf-blocked）', async () => {
    mockLookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    )
    await expect(checkTarget('https://nonexistent.invalid/')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    })
  })
})

describe('assertSafeRedirect（G3 三分支）', () => {
  it('分支一：目标过 G1+G2 → 正常返回不抛', async () => {
    await expect(
      assertSafeRedirect('https://a.example/x', 'https://b.example/y', false),
    ).resolves.toBeUndefined()
  })

  it('分支二：目标被 G2 拒 → ssrf-blocked / redirect-to-blocked', async () => {
    mockLookup.mockImplementation(async () => [{ address: '127.0.0.1', family: 4 }])
    await expect(
      assertSafeRedirect('https://a.example/x', 'http://127.0.0.1:8080/', false),
    ).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ssrf-blocked',
      detail: 'redirect-to-blocked',
    })
  })

  it('分支二变体：目标被 G1 拒同样折算 redirect-to-blocked', async () => {
    await expect(
      assertSafeRedirect('https://a.example/x', 'ftp://b.example/y', false),
    ).rejects.toMatchObject({
      code: 'ssrf-blocked',
      detail: 'redirect-to-blocked',
    })
  })

  it('分支三：带 Authorization 头且跨源 → ssrf-blocked / redirect-cross-origin-auth', async () => {
    await expect(
      assertSafeRedirect('https://a.example/x', 'https://b.example/y', true),
    ).rejects.toMatchObject({
      code: 'ssrf-blocked',
      detail: 'redirect-cross-origin-auth',
    })
  })

  it('带 Authorization 但同源跳转放行', async () => {
    await expect(
      assertSafeRedirect('https://a.example/x', 'https://a.example/y', true),
    ).resolves.toBeUndefined()
  })
})

describe('fetch-safety i18n（webstack.safety.blocked.*）', () => {
  it('zh/en 键集奇偶一致、≥6 键、值非空且对象冻结', () => {
    const zhKeys = Object.keys(fetchSafetyBlockedZh)
    const enKeys = Object.keys(fetchSafetyBlockedEn)
    expect(zhKeys.length).toBeGreaterThanOrEqual(6)
    expect(zhKeys.length).toBe(enKeys.length)
    expect([...zhKeys].sort()).toEqual([...enKeys].sort())
    for (const key of zhKeys as (keyof typeof fetchSafetyBlockedZh)[]) {
      expect(fetchSafetyBlockedZh[key].length).toBeGreaterThan(0)
      expect(fetchSafetyBlockedEn[key].length).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(fetchSafetyBlockedZh)).toBe(true)
    expect(Object.isFrozen(fetchSafetyBlockedEn)).toBe(true)
  })

  it('reasonCode → 键映射覆盖六族；link-local 并入 reserved', () => {
    expect(fetchSafetyBlockedKey('scheme-disallowed')).toBe('webstack.safety.blocked.scheme')
    expect(fetchSafetyBlockedKey('userinfo-present')).toBe('webstack.safety.blocked.userinfo')
    expect(fetchSafetyBlockedKey('nonstandard-port')).toBe('webstack.safety.blocked.port')
    expect(fetchSafetyBlockedKey('loopback')).toBe('webstack.safety.blocked.loopback')
    expect(fetchSafetyBlockedKey('private-range')).toBe('webstack.safety.blocked.private')
    expect(fetchSafetyBlockedKey('link-local')).toBe('webstack.safety.blocked.reserved')
    expect(fetchSafetyBlockedKey('reserved-range')).toBe('webstack.safety.blocked.reserved')
    expect(fetchSafetyBlockedKey('redirect-to-blocked')).toBe('webstack.safety.blocked.reserved')
  })
})

// ---------------------------------------------------------------------------
// W10 审计回归：IPv6 缩写/映射绕过与豁免匹配边界
// ---------------------------------------------------------------------------

describe('W10 回归：classifyIp 十六进制形态 IPv4 映射地址', () => {
  it('::ffff:7f00:1（=::ffff:127.0.0.1 的 inet_ntop 规范输出）判 loopback', () => {
    expect(classifyIp('::ffff:7f00:1')).toBe('loopback')
    expect(classifyIp('::FFFF:7F00:1')).toBe('loopback') // 大小写容忍
  })

  it('映射前缀内嵌私有 v4（hex 形态）按 v4 规则判 private', () => {
    expect(classifyIp('::ffff:a00:1')).toBe('private') // 10.0.0.1
    expect(classifyIp('::ffff:ac10:fe01')).toBe('private') // 172.16.254.1
    expect(classifyIp('0:0:0:0:0:ffff:c0a8:101')).toBe('private') // 192.168.1.1 全展开
    expect(classifyIp('::ffff:a9fe:101')).toBe('link-local') // 169.254.1.1
  })

  it('NAT64 已知前缀 64:ff9b::/96 fail-closed 判 reserved', () => {
    expect(classifyIp('64:ff9b::7f00:1')).toBe('reserved')
    expect(classifyIp('64:ff9b::0808:0808')).toBe('reserved') // 尾嵌公网 v4 也拒
  })

  it('常规公网 v6 不受映射复判影响；非映射全零尾段维持原语义', () => {
    expect(classifyIp('2001:db8::1')).toBe('public')
    expect(classifyIp('2606:4700:4700::1111')).toBe('public')
    expect(classifyIp('::1')).toBe('loopback')
    expect(classifyIp('::')).toBe('reserved')
    expect(classifyIp('::0.0.0.2')).toBe('reserved') // 全零前缀 + 非零尾（IPv4 兼容残形）维持 fail-closed
  })

  it('checkTarget G2 对 AAAA 返回 hex 映射回环地址同样拒绝', async () => {
    mockLookup.mockImplementation(async () => [{ address: '::ffff:7f00:1', family: 6 }])
    const verdict = await checkTarget('https://rebind.example/')
    expect(verdict).toMatchObject({ allowed: false, gate: 'G2-dns', reasonCode: 'loopback' })
  })
})

describe('W10 回归：豁免 host:port 匹配边界', () => {
  it('缺省端口等价：example.internal:443 命中 https 默认端口 URL（跳过 G2 且不发 DNS）', async () => {
    mockLookup.mockImplementation(async () => [{ address: '10.1.2.3', family: 4 }])
    const verdict = await checkTarget('https://example.internal/', ['example.internal:443'])
    expect(verdict).toEqual({ allowed: true })
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('http 缺省端口等价：a.internal:80 命中 http://a.internal/', async () => {
    mockLookup.mockImplementation(async () => [{ address: '192.168.0.9', family: 4 }])
    const verdict = await checkTarget('http://a.internal/x', ['a.internal:80'])
    expect(verdict).toEqual({ allowed: true })
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('端口不匹配仍走 G2：条目 :443 不放行 http 默认端口目标', async () => {
    mockLookup.mockImplementation(async () => [{ address: '10.0.0.7', family: 4 }])
    const verdict = await checkTarget('http://b.internal/', ['b.internal:443'])
    expect(verdict).toMatchObject({ allowed: false, reasonCode: 'private-range' })
  })

  it('方括号 IPv6 字面量豁免：[fe80::1]:8080 与 hostname fe80::1 同一比较域', async () => {
    const verdict = await checkTarget('http://[fe80::1]:8080/', ['[fe80::1]:8080'])
    expect(verdict).toEqual({ allowed: true })
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('大小写归一：EXAMPLE.INTERNAL:443 豁免命中小写 hostname（含缺省端口）', async () => {
    mockLookup.mockImplementation(async () => [{ address: '172.16.0.5', family: 4 }])
    const verdict = await checkTarget('https://example.internal/', ['EXAMPLE.INTERNAL:443'])
    expect(verdict).toEqual({ allowed: true })
  })
})
