/**
 * Direct locks on the ACP compat guard's `cannot import` catch branch
 * (MAIN-HYGIENE, sync-017 DEBT rulings §7).
 *
 * The catch is the fail-soft verdict path for whole-module absence (partial
 * install / registry drift / a symbol removal cascading into a load failure):
 * the guard must disable the feature without throwing, and the roster reason
 * must keep the literal `cannot import …` prefix — the audit attribution
 * face the P2+ roster evidence chain relies on (a silent wording drift would
 * break audit continuity). Pattern copied from the proven model-slots
 * tests/compat.spec.ts shape (`vi.doMock` + `vi.resetModules` +
 * recordingLogger); zero src changes.
 *
 * Scope note (rulings §7): the two silent catches in acp compat.ts
 * (`official = undefined` / `approvalOk = false` policy fallbacks carrying no
 * roster reason) are deliberately NOT tested here — they are not guard
 * verdict faces.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import { guardACP } from '../src/compat.ts'

const SDK_MODULE = '@agentclientprotocol/sdk'

function recordingLogger(sink: string[]): CompatLogger {
  return { warn: (message: string) => { sink.push(message) } }
}

afterEach(() => {
  vi.doUnmock(SDK_MODULE)
  // Drop the mocked module instance so the next guard call re-evaluates the
  // real one; bound top-level imports are unaffected.
  vi.resetModules()
})

describe('guardACP catch branch: cannot import @agentclientprotocol/sdk (DEBT §7)', () => {
  it('fail-softs to a fully disabled verdict and records the literal roster reason', async () => {
    vi.doMock(SDK_MODULE, () => {
      throw new Error('injected module-resolution failure (partial install / registry drift)')
    })

    const warnings: string[] = []
    const verdict = await guardACP(recordingLogger(warnings))

    // The disabled early-return shape (src/compat.ts): no strategy, no overlay.
    expect(verdict).toEqual({ enabled: false, resumeStrategy: 'disabled', permissionOverlay: false })
    // Framework warn face: the failing check is named (guard.ts contract).
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-acp disabled')
    expect(warnings[0]).toContain('acp:official-session')

    const entry = getCompatRoster().get('dsh-acp')
    expect(entry).toMatchObject({ enabled: false })
    // Attribution contract: the raw probe signal stays as the literal prefix
    // (roster-audit continuity), locked against silent wording drift.
    expect(entry?.reason.startsWith('cannot import @agentclientprotocol/sdk')).toBe(true)
  })
})
