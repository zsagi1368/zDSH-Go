/**
 * Tests for the cordis adapter shell (bundle-direct mounting path, zDSH-go).
 *
 * The registry contract under test: the module namespace must satisfy
 * `typeof plugin === 'function' || typeof plugin.apply === 'function'`
 * (vendor/cordis/src/registry.ts) after the loader's unwrapExports, which
 * returns `exports.default ?? exports`.
 */
import { describe, expect, it, vi } from 'vitest'
import * as ns from '../src/cordis-adapter.ts'
import { apply, inject, mountedFor, name } from '../src/cordis-adapter.ts'

/** Mimic vendor/loader unwrapExports (no __esModule interop for ESM). */
function unwrap(exports: Record<string, unknown>): unknown {
  return exports.default ?? exports
}

describe('cordis adapter shell', () => {
  it('satisfies the registry plugin contract after unwrapExports', () => {
    const unwrapped = unwrap(ns as unknown as Record<string, unknown>)
    expect(typeof unwrapped === 'function' || typeof (unwrapped as { apply?: unknown }).apply === 'function').toBe(true)
  })

  it('exposes name/inject per the third-party bundle contract', () => {
    expect(name).toBe('dsh-omnivision')
    expect(inject).toEqual([])
  })

  it('apply mounts a runtime and logs readiness', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const plugin = apply({ logger }, { mode: 'interactive' })
    expect(plugin).toBeDefined()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[omnivision] ready (mode=interactive'),
    )
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('apply merges partial config over DEFAULT_CONFIG', () => {
    const logger = { info: vi.fn(), warn: vi.fn() }
    const plugin = apply({ logger }, { language: 'en' })
    const record = plugin.stats()
    expect(record.providers).toBeGreaterThan(0) // free fallback chain always present
  })

  it('registers disposal via the host effect seam when present', () => {
    const effect = vi.fn()
    apply({ effect })
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'omnivision-dispose')
    const teardown = effect.mock.calls[0]?.[0] as () => void
    expect(() => teardown()).not.toThrow()
  })

  it('mountedFor exposes the mount record per context', () => {
    const ctx = {}
    expect(mountedFor(ctx)).toBeUndefined()
    apply(ctx)
    const record = mountedFor(ctx)
    expect(record?.workspace).toBe(process.cwd())
    expect(record?.config.mode).toBe('auto')
  })
})
