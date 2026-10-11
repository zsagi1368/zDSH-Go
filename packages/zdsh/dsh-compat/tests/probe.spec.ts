import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memberOf, probeSymbol, versionOf } from '../src/probe.ts'

describe('probeSymbol', () => {
  it('reports present for a real exported symbol', async () => {
    const result = await probeSymbol('node:fs', 'readFile')
    expect(result.present).toBe(true)
    expect(typeof result.value).toBe('function')
    expect(result.reason).toBeUndefined()
  })

  it('keeps the value when the shape check passes', async () => {
    const result = await probeSymbol(
      'node:fs', 'readFile',
      (v: unknown) => typeof v === 'function',
    )
    expect(result.present).toBe(true)
    expect(typeof result.value).toBe('function')
  })

  it('classifies an unresolvable specifier as module-not-found', async () => {
    const result = await probeSymbol('__definitely_not_a_real_module__', 'whatever')
    expect(result.present).toBe(false)
    expect(result.reason).toBe('module-not-found')
    expect(result.value).toBeUndefined()
  })

  it('classifies a missing export as symbol-missing', async () => {
    const result = await probeSymbol('node:fs', '__definitely_not_a_real_export__')
    expect(result.present).toBe(false)
    expect(result.reason).toBe('symbol-missing')
    expect(result.value).toBeUndefined()
  })

  it('classifies a shape rejection as shape-mismatch', async () => {
    const result = await probeSymbol(
      'node:fs', 'readFile',
      (v: unknown) => typeof v !== 'function',
    )
    expect(result.present).toBe(false)
    expect(result.reason).toBe('shape-mismatch')
    expect(result.value).toBeUndefined()
  })

  it('classifies a throwing module evaluation as import-threw', async () => {
    const result = await probeSymbol('data:text/javascript,throw new Error("boom")', 'x')
    expect(result.present).toBe(false)
    expect(result.reason).toBe('import-threw')
    expect(result.error).toBeInstanceOf(Error)
  })

  it('handles a non-Error import rejection as import-threw', async () => {
    const result = await probeSymbol('data:text/javascript,throw "raw"', 'x')
    expect(result.present).toBe(false)
    expect(result.reason).toBe('import-threw')
    expect(typeof result.error).toBe('string')
  })

  it('classifies a coded module-resolution error by message fallback as module-not-found', async () => {
    const specifier = [
      'data:text/javascript,',
      'const e = new Error("Cannot find module ghost-pkg");',
      'e.code = "CUSTOM_CODE";',
      'throw e',
    ].join('')
    const result = await probeSymbol(specifier, 'x')
    expect(result.present).toBe(false)
    expect(result.reason).toBe('module-not-found')
  })
})

describe('memberOf', () => {
  it('returns the exported value when the symbol exists', () => {
    expect(memberOf({ answer: 42 }, 'answer')).toBe(42)
  })

  it('returns undefined when the symbol is missing', () => {
    expect(memberOf({ answer: 42 }, 'nope')).toBeUndefined()
  })
})

describe('versionOf', () => {
  it('reads the version of an installed package', async () => {
    const version = await versionOf('typescript')
    expect(version).toBeDefined()
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('returns undefined for an unresolvable package', async () => {
    expect(await versionOf('__definitely_not_a_real_package__')).toBeUndefined()
  })

  it('returns undefined when the resolved version field is not a string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-compat-probe-'))
    try {
      const pkg = join(dir, 'package.json')
      await writeFile(pkg, JSON.stringify({ name: 'fixture', version: 123 }))
      expect(await versionOf(dir)).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
