/**
 * Discriminating lock for the model-slots compat guard (SYNC-P4-MODEL-SLOTS,
 * P3-design §4 plan B / P4-settings-adaptation §4.3).
 *
 * Positive face — against the real official 0.1.7 settings surface (the
 * `SettingsProvider` registration API is retired): the guard must fail-soft
 * to a disabled verdict whose roster reason is *attributable* (raw probe
 * signal kept as prefix, then who removed the surface, what degraded, and
 * the DEBT-MODEL-SLOTS pointer), while the registry service itself keeps
 * serving the raw deployment config — the degradation is by design, not a
 * crash.
 *
 * Negative control — against a mocked 0.1.5-shaped probe surface (a
 * `SettingsProvider` class carrying `prototype.register`): the same guard
 * must enable. This pair proves the positive face is locked by the probe
 * surface shape, not by an always-false guard (the reason wording could not
 * silently drift into meaninglessness either).
 *
 * Ordering note: the negative control runs first so `vi.doMock` is
 * registered before this file ever imports the real `@deepseek-ai/dsh-settings`;
 * the `afterEach` then unmocks and resets the module cache so the positive
 * face evaluates the real module. The top-level bound imports (guard, roster,
 * registry) keep their module identity across the reset.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { getCompatRoster } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'
import ModelSlotRegistry, { MODEL_SLOT_TITLE } from '../src/index.ts'
import { guardModelSlots } from '../src/compat.ts'

const SETTINGS_MODULE = '@deepseek-ai/dsh-settings'

function recordingLogger(sink: string[]): CompatLogger {
  return { warn: (message: string) => { sink.push(message) } }
}

afterEach(() => {
  vi.doUnmock(SETTINGS_MODULE)
  // Drop the mocked module instance so the next guard call re-evaluates the
  // real one; bound top-level imports are unaffected.
  vi.resetModules()
})

describe('guardModelSlots with the 0.1.5-shaped register surface present (negative control)', () => {
  it('enables the feature and records an ok roster verdict', async () => {
    vi.doMock(SETTINGS_MODULE, () => ({
      // Shape the probe accepts: a constructor whose prototype carries register.
      SettingsProvider: class {
        register(): unknown {
          return undefined
        }
      },
    }))

    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(true)
    expect(warnings).toEqual([])
    expect(getCompatRoster().get('dsh-model-slots')).toMatchObject({ enabled: true, reason: 'ok' })
  })
})

describe('guardModelSlots against the real official 0.1.7 settings surface', () => {
  it('fail-soft disables with an attributable roster reason', async () => {
    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(false)
    // Framework warn face: the failing check is named (guard.ts contract).
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-model-slots disabled')
    expect(warnings[0]).toContain('settings:register')

    const entry = getCompatRoster().get('dsh-model-slots')
    expect(entry).toMatchObject({ enabled: false })
    // Attribution contract (SYNC-P4 plan B): the raw probe signal stays as
    // the prefix (roster-audit continuity with the P2/P3 evidence), followed
    // by the removable-surface attribution, the degraded capability, the
    // by-design qualification, and the debt-ledger pointer.
    expect(entry?.reason.startsWith('register not a function')).toBe(true)
    expect(entry?.reason).toContain('0.1.7')
    expect(entry?.reason).toContain('SettingsProvider')
    expect(entry?.reason).toContain('fail-soft')
    expect(entry?.reason).toContain('DEBT-MODEL-SLOTS')
  })

  it('keeps the registry core serving the raw config (no crash, no fiber failure)', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(ModelSlotRegistry, {
      slots: { [MODEL_SLOT_TITLE]: { provider: 'aux-provider', model: 'aux-model' } },
    })
    await fiber
    try {
      expect(ctx.modelSlots).toBeInstanceOf(ModelSlotRegistry)
      expect(ctx.modelSlots.resolve(MODEL_SLOT_TITLE)).toEqual({
        slot: MODEL_SLOT_TITLE,
        provider: 'aux-provider',
        model: 'aux-model',
        source: 'slot',
      })
    } finally {
      await fiber.dispose()
    }
  })
})

// zDSH (MAIN-HYGIENE, sync-017 DEBT rulings §7): the two `cannot import`
// catch branches (whole-module absence: partial install / registry drift / a
// symbol removal cascading into a load failure) live in their own files —
// compat-cordis-throw.spec.ts and compat-settings-throw.spec.ts. Their
// throwing mocks need a module registry that never resolved the real module
// through the guard's dynamic-import path (vite caches that resolution, so an
// in-file mock placed after other guard calls does not intercept). The
// 'register not a function' face stays locked by the describes above.
