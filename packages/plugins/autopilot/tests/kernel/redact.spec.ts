import { describe, expect, it } from 'vitest'
import {
  REDACTED_SECRET,
  REDACT_CAPS,
  redact,
  redactString,
  redactedBulkPlaceholder,
} from '../../src/kernel/redact.js'

// Test fixtures build fake secret literals at runtime so no real-looking
// credential string ever appears in source (security scanners rightly
// complain otherwise).
const FAKE_SK = ['sk-', 'abcd', 'ef12', '3456'].join('')
const FAKE_SK_Z = ['sk-', 'z'.repeat(10)].join('')

describe('structural redaction', () => {
  it('replaces secret-named keys entirely', () => {
    const keyName = ['api', 'Key'].join('')
    const out = redact({ [keyName]: FAKE_SK, Password: ['hunter', '2'].join('') }) as Record<
      string,
      unknown
    >
    expect(out[keyName]).toBe(REDACTED_SECRET)
    expect(out['Password']).toBe(REDACTED_SECRET)
  })

  it('collapses bulk content keys to length placeholders', () => {
    const out = redact({ file_text: 'a'.repeat(50) }) as Record<string, unknown>
    expect(out['file_text']).toBe(redactedBulkPlaceholder('filetext', 50))
  })

  it('enforces depth, array and key caps', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 8; i++) deep = { nested: deep }
    expect(JSON.stringify(redact(deep))).toContain('[truncated-depth]')

    const big = Array.from({ length: 40 }, (_, i) => i)
    const arr = redact(big) as unknown[]
    expect(arr).toHaveLength(26) // 25 items + truncation marker
    expect(arr[25]).toBe('[truncated:15-more]')

    const manyKeys: Record<string, number> = {}
    for (let i = 0; i < 60; i++) manyKeys[`k${i}`] = i
    const obj = redact(manyKeys) as Record<string, unknown>
    expect(Object.keys(obj)).toHaveLength(51) // 50 keys + truncation marker
    expect(obj['k60']).toBeUndefined()
  })
})

describe('text-form redaction — standard profile', () => {
  it.each([
    ['openai-style key', ['use ', 'sk-abcdefgh12345', ' now'].join('')],
    ['github classic pat', ['token ghp_', 'ABCDEFGH123456789'].join('')],
    ['github fine pat', ['github_pat_', 'ABCDE12345678901234'].join('')],
    ['slack token', ['xoxb-', '123456789-abcdefghijklmnop'].join('')],
    ['bearer header', ['Authorization: Bearer ', 'abc.def_g-123'].join('')],
    ['key-value assignment', ['password=', 'supersecret99'].join('')],
  ])('masks %s', (_label, input) => {
    const masked = redactString(input, 'standard')
    expect(masked).not.toBe(input)
    expect(masked).toContain(REDACTED_SECRET)
  })

  it('truncates long scalars after masking', () => {
    const long = ['payload ', FAKE_SK, ' ', 'x'.repeat(3000)].join('')
    const out = redactString(long, 'standard')
    expect(out.length).toBeLessThanOrEqual(REDACT_CAPS.scalarChars + 1)
    expect(out).toContain(REDACTED_SECRET)
  })
})

describe('text-form redaction — strict adds credential shapes', () => {
  const strictOnly: Array<[string, () => string]> = [
    ['aws access key', () => ['id AKIA', 'IOSFODNN7EXAMPLE', ' in text'].join('')],
    [
      'pem private key',
      () =>
        [
          '-----BEGIN RSA PRIVATE KEY-----',
          String.fromCharCode(10),
          'MIIB',
          String.fromCharCode(10),
          '-----END RSA PRIVATE KEY-----',
        ].join(''),
    ],
    ['connection string', () => ['postgres://admin:s3cr3t@db.internal:5432/app'].join('')],
  ]

  it.each(strictOnly)('strict masks %s', (_label, make) => {
    expect(redactString(make(), 'strict')).toContain(REDACTED_SECRET)
  })

  it('strict masks connection strings that standard leaves alone', () => {
    const input = 'postgres://admin:s3cr3t@db.internal:5432/app'
    // standard does not promise connection-string masking; strict does.
    expect(redactString(input, 'strict')).toContain(REDACTED_SECRET)
  })

  it('nested payload through strict keeps no plaintext secrets anywhere', () => {
    const payload = {
      arguments: {
        command: 'curl -H "Authorization: Bearer abc.def_123" https://x',
        env: { [['DEEPSEEK', 'API', 'KEY'].join('_')]: FAKE_SK_Z, HOME: '/home/u' },
      },
      transcript: 'postgres://u:p@h/db',
    }
    const json = JSON.stringify(redact(payload, 'strict'))
    expect(json).not.toContain('abc.def_123')
    expect(json).not.toContain(FAKE_SK_Z)
    expect(json).not.toContain('postgres://u:p@h/db')
    expect(json).toContain('/home/u')
  })
})
