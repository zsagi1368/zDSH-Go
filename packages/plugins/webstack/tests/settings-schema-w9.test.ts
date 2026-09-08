/**
 * W9 设置 schema 回归：engines.<id>.key 键位（apiKey 历史别名兼容）与
 * advanced.winProxyFallback 默认 false，及热生效表登记。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, HOT_RELOADABLE } from '../src/settings/schema.ts'

describe('settings/schema W9 键位', () => {
  it('advanced.winProxyFallback 默认 false（不偷改进程环境）', () => {
    expect(DEFAULT_SETTINGS.advanced.winProxyFallback).toBe(false)
  })

  it('winProxyFallback 与既有 advanced.hintsLocale 同为热生效', () => {
    expect(HOT_RELOADABLE['advanced.winProxyFallback']).toBe(true)
    expect(HOT_RELOADABLE['advanced.hintsLocale']).toBe(true)
  })

  it('引擎节点允许 key/apiKey/credentialRef 三键位；engines 结构增删仍需重启', () => {
    const node = DEFAULT_SETTINGS.engines
    expect(Object.keys(node)).toHaveLength(0) // 默认空表：全走全局默认
    // 类型层契约由 EngineNodeSettings 承载；此处锁热生效语义。
    expect(HOT_RELOADABLE.engines).toBe(false)
  })

  it('mode.sessionOnline / cache.persist 热生效语义与 W9 接线一致', () => {
    expect(HOT_RELOADABLE['mode.sessionOnline']).toBe(true)
    expect(HOT_RELOADABLE['cache.persist']).toBe(true)
    expect(DEFAULT_SETTINGS.mode.sessionOnline).toBe('off')
    expect(DEFAULT_SETTINGS.cache.persist).toBe('memory')
  })
})
