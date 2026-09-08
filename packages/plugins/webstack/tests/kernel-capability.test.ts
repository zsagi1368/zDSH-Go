/** 能力探测与降级梯真值表（F-013 三档各有断言）。 */
import { describe, expect, it } from 'vitest'
import { deriveTierMode, emptyBitmap, probeCapabilities } from '../src/kernel/capability.ts'

describe('probeCapabilities', () => {
  it('非对象输入安全得全 false 位图', () => {
    expect(probeCapabilities(undefined)).toEqual(emptyBitmap())
    expect(probeCapabilities(null)).toEqual(emptyBitmap())
    expect(probeCapabilities(42)).toEqual(emptyBitmap())
  })

  it('webSeam 要求两个注册方法同时存在', () => {
    const half = probeCapabilities({
      web: { registerSearchProvider: () => {} },
    })
    expect(half.webSeam).toBe(false)
    const full = probeCapabilities({
      web: {
        registerSearchProvider: () => {},
        registerFetchProvider: () => {},
      },
      settings: {},
      credentials: {},
      storage: {},
    })
    expect(full.webSeam).toBe(true)
    expect(full.settingsSection).toBe(true)
    expect(full.credentialsDomain).toBe(true)
    expect(full.storageService).toBe(true)
    expect(full.selectorPatchable).toBe(false) // 运行期回读验证属 W2-PLATFORM
  })
})

describe('deriveTierMode 真值表', () => {
  it('接管/共存/诊断三档判定', () => {
    expect(
      deriveTierMode({
        ...emptyBitmap(),
        webSeam: true,
        selectorPatchable: true,
      }),
    ).toBe('takeover')
    expect(deriveTierMode({ ...emptyBitmap(), webSeam: true })).toBe('coexist')
    expect(deriveTierMode(emptyBitmap())).toBe('diagnostic')
  })
})
