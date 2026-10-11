/**
 * Isolated lock for the cordis `cannot import` catch branch (DEBT §7).
 *
 * Kept in its own file on purpose: the guard resolves `@deepseek-ai/cordis`
 * through a dynamic import whose resolution Vite caches per module registry,
 * so a throwing mock only takes effect in a file that never resolved the real
 * module through that path first (vitest 4.1.11 keeps the cached instance even
 * across `vi.resetModules()` inside one file). This file therefore avoids
 * importing cordis statically and runs no other guard calls before the mock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import { guardModelSlots } from '../src/compat.ts'

const CORDIS_MODULE = '@deepseek-ai/cordis'

function recordingLogger(sink: string[]): CompatLogger {
  return { warn: (message: string) => { sink.push(message) } }
}

afterEach(() => {
  vi.doUnmock(CORDIS_MODULE)
  vi.resetModules()
})

describe('guardModelSlots cordis catch branch (DEBT §7)', () => {
  it('fail-softs with the literal reason when the cordis import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-model-slots disabled')
    expect(warnings[0]).toContain('cordis:Service')

    const entry = getCompatRoster().get('dsh-model-slots')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import cordis Service')).toBe(true)
  })
})
