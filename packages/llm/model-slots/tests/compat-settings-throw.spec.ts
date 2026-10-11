/**
 * Isolated lock for the settings `cannot import` catch branch (DEBT §7).
 *
 * Same rationale as compat-cordis-throw.spec.ts: the throwing mock needs a
 * module registry that never resolved the real module through the guard's
 * dynamic-import path (vite caches that resolution, so an in-file mock placed
 * after other guard calls does not intercept).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import { guardModelSlots } from '../src/compat.ts'

const CORDIS_MODULE = '@deepseek-ai/cordis'
const SETTINGS_MODULE = '@deepseek-ai/dsh-settings'

function recordingLogger(sink: string[]): CompatLogger {
  return { warn: (message: string) => { sink.push(message) } }
}

/** Passing shape for the cordis probe (typeof Service === 'function'). */
function passingCordisShape(): { Service: unknown } {
  return {
    Service: class {
      probeShape(): undefined {
        return undefined
      }
    },
  }
}

afterEach(() => {
  vi.doUnmock(CORDIS_MODULE)
  vi.doUnmock(SETTINGS_MODULE)
  vi.resetModules()
})

describe('guardModelSlots settings catch branch (DEBT §7)', () => {
  it('fail-softs with the literal reason when the settings module import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => passingCordisShape())
    vi.doMock(SETTINGS_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-model-slots disabled')
    expect(warnings[0]).toContain('settings:register')

    const entry = getCompatRoster().get('dsh-model-slots')
    expect(entry).toMatchObject({ enabled: false })
    // The catch reason is the raw probe signal only — the long DEBT
    // attribution wording belongs to the 'register not a function' branch
    // locked in compat.spec.ts, and the two must stay distinguishable.
    expect(entry?.reason.startsWith('cannot import SettingsProvider')).toBe(true)
  })
})
