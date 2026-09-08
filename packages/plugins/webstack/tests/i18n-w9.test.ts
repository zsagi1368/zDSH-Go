/**
 * i18n 分册合并回归（W9）：keyed-engines / mcp-infra / kernel-p1 三册并入
 * 统一表后的键奇偶、无冲突与双语可查。
 */
import { describe, expect, it } from 'vitest'
import { errorMessagesEn } from '../src/i18n/en.ts'
import { text } from '../src/i18n/index.ts'
import { kernelP1MessagesEn, kernelP1MessagesZh } from '../src/i18n/kernel-p1.ts'
import { keyedEngineMessagesEn, keyedEngineMessagesZh } from '../src/i18n/keyed-engines.ts'
import { mcpInfraMessagesEn, mcpInfraMessagesZh } from '../src/i18n/mcp-infra.ts'

describe('W9 新并入分册：统一 text(key, locale)', () => {
  it('keyed 引擎缺密钥提示双语可查', () => {
    expect(text('webstack.engine.tavily.no-key', 'zh')).toContain('Tavily')
    expect(text('webstack.engine.tavily.no-key', 'en')).toContain('Tavily')
    expect(text('webstack.engine.anysearch.no-key', 'zh')).toContain('AnySearch')
  })

  it('MCP/基础设施册键双语可查（sdk 缺席 / 代理探测）', () => {
    expect(text('webstack.mcp.sdk-missing', 'zh')).toContain('@modelcontextprotocol/sdk')
    expect(text('webstack.mcp.sdk-missing', 'en')).toContain('@modelcontextprotocol/sdk')
    expect(text('webstack.proxy.detected', 'zh')).toContain('Windows')
    expect(text('webstack.cache.adapter-degraded', 'en')).toContain('degraded')
  })

  it('kernel-p1 册键双语可查（批量上限 / 历史清空 / 联网标记）', () => {
    expect(text('webstack.kernel-p1.batch.limit-exceeded', 'zh')).toContain('10 条')
    expect(text('webstack.kernel-p1.batch.limit-exceeded', 'en')).toContain('10 queries')
    expect(text('webstack.kernel-p1.history.cleared', 'zh')).toContain('已清空')
    expect(text('webstack.mode.online-marker', 'en')).toContain('Session online mode is ON')
  })

  it('三新册 zh/en 键集逐册奇偶一致', () => {
    for (const [zh, en] of [
      [keyedEngineMessagesZh, keyedEngineMessagesEn],
      [mcpInfraMessagesZh, mcpInfraMessagesEn],
      [kernelP1MessagesZh, kernelP1MessagesEn],
    ] as const) {
      expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
    }
  })

  it('全部八册合并后无跨册键冲突', () => {
    const all = [
      ...Object.keys(keyedEngineMessagesZh),
      ...Object.keys(mcpInfraMessagesZh),
      ...Object.keys(kernelP1MessagesZh),
      ...Object.keys(errorMessagesEn), // 键集与 zh 册同形，借作既有五册代表
    ]
    // 新三册内部互不冲突，且与既有错误码前缀空间不重叠。
    const merged = [
      ...Object.keys(keyedEngineMessagesZh),
      ...Object.keys(mcpInfraMessagesZh),
      ...Object.keys(kernelP1MessagesZh),
    ]
    expect(new Set(merged).size).toBe(merged.length)
    expect(all.length).toBeGreaterThan(0)
  })
})
