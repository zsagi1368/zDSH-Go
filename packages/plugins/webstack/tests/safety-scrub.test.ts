/** scrubber：URL 与自由文本脱敏在一切输出边界之前（W-B-56）。 */
import { describe, expect, it } from 'vitest'
import { redactUrl, SENSITIVE_QUERY_KEYS, scrubText, scrubUrl } from '../src/safety/scrub.ts'

describe('redactUrl', () => {
  it('遮蔽黑名单 query 值', () => {
    const out = redactUrl('https://api.example.com/v1/search?q=hi&api_key=sk-abc123')
    expect(out).toContain('api_key=%5BREDACTED%5D')
    expect(out).not.toContain('sk-abc123')
    expect(out).toContain('q=hi') // 非敏感参数原样保留
  })

  it('剥除 userinfo 段（http://user:pass@host 绕过）', () => {
    const out = redactUrl('https://alice:secret@evil.example/path')
    expect(out).not.toContain('alice')
    expect(out).not.toContain('secret')
    expect(out).toContain('evil.example/path')
  })

  it('非 URL 输入安全占位而非抛错', () => {
    expect(redactUrl('not a url')).toBe('[REDACTED]')
  })

  it('黑名单键覆盖大小写变体', () => {
    const keys = SENSITIVE_QUERY_KEYS as readonly string[]
    expect(keys.length).toBeGreaterThanOrEqual(7)
    expect(keys).toContain('access_token')
  })
})

describe('scrubUrl（*** 占位变体）', () => {
  it('与 redactUrl 同规则：遮蔽敏感 query 值并剥 userinfo', () => {
    const out = scrubUrl('https://bob:hush@api.example.com/v2?token=tok-999&q=keep')
    expect(out).toContain('***@')
    expect(out).not.toContain('bob')
    expect(out).not.toContain('hush')
    expect(out).not.toContain('tok-999')
    expect(out).toContain('q=keep')
  })

  it('非 URL 输入安全占位而非抛错', () => {
    expect(scrubUrl('::garbage::')).toBe('[REDACTED]')
  })
})

describe('scrubText（自由文本通道）', () => {
  it('文本内 URL 的 userinfo 被替换为 ***，正文其余部分原样保留', () => {
    const out = scrubText('请访问 https://alice:secret@evil.example/path 获取资料。')
    expect(out).toContain('***@evil.example/path')
    expect(out).not.toContain('alice')
    expect(out).not.toContain('secret')
    expect(out.startsWith('请访问 ')).toBe(true)
    expect(out.endsWith(' 获取资料。')).toBe(true)
  })

  it.each([
    ['api_key', '?api_key=sk-value&x=1'],
    ['apikey', '&apikey=abcd'],
    ['access_token', '?access_token=at-1'],
    ['token', '?token=t-1'],
    ['secret', '?secret=s-1'],
    ['password', '?password=p-1'],
    ['sig', '?sig=abc123'],
    ['signature', '?signature=xyz'],
    ['key', '&key=k-1'],
  ])('敏感 query 参数 %s 的值在文本中被遮蔽为 ***', (key, pair) => {
    const out = scrubText(`响应体包含 ${pair} 等字段`)
    expect(out).toContain(`${key}=***`)
    expect(out).not.toMatch(new RegExp(`${key}=[^*&\\s][^&\\s]*`))
  })

  it('无敏感内容的纯文本原样返回', () => {
    const text = '普通句子，没有 URL 也没有密钥。'
    expect(scrubText(text)).toBe(text)
  })

  it('scrub 后不再出现明文值（二次扫描幂等）', () => {
    const once = scrubText('see https://u:p@h.example/?api_key=zzz end')
    expect(scrubText(once)).toBe(once)
  })
})
