import { describe, expect, it } from 'vitest'
import { isSensitiveValue, redactRecord, redactValue } from '../../src/shared/redact.js'

describe('redaction', () => {
  it('masks sensitive keys regardless of value', () => {
    expect(redactValue('api_key', 'abc')).toBe('[redacted]')
    expect(redactValue('Authorization', 'Bearer x')).toBe('[redacted]')
    expect(redactValue('GH_TOKEN', 'ghp_shortvalue')).toBe('[redacted]')
  })

  it('masks secret-shaped values under innocent keys', () => {
    expect(isSensitiveValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart')).toBe(true)
    expect(redactValue('note', 'a'.repeat(40))).toBe('[redacted]') // long hex
    expect(redactValue('note', 'plain sentence')).toBe('plain sentence')
  })

  it('keeps normal fields', () => {
    const out = redactRecord({ action: 'install', planId: 'abc-install', attempt: 2 })
    expect(out).toEqual({ action: 'install', planId: 'abc-install', attempt: 2 })
  })

  it('recurses into nested objects and masks inside them', () => {
    const out = redactRecord({
      env: { GITHUB_TOKEN: 'x', PATH: '/bin' },
      detail: { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart' },
    })
    expect((out.env as Record<string, unknown>).GITHUB_TOKEN).toBe('[redacted]')
    expect((out.env as Record<string, unknown>).PATH).toBe('/bin')
    expect((out.detail as Record<string, unknown>).jwt).toBe('[redacted]')
  })
})
