/**
 * Direct locks on the slot-UI compat guard's `cannot import` catch branches
 * (MAIN-HYGIENE, sync-017 DEBT rulings §7).
 *
 * The catches are the fail-soft verdict paths for whole-module absence
 * (partial install / registry drift / a symbol removal cascading into a load
 * failure): the guard must disable the feature without throwing, and the
 * roster reason must keep the literal `cannot import …` prefix — the audit
 * attribution face the P2+ roster evidence chain relies on. Pattern copied
 * from the proven model-slots tests/compat.spec.ts shape (`vi.doMock` +
 * `vi.resetModules` + recordingLogger); zero src changes.
 *
 * Probe isolation: deps run in declaration order and short-circuit on the
 * first failure, so the store-engine test pins the earlier cordis probe to a
 * passing shape — the lock stays on the catch under test regardless of what
 * the real environment resolves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import { guardSlotUI } from '../src/compat.ts'

const CORDIS_MODULE = '@deepseek-ai/cordis'
const STORE_MODULE = '@deepseek-ai/dsh-client-store'

function recordingLogger(sink: string[]): CompatLogger {
  return { warn: (message: string) => { sink.push(message) } }
}

/** Passing shape for the cordis probe (typeof Service === 'function'). */
function passingCordisShape(): { Service: unknown } {
  return {
    // One member keeps the shape clear of oxlint no-extraneous-class (the
    // official model-slots negative-control precedent); the probe itself only
    // checks typeof Service === 'function'.
    Service: class {
      probeShape(): undefined {
        return undefined
      }
    },
  }
}

afterEach(() => {
  vi.doUnmock(CORDIS_MODULE)
  vi.doUnmock(STORE_MODULE)
  // Drop the mocked module instance so the next guard call re-evaluates the
  // real one; bound top-level imports are unaffected.
  vi.resetModules()
})

describe('guardSlotUI catch branches (DEBT §7)', () => {
  it('fail-softs with the literal reason when the cordis import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardSlotUI(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-slot-ui disabled')
    expect(warnings[0]).toContain('cordis:Service')

    const entry = getCompatRoster().get('dsh-slot-ui')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import cordis Service')).toBe(true)
  })

  it('fail-softs with the literal reason when the dsh-client-store engine import throws', async () => {
    vi.doMock(CORDIS_MODULE, () => passingCordisShape())
    vi.doMock(STORE_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const enabled = await guardSlotUI(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-slot-ui disabled')
    expect(warnings[0]).toContain('store:createSnapshotStore')

    const entry = getCompatRoster().get('dsh-slot-ui')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import the dsh-client-store engine')).toBe(true)
  })
})
