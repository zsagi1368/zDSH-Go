/**
 * M5 FileHub settings panel (P01 §7, FR-E5'): a `settings.plugins.tab` entry
 * rendering the plugin's own preference page.
 *
 * Slot facts (verified against host d.ts):
 * - ui-settings lib/types/client/contract/slots.d.ts:80-84 declares
 *   `'settings.plugins.tab': { kind: 'list'; scope: 'root'; owner:
 *   SettingsPluginsTabOwnerProps }` (owner props intentionally empty,
 *   lines 126-130); registration options are `{id, order, label}`.
 * - Registration mirrors the first-party precedent
 *   (Fork/packages/client/ui-settings-plugin-inventory/src/client/index.ts:39-46).
 *
 * Transport: this is a third-party (standalone) plugin, so — unlike the
 * first-party tabs, which ride ctx.remote/typert — the panel reads and writes
 * FileHub's OWN HTTP endpoints (GET/PUT /api/filehub/settings). The server
 * owns normalization and validation; the client only edits a working copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { t } from '../i18n.js'
import { injectStylesOnce } from '../util.js'
import { CONSOLE_STYLES } from '../console/styles.js'
import { fetchConsoleSettings, putConsoleSettings } from '../console/api.js'
import {
  beginSave,
  createSettingsForm,
  editValue,
  resetValues,
  saveFailed,
  saveSucceeded,
  SETTINGS_DEFAULTS,
} from './model.js'
import type { SettingsFormState } from './model.js'

/** Minimal structural props of the settings.plugins.tab seat (empty owner). */
export interface FileHubSettingsPanelProps {
  readonly children?: never
}

const SAVE_FLASH_MS = 1600

