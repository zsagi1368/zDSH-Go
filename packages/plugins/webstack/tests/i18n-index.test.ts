/** i18n 统一查找表：四册合并、键奇偶一致、无跨册冲突（W-B-79 / W-B-53）。 */
import { describe, expect, it } from 'vitest'
import { cacheCredsMessagesEn, cacheCredsMessagesZh } from '../src/i18n/cache-creds.ts'
import { doctorMessagesEn, doctorMessagesZh } from '../src/i18n/doctor.ts'
import { errorMessagesEn } from '../src/i18n/en.ts'
import { engineMessagesEn, engineMessagesZh } from '../src/i18n/engines.ts'
import {
  fetchMessagesEn,
  fetchMessagesZh,
  fetchSafetyBlockedEn,
  fetchSafetyBlockedZh,
} from '../src/i18n/fetch-safety.ts'
import { errorText, text } from '../src/i18n/index.ts'
import { errorMessagesZh } from '../src/i18n/zh.ts'

const BOOKS_ZH = [
  errorMessagesZh,
  engineMessagesZh,
  cacheCredsMessagesZh,
  fetchMessagesZh,
  fetchSafetyBlockedZh,
  doctorMessagesZh,
] as const

const BOOKS_EN = [
  errorMessagesEn,
  engineMessagesEn,
  cacheCredsMessagesEn,
  fetchMessagesEn,
  fetchSafetyBlockedEn,
  doctorMessagesEn,
] as const

describe('统一 text(key, locale)', () => {
  it('错误处置册键双语可查', () => {
    expect(text('webstack.error.transport', 'zh')).toContain('网络连接失败')
    expect(text('webstack.error.transport', 'en')).toContain('Network connection failed')
  })

  it('引擎状态册键双语可查', () => {
    expect(text('webstack.engine.ddg.degraded', 'zh')).toContain('DuckDuckGo')
    expect(text('webstack.engine.ddg.degraded', 'en')).toContain('DuckDuckGo')
  })

  it('缓存凭据册键双语可查', () => {
    expect(text('webstack.cache.cleared', 'zh')).toContain('缓存已清空')
    expect(text('webstack.cache.cleared', 'en')).toContain('cache cleared')
  })

  it('抓取安全册键（状态前缀 + SSRF 拒绝）双语可查', () => {
    expect(text('webstack.fetch.status-prefix', 'zh')).toContain('[HTTP %s]')
    expect(text('webstack.safety.blocked.scheme', 'en')).toContain('not allowed')
  })

  it('诊断册键双语可查', () => {
    expect(text('webstack.doctor.header', 'zh')).toContain('体检报告')
    expect(text('webstack.doctor.header', 'en')).toContain('doctor report')
  })

  it('未知 locale 回落中文；未知 key 返回键本身（绝不伪造文案）', () => {
    expect(text('webstack.doctor.header', 'fr' as never)).toBe(
      text('webstack.doctor.header', 'zh'),
    )
    expect(text('webstack.not.a.real.key' as never, 'zh')).toBe('webstack.not.a.real.key')
  })
})

describe('errorText 兼容入口', () => {
  it('与 ENGINE_ERROR_CODES 全码对齐且委托同一文案', () => {
    for (const code of ['transport', 'ssrf-blocked', 'rate-limited'] as const) {
      expect(errorText(code, 'zh')).toBe(text(`webstack.error.${code}`, 'zh'))
      expect(errorText(code, 'en')).toBe(text(`webstack.error.${code}`, 'en'))
    }
  })
})

describe('分册合并完整性', () => {
  it('zh 键集与 en 键集逐册奇偶一致', () => {
    for (let i = 0; i < BOOKS_ZH.length; i++) {
      const zhKeys = Object.keys(BOOKS_ZH[i] ?? {}).toSorted()
      const enKeys = Object.keys(BOOKS_EN[i] ?? {}).toSorted()
      expect(zhKeys).toEqual(enKeys)
    }
  })

  it('无跨册键冲突：各册键数之和等于并集大小', () => {
    const all = BOOKS_ZH.flatMap(book => Object.keys(book))
    expect(new Set(all).size).toBe(all.length)
  })
})
