/**
 * 错误分类学完整性（W-B-40）：映射表必须覆盖闭集全部错误码、三分类合法、
 * zh/en 文案键集奇偶一致。新增错误码而漏掉任何一侧会在这里直接红。
 */
import { describe, expect, it } from 'vitest'
import { errorMessagesEn } from '../src/i18n/en.ts'
import { errorText } from '../src/i18n/index.ts'
import { errorMessagesZh } from '../src/i18n/zh.ts'
import { EngineError, engineError, errorClass, isEngineError } from '../src/kernel/errors.ts'
import { ENGINE_ERROR_CODES, ERROR_CLASSIFICATION, type ErrorClass } from '../src/kernel/types.ts'

const VALID_CLASSES: readonly ErrorClass[] = ['retryable', 'non-retryable', 'terminal']

describe('ERROR_CLASSIFICATION 映射表完整性', () => {
  it('每个闭集错误码恰好有一个合法的三分类', () => {
    expect(ENGINE_ERROR_CODES.length).toBe(10)
    for (const code of ENGINE_ERROR_CODES) {
      const mapped = ERROR_CLASSIFICATION[code]
      expect(VALID_CLASSES, `classification for "${code}" must exist`).toContain(mapped)
    }
    expect(Object.keys(ERROR_CLASSIFICATION).sort()).toEqual([...ENGINE_ERROR_CODES].sort())
  })

  it('安全拒绝与取消是 terminal，瞬时故障是 retryable（分类学语义锚点）', () => {
    expect(errorClass('ssrf-blocked')).toBe('terminal')
    expect(errorClass('aborted')).toBe('terminal')
    expect(errorClass('transport')).toBe('retryable')
    expect(errorClass('rate-limited')).toBe('retryable')
    expect(errorClass('auth')).toBe('non-retryable')
    expect(errorClass('quota')).toBe('non-retryable')
  })
})

describe('EngineError 运行时形状', () => {
  it('工厂构造 + 守卫识别 + extras 条件赋值', () => {
    const err = engineError('rate-limited', 'upstream told us to slow down', {
      engineId: 'ddg',
      httpStatus: 429,
      retryAfterMs: 1500,
    })
    expect(isEngineError(err)).toBe(true)
    expect(err.name).toBe('EngineError')
    expect(err.code).toBe('rate-limited')
    expect(err.engineId).toBe('ddg')
    expect(err.retryAfterMs).toBe(1500)
    const bare = engineError('transport', 'boom')
    expect(bare.engineId).toBeUndefined()
    expect(isEngineError(new Error('plain'))).toBe(false)
    expect(isEngineError('string')).toBe(false)
    void EngineError
  })
})

describe('双语处置文案奇偶一致（W-B-79）', () => {
  it('zh/en 键集与错误码闭集完全一致且非空', () => {
    const expected = ENGINE_ERROR_CODES.map(code => `webstack.error.${code}`)
    expect(Object.keys(errorMessagesZh).sort()).toEqual([...expected].sort())
    expect(Object.keys(errorMessagesEn).sort()).toEqual([...expected].sort())
    for (const key of expected) {
      expect(errorMessagesZh[key as keyof typeof errorMessagesZh].length).toBeGreaterThan(0)
      expect(errorMessagesEn[key as keyof typeof errorMessagesEn].length).toBeGreaterThan(0)
    }
    expect(errorText('ssrf-blocked', 'en')).toBe(errorMessagesEn['webstack.error.ssrf-blocked'])
    expect(errorText('ssrf-blocked')).toBe(errorMessagesZh['webstack.error.ssrf-blocked'])
  })
})