export function FileHubSettingsPanel(_props: FileHubSettingsPanelProps): ReactNode {
  const [loaded, setLoaded] = useState(false)
  const [, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<SettingsFormState>(() => createSettingsForm({ ...SETTINGS_DEFAULTS }))
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Latest-state mirror so edit handlers can compute the next machine state
  // synchronously and fire the PUT outside any state updater.
  const formRef = useRef(form)
  formRef.current = form

  useEffect(() => {
    injectStylesOnce('zdsh-filehub-console-styles', CONSOLE_STYLES)
    return () =>{  clearTimeout(flashTimer.current) }
  }, [])

  useEffect(() => {
    // Holder object defeats literal narrowing of the cancellation flag.
    const state = { cancelled: false }
    void (async () => {
      try {
        const settings = await fetchConsoleSettings()
        if (!state.cancelled) {
          setForm(createSettingsForm(settings))
          setLoaded(true)
        }
      } catch (error: unknown) {
        if (!state.cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error))
          setLoaded(true)
        }
      }
    })()
    return () => {
      state.cancelled = true
    }
  }, [])

  const persist = useCallback(async (next: SettingsFormState): Promise<void> => {
    setForm(beginSave(next))
    try {
      const saved = await putConsoleSettings(next.values)
      setForm(current => saveSucceeded(current, saved))
      clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => {
        setForm(current => (current.status === 'saved' ? { ...current, status: 'idle' } : current))
      }, SAVE_FLASH_MS)
    } catch (error: unknown) {
      setForm(current =>
        saveFailed(current, error instanceof Error ? error.message : String(error)),
      )
    }
  }, [])

  const onEdit = useCallback(
    <K extends keyof SettingsFormState['values']>(
      key: K,
      value: SettingsFormState['values'][K],
    ): void => {
      const next = editValue(formRef.current, key, value)
      if (next === formRef.current) return
      setForm(next)
      // Save-immediately policy: persist the edited value right away. The
      // machine keeps the previous snapshot as baseline, so a failed PUT
      // leaves the row dirty + error-flashed instead of silently lost.
      void persist(next)
    },
    [persist],
  )

  const onRestore = useCallback((): void => {
    if (!window.confirm(t('settings.restoreConfirm'))) return
    const next = resetValues(formRef.current, { ...SETTINGS_DEFAULTS })
    setForm(next)
    void persist(next)
  }, [persist])

  if (!loaded) {
    return (
      <div className="zdsh-filehub-settings" data-testid="zdsh-filehub-settings">
        <div className="zdsh-filehub-console-note">{t('settings.loading')}</div>
      </div>
    )
  }

  return (
    <div className="zdsh-filehub-settings" data-testid="zdsh-filehub-settings">
      <section>
        <h3>{t('settings.section.general')}</h3>
        <SettingRow
          label={t('settings.enabled')}
          desc={t('settings.enabled.desc')}
          control={
            <Switch
              checked={form.values.enabled}
              label={t('settings.enabled')}
              onChange={(value) =>{  onEdit('enabled', value) }}
            />
          }
        />
        <SettingRow
          label={t('settings.ignorePastedMentions')}
          desc={t('settings.ignorePastedMentions.desc')}
          control={
            <Switch
              checked={form.values.ignorePastedMentions}
              label={t('settings.ignorePastedMentions')}
              onChange={(value) =>{  onEdit('ignorePastedMentions', value) }}
            />
          }
        />
        <SettingRow
          label={t('settings.candidatesMax')}
          desc={t('settings.candidatesMax.desc')}
          control={
            <input
              type="number"
              min={1}
              max={200}
              className="zdsh-filehub-numberinput"
              value={form.values['candidates.max']}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (!Number.isNaN(parsed)) onEdit('candidates.max', Math.min(200, Math.max(1, parsed)))
              }}
            />
          }
        />
        <SettingRow
          label={t('settings.defaultView')}
          desc={t('settings.defaultView.desc')}
          control={
            <select
              className="zdsh-filehub-select"
              value={form.values['console.defaultView']}
              onChange={(event) =>{
                onEdit(
                  'console.defaultView',
                  event.target.value === 'flat' ? 'flat' : 'grouped',
                ) }
              }
            >
              <option value="grouped">{t('settings.defaultView.grouped')}</option>
              <option value="flat">{t('settings.defaultView.flat')}</option>
            </select>
          }
        />
      </section>

      <section>
        <h3>{t('settings.section.privacy')}</h3>
        <SettingRow
          label={t('settings.localFirstVision')}
          desc={t('settings.localFirstVision.desc')}
          control={
            <Switch
              checked={form.values['privacy.localFirstVision']}
              label={t('settings.localFirstVision')}
              onChange={(value) =>{  onEdit('privacy.localFirstVision', value) }}
            />
          }
        />
        <SettingRow
          label={t('settings.visionMode')}
          desc={t('settings.visionMode.desc')}
          control={
            <select
              className="zdsh-filehub-select"
              value={form.values['vision.mode']}
              onChange={(event) => {
                const raw = event.target.value
                onEdit('vision.mode', raw === 'off' ? 'off' : raw === 'analyze' ? 'analyze' : 'caption')
              }}
            >
              <option value="off">{t('settings.visionMode.off')}</option>
              <option value="caption">{t('settings.visionMode.caption')}</option>
              <option value="analyze">{t('settings.visionMode.analyze')}</option>
            </select>
          }
        />
      </section>

      <div className="zdsh-filehub-settingrow">
        <button type="button" className="zdsh-filehub-btn" onClick={onRestore}>
          {t('settings.restoreDefaults')}
        </button>
        <span
          className={
            form.status === 'error'
              ? 'zdsh-filehub-settings-status zdsh-filehub-settings-error'
              : form.status === 'saved'
                ? 'zdsh-filehub-settings-status zdsh-filehub-settings-saved'
                : 'zdsh-filehub-settings-status'
          }
          data-testid="zdsh-filehub-settings-status"
        >
          {form.status === 'saved'
            ? t('settings.saved')
            : form.status === 'error' && form.errorMessage !== undefined
              ? t('settings.saveError', { message: form.errorMessage })
              : ''}
        </span>
      </div>
    </div>
  )
}

function SettingRow(props: {
  readonly label: string
  readonly desc: string
  readonly control: ReactNode
}): ReactNode {
  return (
    <div className="zdsh-filehub-settingrow">
      <div className="zdsh-filehub-settingtext">
        <span>{props.label}</span>
        <span className="zdsh-filehub-settingdesc">{props.desc}</span>
      </div>
      {props.control}
    </div>
  )
}

function Switch(props: {
  readonly checked: boolean
  readonly label: string
  readonly onChange: (value: boolean) => void
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className="zdsh-filehub-switch"
      onClick={() =>{  props.onChange(!props.checked) }}
    />
  )
}
