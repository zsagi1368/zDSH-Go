/** 窄化层：不信任响应形状的第一道闸（asRecord + 四个通用收窄读取器）。 */
import { describe, expect, it } from 'vitest'
import {
  asRecord,
  narrowArray,
  narrowRecord,
  narrowString,
  parseJsonLoose,
} from '../src/fetch/narrowing.ts'

describe('asRecord', () => {
  it('普通对象放行；数组/空值/标量拒绝', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord([])).toBeUndefined()
    expect(asRecord(null)).toBeUndefined()
    expect(asRecord(undefined)).toBeUndefined()
    expect(asRecord('text')).toBeUndefined()
    expect(asRecord(42)).toBeUndefined()
  })
})

describe('parseJsonLoose（宽松 JSON 解析）', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['[1,2,3]', [1, 2, 3]],
    ['"text"', 'text'],
    ['42', 42],
    ['null', null],
  ])('合法 JSON %j → ok:true 且 value 原样', (text, value) => {
    expect(parseJsonLoose(text)).toEqual({ ok: true, value })
  })

  it.each([
    ['{"a":', '截断对象'],
    ['', '空串'],
    ['not json', '纯文本'],
    ["{'a':1}", '单引号键'],
  ])('非法 JSON（%s）→ ok:false 且 reason 为字符串', (text) => {
    const parsed = parseJsonLoose(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(typeof parsed.reason).toBe('string')
  })
})

describe('narrowString（非空字符串守卫）', () => {
  it.each([
    ['hello', 'hello'],
    [' ', ' '], // 空白串仍是 string：只挡空串，不越权裁剪
  ])('%j → 原样放行', (input, expected) => {
    expect(narrowString(input)).toBe(expected)
  })

  it.each([
    ['' as unknown, '空串'],
    [42 as unknown, '数字'],
    [null as unknown, 'null'],
    [undefined as unknown, 'undefined'],
    [{ v: 'x' } as unknown, '对象'],
  ])('%s → undefined', (input) => {
    expect(narrowString(input)).toBeUndefined()
  })
})

describe('narrowArray（只读数组守卫）', () => {
  it('真数组放行且元素保持 unknown', () => {
    expect(narrowArray([1, 'a', null])).toEqual([1, 'a', null])
    expect(narrowArray([])).toEqual([])
  })

  it.each([
    ['[1,2]' as unknown, 'JSON 字符串形态'],
    [null as unknown, 'null'],
    [undefined as unknown, 'undefined'],
    [{ 0: 'a', length: 1 } as unknown, '伪数组对象'],
  ])('%s → 空数组（可安全迭代）', (input) => {
    expect(narrowArray(input)).toEqual([])
  })
})

describe('narrowRecord（只读记录守卫）', () => {
  it('普通对象放行为只读视图；数组与标量拒绝', () => {
    expect(narrowRecord({ a: 1 })).toEqual({ a: 1 })
    expect(narrowRecord([])).toBeUndefined()
    expect(narrowRecord(null)).toBeUndefined()
    expect(narrowRecord(undefined)).toBeUndefined()
    expect(narrowRecord('rec')).toBeUndefined()
    expect(narrowRecord(0)).toBeUndefined()
  })
})
