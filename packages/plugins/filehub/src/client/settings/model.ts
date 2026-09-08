/**
 * Pure form state machine for the FileHub settings panel (FR-E5'): dirty
 * tracking, save lifecycle, and reset — no React, no fetch, so the whole
 * machine unit-tests synchronously (tests/client/settings-model.test.ts).
 *
 * The wire shape mirrors src/server/settings.ts (type-only import — erased at
 * build time, so no server code enters the browser bundle). Defaults are
 * redeclared locally because importing the server's runtime constant would
 * drag zod into the client bundle.
 */

import type { FileHubSettings } from '../../server/settings.js'

/** Client copy of FILEHUB_SETTINGS_DEFAULTS (server owns normalization). */
export const SETTINGS_DEFAULTS: Readonly<FileHubSettings> = Object.freeze({
  enabled: true,
  ignorePastedMentions: false,
  'candidates.max': 20,
  'console.defaultView': 'grouped',
  'privacy.localFirstVision': true,
  'vision.mode': 'caption',
})

export type SettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export interface SettingsFormState {
  /** Editable working copy. */
  readonly values: FileHubSettings
  /** Last successfully persisted snapshot (the dirty baseline). */
  readonly savedValues: FileHubSettings
  readonly status: SettingsSaveStatus
  readonly errorMessage?: string | undefined
}

export function settingsEqual(a: FileHubSettings, b: FileHubSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.ignorePastedMentions === b.ignorePastedMentions &&
    a['candidates.max'] === b['candidates.max'] &&
    a['console.defaultView'] === b['console.defaultView'] &&
    a['privacy.localFirstVision'] === b['privacy.localFirstVision'] &&
    a['vision.mode'] === b['vision.mode']
  )
}

export function isDirty(state: SettingsFormState): boolean {
  return !settingsEqual(state.values, state.savedValues)
}

export function createSettingsForm(initial: FileHubSettings): SettingsFormState {
  return { values: { ...initial }, savedValues: { ...initial }, status: 'idle' }
}

export type SettingsValueKey = keyof FileHubSettings

/** Apply one field edit; clears stale error/saved flashes. */
export function editValue<K extends SettingsValueKey>(
  state: SettingsFormState,
  key: K,
  value: FileHubSettings[K],
): SettingsFormState {
  if (state.values[key] === value) return state
  return { ...state, values: { ...state.values, [key]: value }, status: 'idle', errorMessage: undefined }
}

/** Mark a save as in flight. */
export function beginSave(state: SettingsFormState): SettingsFormState {
  return { ...state, status: 'saving', errorMessage: undefined }
}

/** Persisted OK: advance the dirty baseline and flash success. */
export function saveSucceeded(
  state: SettingsFormState,
  persisted: FileHubSettings,
): SettingsFormState {
  return { ...state, savedValues: { ...persisted }, status: 'saved' }
}

/** Persisted failed: keep the edits, surface the reason. */
export function saveFailed(state: SettingsFormState, message: string): SettingsFormState {
  return { ...state, status: 'error', errorMessage: message }
}

/**
 * Restore values (defaults or a reloaded record) WITHOUT persisting — the
 * dirty baseline moves too, since restore is an explicit user act.
 */
export function resetValues(state: SettingsFormState, values: FileHubSettings): SettingsFormState {
  return { ...state, values: { ...values }, savedValues: { ...values }, status: 'idle', errorMessage: undefined }
}
