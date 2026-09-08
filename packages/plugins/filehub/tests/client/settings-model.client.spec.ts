/**
 * Settings form state machine: dirty tracking against the saved baseline,
 * save lifecycle transitions, failure retention, and restore semantics.
 */
import { describe, expect, it } from 'vitest'

import {
  beginSave,
  createSettingsForm,
  editValue,
  isDirty,
  resetValues,
  saveFailed,
  saveSucceeded,
  SETTINGS_DEFAULTS,
} from '../../src/client/settings/model.js'
import type { FileHubSettings } from '../../src/server/settings.js'

const INITIAL: FileHubSettings = {
  ...SETTINGS_DEFAULTS,
  enabled: true,
  'candidates.max': 20,
}

describe('settings form machine', () => {
  it('starts clean and tracks dirtiness per edit', () => {
    let state = createSettingsForm(INITIAL)
    expect(isDirty(state)).toBe(false)

    const edited = editValue(state, 'enabled', false)
    expect(edited).not.toBe(state) // immutability
    expect(isDirty(edited)).toBe(true)
    // Original untouched.
    expect(isDirty(state)).toBe(false)
    state = edited
    expect(state.values.enabled).toBe(false)
    expect(state.savedValues.enabled).toBe(true)
  })

  it('no-ops (same reference) when the value does not change', () => {
    const state = createSettingsForm(INITIAL)
    expect(editValue(state, 'enabled', true)).toBe(state)
    expect(editValue(state, 'vision.mode', 'caption')).toBe(state)
  })

  it('saveSucceeded advances the baseline; saveFailed keeps edits + reason', () => {
    let state = editValue(createSettingsForm(INITIAL), 'candidates.max', 42)
    state = beginSave(state)
    expect(state.status).toBe('saving')

    const ok = saveSucceeded(state, { ...state.values })
    expect(ok.status).toBe('saved')
    expect(isDirty(ok)).toBe(false)

    const failed = saveFailed(beginSave(state), 'HTTP 503')
    expect(failed.status).toBe('error')
    expect(failed.errorMessage).toBe('HTTP 503')
    expect(failed.values['candidates.max']).toBe(42) // edits retained
    expect(isDirty(failed)).toBe(true) // still unsaved
  })

  it('restore moves BOTH copies so the form reads clean again', () => {
    let state = editValue(createSettingsForm(INITIAL), 'console.defaultView', 'flat')
    expect(isDirty(state)).toBe(true)
    state = resetValues(state, { ...SETTINGS_DEFAULTS })
    expect(isDirty(state)).toBe(false)
    expect(state.values['console.defaultView']).toBe('grouped')
    expect(state.status).toBe('idle')
  })
})
