/** 凭据三级解析链：优先级矩阵 / 占位符拦截 / 掩码与指纹（W-B-54/55/74）。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CREDS_SOURCE_ORDER,
  credFingerprint,
  envVarName,
  isPlaceholderSecret,
  maskSecret,
  opaqueIdOf,
  PLACEHOLDER_PATTERNS,
  resolveCreds,
} from '../src/creds/resolve.ts'
import type { CredsSnapshot, SeamCredentialsRuntime } from '../src/kernel/types.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** credentials seam 桩：ref → 固定密钥，并记录调用次数。 */
function makeSeam(secret = 'seam-resolved-secret'): SeamCredentialsRuntime & { calls: number } {
  return {
    calls: 0,
    async resolve(ref) {
      this.calls++
      return ref === 'known-ref' ? secret : undefined
    },
  }
}

describe('解析链词汇', () => {
  it('优先级冻结：遗留字面 → credentialRef → env', () => {
    expect([...CREDS_SOURCE_ORDER]).toEqual(['legacy-literal', 'credential-ref', 'env'])
    expect(PLACEHOLDER_PATTERNS.length).toBeGreaterThan(0)
  })

  it('env 变量名映射：bing-lite → WEBSTACK_BING_LITE_API_KEY', () => {
    expect(envVarName('bing-lite')).toBe('WEBSTACK_BING_LITE_API_KEY')
    expect(envVarName('SearXNG')).toBe('WEBSTACK_SEARXNG_API_KEY')
  })
})

describe('resolveCreds · 三级优先级矩阵', () => {
  const matrix: readonly {
    readonly name: string
    readonly config?: string
    readonly ref?: string
    readonly withSeam?: boolean
    readonly env?: string
    readonly expectedSource: 'legacy-literal' | 'credential-ref' | 'env' | undefined
  }[] = [
    {
      name: '三级齐备 → legacy-literal 胜出',
      config: 'cfg-key-01',
      ref: 'known-ref',
      withSeam: true,
      env: 'env-key-01',
      expectedSource: 'legacy-literal',
    },
    {
      name: '字面缺席 → credential-ref 次之',
      ref: 'known-ref',
      withSeam: true,
      env: 'env-key-02',
      expectedSource: 'credential-ref',
    },
    { name: '仅 env → 兜底生效', env: 'env-key-03', expectedSource: 'env' },
    { name: '全缺席 → absent 无 source', expectedSource: undefined },
  ]

  for (const c of matrix) {
    it(c.name, async () => {
      if (c.env !== undefined) vi.stubEnv('WEBSTACK_TESTER_API_KEY', c.env)
      const snapshot = await resolveCreds(['tester'], {
        configValues: c.config === undefined ? {} : { tester: c.config },
        credentialsRef: c.ref === undefined ? {} : { tester: c.ref },
        seams: c.withSeam === true ? { credentials: makeSeam() } : {},
      })
      const entry = snapshot.entries.tester!
      if (c.expectedSource === undefined) {
        expect(entry.state).toBe('absent')
        expect(entry.source).toBeUndefined()
      } else {
        expect(entry.state).toBe('configured')
        expect(entry.source).toBe(c.expectedSource)
      }
    })
  }

  it('credentials 服务缺席时跳级到 env（降级梯）', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-fallback-key')
    const snapshot = await resolveCreds(['tester'], {
      configValues: {},
      credentialsRef: { tester: 'known-ref' },
    })
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'env',
    })
  })

  it('seam 在但 resolve 返回空 → 继续下探到 env', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'env-after-empty-seam')
    const snapshot = await resolveCreds(['tester'], {
      credentialsRef: { tester: 'unknown-ref' },
      seams: { credentials: makeSeam() },
    })
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'env',
    })
  })
})

describe('resolveCreds · 占位符拦截', () => {
  it('配置占位符视为 absent 并发出 webstack.creds.placeholder-detected 告警键', async () => {
    const warnings: [string, string][] = []
    const snapshot = await resolveCreds(['tester'], {
      configValues: { tester: '<your-api-key>' },
      onWarning: (engineId, key) => warnings.push([engineId, key]),
    })
    expect(snapshot.entries.tester!.state).toBe('absent')
    expect(warnings).toEqual([['tester', 'webstack.creds.placeholder-detected']])
  })

  it('占位符不阻断下探：字面为占位符而 env 有真值 → env 生效', async () => {
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', 'real-env-key-99')
    const snapshot = await resolveCreds(['tester'], {
      configValues: { tester: 'YOUR_API_KEY' },
    })
    expect(snapshot.entries.tester).toMatchObject({
      state: 'configured',
      source: 'env',
    })
  })

  it('isPlaceholderSecret 覆盖黑名单正则与尖括号包裹；真密钥不误伤', () => {
    for (const bad of [
      '<your-key>',
      '<anything-here>',
      'your-api-key-here',
      'sk-xxxxxxxxxxxxxxxx',
      'placeholder-value',
      'changeme',
    ]) {
      expect(isPlaceholderSecret(bad), bad).toBe(true)
    }
    for (const good of ['sk-real-9f8e7d6c5b4a3210', 'AIzaSyD-1234567890abcdef', 'k']) {
      expect(isPlaceholderSecret(good), good).toBe(false)
    }
  })
})

describe('掩码与 opaque id（明文不出快照）', () => {
  it('长度 > 8：前 3 + … + 尾 4；长度 ≤ 8：等长星号', () => {
    expect(maskSecret('abcdefghijkl')).toBe('abc…ijkl')
    expect(maskSecret('12345678')).toBe('********')
    expect(maskSecret('k')).toBe('*')
  })

  it('opaqueId 稳定可对比、不同密钥不同 id', () => {
    expect(opaqueIdOf('same-secret')).toBe(opaqueIdOf('same-secret'))
    expect(opaqueIdOf('secret-A')).not.toBe(opaqueIdOf('secret-B'))
    expect(opaqueIdOf('x')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('快照序列化后不含明文片段', async () => {
    const secret = 'super-plain-secret-42'
    vi.stubEnv('WEBSTACK_TESTER_API_KEY', secret)
    const snapshot = await resolveCreds(['tester'])
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(snapshot.entries.tester!.maskedHint).toBe(maskSecret(secret))
  })
})

describe('credFingerprint', () => {
  const build = async (
    secrets: Readonly<Record<string, string | undefined>>,
  ): Promise<CredsSnapshot> => resolveCreds(Object.keys(secrets), { configValues: secrets })

  it('无任何凭据 → none', async () => {
    const fp = credFingerprint(await build({ a: undefined }))
    expect(fp).toBe('none')
    const empty: CredsSnapshot = { resolvedAt: 0, entries: {} }
    expect(credFingerprint(empty)).toBe('none')
  })

  it('凭据轮换即变指纹；引擎枚举顺序不影响取值', async () => {
    const before = credFingerprint(await build({ ddg: 'key-ddg-1', bing: 'key-bing-1' }))
    const afterRotation = credFingerprint(await build({ ddg: 'key-ddg-2', bing: 'key-bing-1' }))
    expect(afterRotation).not.toBe(before)

    const reversed = await resolveCreds(['bing', 'ddg'], {
      configValues: { ddg: 'key-ddg-1', bing: 'key-bing-1' },
    })
    expect(credFingerprint(reversed)).toBe(before)
  })
})
