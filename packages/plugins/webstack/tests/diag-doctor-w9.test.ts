/**
 * W9 诊断面回归：doctor 报告加法式增补（桥接在线/离线、垂类三态）与
 * statusSection extras 短句（词数预算内）。
 */
import { describe, expect, it } from 'vitest'
import { SearchCache } from '../src/cache/store.ts'
import { type DoctorDeps, renderDoctor, runDoctor } from '../src/diag/doctor.ts'
import { EngineRegistry } from '../src/kernel/registry.ts'
import { countWords, statusSection } from '../src/prompt/sections.ts'

function deps(overrides?: Partial<DoctorDeps>): DoctorDeps {
  return {
    bitmap: {
      webSeam: true,
      selectorPatchable: false,
      settingsSection: true,
      inputSlot: false,
      credentialsDomain: false,
      storageService: false,
      bridgeOnline: false,
    },
    tier: 'coexist',
    registry: new EngineRegistry(),
    cache: new SearchCache(),
    ...overrides,
  }
}

describe('runDoctor W9 增补', () => {
  it('bridgeOnline=true → report.bridge=online；false → offline', () => {
    expect(runDoctor(deps({ bridgeOnline: true })).bridge).toBe('online')
    expect(runDoctor(deps({ bridgeOnline: false })).bridge).toBe('offline')
  })

  it('vertical 三态透传；缺席字段保持缺席（报告向后兼容）', () => {
    const base = runDoctor(deps())
    expect(base.bridge).toBeUndefined()
    expect(base.vertical).toBeUndefined()
    expect(runDoctor(deps({ vertical: 'on' })).vertical).toBe('on')
    expect(runDoctor(deps({ vertical: 'off' })).vertical).toBe('off')
    expect(runDoctor(deps({ vertical: 'pack-missing' })).vertical).toBe('pack-missing')
  })

  it('render：桥接与垂类状态行按 locale 渲染；缺席不输出', () => {
    const withBoth = renderDoctor(runDoctor(deps({ bridgeOnline: true, vertical: 'on' })), 'zh')
    expect(withBoth).toContain('桥接卫星：在线')
    expect(withBoth).toContain('垂直频道（X）：已开启')

    const missing = renderDoctor(runDoctor(deps({ vertical: 'pack-missing' })), 'en')
    expect(missing).toContain('dsh-webstack-verticals is missing')
    expect(missing).not.toContain('bridge satellite') // 未上报桥 → 不渲染该行

    const plain = renderDoctor(runDoctor(deps()), 'zh')
    expect(plain).not.toContain('桥接卫星')
    expect(plain).not.toContain('垂直频道')
  })

  it('W10 UX：桥接离线文案给出配对处置动作（zh/en 双语）', () => {
    const zh = renderDoctor(runDoctor(deps({ bridgeOnline: false })), 'zh')
    expect(zh).toContain('桥接卫星：离线/未配对')
    expect(zh).toContain('弹窗完成配对') // 处方可操作性：怎么修

    const en = renderDoctor(runDoctor(deps({ bridgeOnline: false })), 'en')
    expect(en).toContain('offline/unpaired')
    expect(en).toContain('to complete pairing')
  })
})

describe('W10 UX 回归：全冷却聚合处方', () => {
  it('全部引擎 cooldown → 渲染 all-cooldown 处方（zh/en）；混合态不渲染', () => {
    const allCooldownReport = {
      tier: 'coexist' as const,
      engines: [
        { id: 'ddg', state: 'cooldown' as const, cooldownRemainingMs: 30_000 },
        { id: 'bing-lite', state: 'cooldown' as const, cooldownRemainingMs: 61_000 },
      ],
      cache: { hits: 0, misses: 2, size: 0 },
    }
    const zh = renderDoctor(allCooldownReport, 'zh')
    expect(zh).toContain('[冷却] ddg')
    expect(zh).toContain('全部引擎处于冷却') // 聚合处方：等待+检查凭据/出口
    expect(zh).toContain('等待上方倒计时自动恢复')

    const en = renderDoctor(allCooldownReport, 'en')
    expect(en).toContain('All engines are cooling down')

    const mixed = renderDoctor(
      {
        ...allCooldownReport,
        engines: [
          { id: 'ddg', state: 'cooldown' as const, cooldownRemainingMs: 30_000 },
          { id: 'searxng', state: 'ok' as const },
        ],
      },
      'zh',
    )
    expect(mixed).toContain('[正常] searxng')
    expect(mixed).not.toContain('全部引擎处于冷却')
  })

  it('空引擎清单与 ok 态清单不触发全冷却处方', () => {
    const empty = renderDoctor(
      { tier: 'coexist', engines: [], cache: { hits: 0, misses: 0, size: 0 } },
      'zh',
    )
    expect(empty).not.toContain('全部引擎处于冷却')
    const ok = renderDoctor(
      {
        tier: 'takeover',
        engines: [{ id: 'ddg', state: 'ok' }],
        cache: { hits: 1, misses: 0, size: 1 },
      },
      'zh',
    )
    expect(ok).not.toContain('全部引擎处于冷却')
  })
})

describe('statusSection W9 extras', () => {
  it('extras 追加桥/垂类短句且仍守 ≤80 词预算', () => {
    const section = statusSection({ ddg: { state: 'ok' } }, 'zh', {
      bridgeOnline: true,
      verticalEnabled: true,
    })
    expect(section.text).toContain('桥接在线')
    expect(section.text).toContain('X垂类开')
    expect(countWords(section.text)).toBeLessThanOrEqual(80)
  })

  it('extras 缺席时行为与旧版一致（无短句、无词数膨胀）', () => {
    const legacy = statusSection({ ddg: { state: 'ok' } }, 'zh')
    const modern = statusSection({ ddg: { state: 'ok' } }, 'zh', {})
    expect(modern.text).toBe(legacy.text)
  })
})
