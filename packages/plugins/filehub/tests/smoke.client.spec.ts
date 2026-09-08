import { describe, expect, it } from 'vitest'
import { apply, filehubConfigDefaults, inject } from '../src/index.js'
import { ListResultSchema, UploadResultSchema } from '../src/contract.js'

describe('M0 scaffold', () => {
  it('exposes an apply entry with declared host injections', () => {
    expect(typeof apply).toBe('function')
    expect(inject).toContain('fs')
    expect(inject).toContain('webServer')
  })

  it('logs readiness through the structural host seam', () => {
    const lines: string[] = []
    apply({ logger: { info: message => lines.push(message) } })
    expect(lines[0]).toContain('[filehub]')
    expect(lines[0]).toContain(filehubConfigDefaults.storageDirName)
  })

  it('merges partial config over safe defaults', () => {
    const lines: string[] = []
    apply({ logger: { info: message => lines.push(message) } }, { storageDirName: '.custom' })
    expect(lines[0]).toContain('.custom')
  })

  it('contract schemas round-trip a minimal upload result', () => {
    const parsed = UploadResultSchema.parse({
      path: '/w/.filehub/s1/a.png',
      relativePath: 'a.png',
      sniffedType: 'image/png',
      label: 'a.png',
    })
    expect(parsed.sniffedType).toBe('image/png')
    expect(() =>
      ListResultSchema.parse({ sessionId: '', entries: [], truncated: false }),
    ).toThrow()
  })
})
