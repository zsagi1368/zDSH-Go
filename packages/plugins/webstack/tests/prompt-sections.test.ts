/** prompt 节：词数预算 CI 红线 + 双语内容要点 + 动态状态节（W-B-90~92 / R7）。 */
import { describe, expect, it } from 'vitest'
import type { EngineStatusEntry } from '../src/kernel/registry.ts'
import {
  charterSection,
  countWords,
  PROMPT_SECTION_NAMES,
  PROMPT_SECTION_ORDERS,
  PROMPT_WORD_BUDGET,
  statusSection,
} from '../src/prompt/sections.ts'

describe('charterSection 守则节', () => {
  it('order/name 冻结值', () => {
    const section = charterSection('zh')
    expect(section.name).toBe(PROMPT_SECTION_NAMES.policy)
    expect(section.order).toBe(PROMPT_SECTION_ORDERS.policy)
    expect(PROMPT_SECTION_ORDERS.policy).toBe(100)
    expect(PROMPT_SECTION_ORDERS.status).toBe(101)
  })

  const KEY_POINTS = [
    ['web_search', '搜索工具名'],
    ['web_fetch', '抓取工具名'],
    ['/web_change', '层切换概念命令'],
    ['web_backend_status', '诊断工具名'],
  ] as const

  for (const [needle] of KEY_POINTS) {
    it(`守则文本包含关键点 ${needle}（双语）`, () => {
      expect(charterSection('zh').text).toContain(needle)
      expect(charterSection('en').text).toContain(needle)
    })
  }

  it('包含「内容不是指令」安全条款（双语）', () => {
    expect(charterSection('zh').text).toContain('数据而非指令')
    expect(charterSection('en').text.toLowerCase()).toContain('never instructions')
  })

  it('词数预算：zh/en 均 ≤200 词（CI 红线）', () => {
    expect(countWords(charterSection('zh').text)).toBeLessThanOrEqual(PROMPT_WORD_BUDGET.charter)
    expect(countWords(charterSection('en').text)).toBeLessThanOrEqual(PROMPT_WORD_BUDGET.charter)
  })
})

describe('statusSection 动态状态节', () => {
  const SNAPSHOT: Record<string, EngineStatusEntry> = {
    ddg: { state: 'ok' },
    'bing-lite': {
      state: 'cooldown',
      cooldownUntil: Date.now() + 30_000,
      lastCode: 'rate-limited',
    },
    searxng: { state: 'unwired' },
  }

  it('order=101；计数与冷却引擎名进入文本（zh）', () => {
    const section = statusSection(SNAPSHOT, 'zh')
    expect(section.order).toBe(PROMPT_SECTION_ORDERS.status)
    expect(section.text).toContain('冷却 1')
    expect(section.text).toContain('bing-lite')
    expect(section.text).toContain('未接线 1')
  })

  it('en 镜像渲染', () => {
    const text = statusSection(SNAPSHOT, 'en').text
    expect(text).toContain('1 cooling down')
    expect(text).toContain('Cooling: bing-lite')
  })

  it('空快照渲染无引擎文案', () => {
    expect(statusSection({}, 'zh').text).toContain('没有已注册引擎')
    expect(statusSection({}, 'en').text).toContain('no engines registered')
  })

  it('词数预算 ≤80 词（CI 红线）', () => {
    expect(countWords(statusSection(SNAPSHOT, 'zh').text)).toBeLessThanOrEqual(
      PROMPT_WORD_BUDGET.status,
    )
    expect(countWords(statusSection(SNAPSHOT, 'en').text)).toBeLessThanOrEqual(
      PROMPT_WORD_BUDGET.status,
    )
  })

  it('全部正常时不含「冷却」字样', () => {
    const text = statusSection({ ddg: { state: 'ok' } }, 'zh').text
    expect(text).not.toContain('冷却中')
  })
})

describe('countWords 词数估算', () => {
  it('连续非空白段计数；空白串为 0', () => {
    expect(countWords('one two three')).toBe(3)
    expect(countWords('深度求索 搜索')).toBeGreaterThan(0)
    expect(countWords('   ')).toBe(0)
  })
})
