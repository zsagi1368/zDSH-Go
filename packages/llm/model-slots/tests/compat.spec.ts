/**
 * Discriminating lock for the model-slots compat guard (L2, 2026-10-12 —
 * clears DEBT-MODEL-SLOTS).
 *
 * Positive face — against the real official 0.1.7 settings surface (the
 * `SettingsProvider` registration API is retired): the guard must enable,
 * because the user-layer override now rides on the entry-derived settings
 * face — `SettingsForms` describe/update/mutate plus this package's own
 * volatile Config fields.
 *
 * Negative control — against a mocked retired shape (a `SettingsProvider`
 * class carrying `prototype.register` and no SettingsForms default export):
 * the same guard must fail soft with an *attributable* roster reason — the raw
 * probe signal as prefix, then the retired surface, the replacement face, the
 * degraded capability (user-layer slot overrides not settings-writable) and
 * the fact that the composition-config core keeps serving. This pair proves
 * the positive face is locked by the probe surface shape, not by an
 * always-true guard.
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

describe('guardModelSlots without the entry-derived settings forms surface (negative control)', () => {
  it('fail-soft disables with the attributed shape reason when the writable forms face is missing', async () => {
    vi.doMock(SETTINGS_MODULE, () => ({
      // A partial/older forms face: `describe` alone, without the update and
      // mutate members the slot editor's write path goes through.
      default: class SettingsForms {
        describe(): unknown {
          return undefined
        }
      },
    }))

    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(false)
    // Framework warn face: the failing check is named (guard.ts contract).
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[compat] dsh-model-slots disabled')
    expect(warnings[0]).toContain('settings:forms')

    const entry = getCompatRoster().get('dsh-model-slots')
    expect(entry).toMatchObject({ enabled: false })
    // Attribution contract: the raw probe signal stays as the prefix, followed
    // by the retired surface, the replacement face, the degraded capability
    // and the composition-config core that keeps serving.
    expect(entry?.reason.startsWith('forms describe/update/mutate not functions')).toBe(true)
    expect(entry?.reason).toContain('0.1.7')
    expect(entry?.reason).toContain('SettingsProvider')
    expect(entry?.reason).toContain('SettingsForms')
    expect(entry?.reason).toContain('user-layer')
    expect(entry?.reason).toContain('composition configuration')
  })

  it('fail-soft disables when the host still exposes only the retired registration face', async () => {
    vi.doMock(SETTINGS_MODULE, () => ({
      // The retired 0.1.5-shaped module: a registration class, and no forms
      // default export at all — the user layer cannot be reached through it.
      SettingsProvider: class {
        register(): unknown {
          return undefined
        }
      },
    }))

    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('settings:forms')

    const entry = getCompatRoster().get('dsh-model-slots')
    expect(entry).toMatchObject({ enabled: false })
    expect(entry?.reason.startsWith('cannot import the settings forms surface')).toBe(true)
  })
})

describe('guardModelSlots against the real official 0.1.7 settings surface', () => {
  it('enables the feature and records an ok roster verdict', async () => {
    const warnings: string[] = []
    const enabled = await guardModelSlots(recordingLogger(warnings))

    expect(enabled).toBe(true)
    expect(warnings).toEqual([])
    expect(getCompatRoster().get('dsh-model-slots')).toMatchObject({ enabled: true, reason: 'ok' })
  })

  it('keeps the registry core serving the live config (no crash, no fiber failure)', async () => {
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
// 'forms describe/update/mutate not functions' face stays locked by the
// describes above.
