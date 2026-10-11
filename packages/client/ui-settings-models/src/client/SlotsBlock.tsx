/**
 * Read-only auxiliary-model slot block with a vision-slot editor. Shows every
 * built-in slot's effective route and origin tier (explicit slot statement,
 * deployment default, or the main-model route), following the same precedence
 * the `ModelSlotRegistry.resolve()` uses. The vision slot alone is editable
 * because its provider/model pair chooses which model digests images for a
 * text-only conversation model; its credential is recorded as the derived
 * environment-variable reference (`deriveKeyRef`), never as a literal key.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { SLOT_LABEL_KEYS, SOURCE_LABEL_KEYS, type en } from './locales.ts'
import {
  deriveKeyRef, effectiveSlotViews, MODEL_SLOTS_SETTINGS_NAMESPACE, visionModelImageError,
} from './store.ts'
import type { VisionModelProbe } from './store.ts'
import type { SettingsSchemaOperations } from './schema-operations.ts'
import styles from './ModelsSection.module.css'

/** Replace the one `{ref}` placeholder in localized copy. */
function refCopy(template: string, ref: string): string {
  return template.replace('{ref}', () => ref)
}

/** Injected dependencies of the slots block. */
export interface SlotsBlockProps {
  /** The `llm-model-slots` namespace view, or undefined when the settings mirror has not yet loaded it. */
  namespace: SettingsNamespaceView | undefined
  /** Every configurable provider entry (for the vision editor's provider select). */
  providers: readonly { provider: string; displayName: string }[]
  /**
   * The wire faces the vision editor goes through, narrowed to what this block
   * reads: the `settings/mutate` write and the optional model-capability
   * probe (the upstream wire exposes no probe; an absent member defers to the
   * runtime image gate — see `visionModelImageError`).
   */
  api: {
    /** Apply path operations to one settings namespace. */
    settings: {
      mutate(
        ns: string,
        ops: SettingsPathOpView[],
        expectedRevision: number | undefined,
      ): Promise<
        { readonly ok: true; readonly value: SettingsNamespaceView }
        | { readonly ok: false; readonly error: { readonly message: string } }
      >
    }
    /** Model-capability probe; every member is optional. */
    llm: VisionModelProbe
  }
  /** Settings schema and immutable path callbacks. */
  schema: SettingsSchemaOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable every mutation. */
  readOnly: boolean
  /** Notify the parent the page snapshot should be reloaded. */
  onSaved: () => void
}

/**
 * Render the auxiliary-model slots block: one read-only summary per built-in
 * slot, plus an editable card for the vision slot.
 * @param props - the namespace view, provider directory, and wire faces.
 * @returns the block, or null when the namespace is absent.
 */
export function SlotsBlock(props: SlotsBlockProps): ReactNode {
  const { namespace, providers, api, schema, t, readOnly, onSaved } = props
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [draftProvider, setDraftProvider] = useState('')
  const [draftModel, setDraftModel] = useState('')

  const views = effectiveSlotViews(namespace?.value)
  const visionView = views.find(view => view.slot === 'vision')

  const closeEditor = (): void => {
    setEditing(false)
    setError(undefined)
  }

  const openEditor = (): void => {
    const current = visionView
    setDraftProvider(current?.provider ?? '')
    setDraftModel(current?.model ?? '')
    setError(undefined)
    setSaved(false)
    setEditing(true)
  }

  const save = async (): Promise<void> => {
    const provider = draftProvider.trim()
    const model = draftModel.trim()
    if (provider.length === 0 || model.length === 0) {
      setError(t('visionRouteRequired'))
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      // Validate image capability before writing.
      const modelInfo = (api.llm as { resolveModelInfo?: VisionModelProbe['resolveModelInfo'] }).resolveModelInfo
      const probe: VisionModelProbe = { ...(modelInfo !== undefined ? { resolveModelInfo: modelInfo } : {}) }
      const modalityError = await visionModelImageError(provider, model, probe)
      if (modalityError !== undefined) {
        setError(t(modalityError))
        return
      }

      const apiKeyEnv = deriveKeyRef(provider)
      // The schema layer refuses a literal credential: the derived reference
      // is the only `apiKeyEnv` shape this page ever writes, and the schema's
      // pattern re-checks the assembled draft before the wire call.
      const current = (typeof namespace?.value === 'object' && namespace.value !== null
        ? namespace.value
        : {}) as { slots?: Record<string, unknown> }
      const slots = { ...(current.slots ?? {}) }
      slots['vision'] = { provider, model, apiKeyEnv }
      const draft = { ...current, slots }
      if (namespace !== undefined) {
        const failure = schema.validate(schema.rehydrate(namespace.schema), draft)
        if (failure !== undefined) {
          setError(failure)
          return
        }
      }

      const response = await api.settings.mutate(
        MODEL_SLOTS_SETTINGS_NAMESPACE,
        [{
          op: 'set',
          path: ['slots', 'vision'],
          value: { provider, model, apiKeyEnv },
        }],
        namespace?.revision,
      )
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setSaved(true)
      setEditing(false)
      onSaved()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    } finally {
      setSaving(false)
    }
  }

  const clearSlot = async (): Promise<void> => {
    setSaving(true)
    setError(undefined)
    try {
      const response = await api.settings.mutate(
        MODEL_SLOTS_SETTINGS_NAMESPACE,
        [{ op: 'unset', path: ['slots', 'vision'] }],
        namespace?.revision,
      )
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setSaved(true)
      setEditing(false)
      onSaved()
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_))
    } finally {
      setSaving(false)
    }
  }

  const providerOptions = providers.map(row => (
    <option key={row.provider} value={row.provider}>{row.displayName}</option>
  ))

  return (
    <section className={styles['section']} aria-label={t('slotsTitle')}>
      <h2 className={styles['title']}>{t('slotsTitle')}</h2>
      <p className={styles['intro']}>{t('slotsIntro')}</p>
      {saved
        ? <p className={styles['savedNotice']} role="status" aria-live="polite">{t('visionSaved')}</p>
        : null}
      {views.length === 0
        ? <p className={styles['modelEmpty']}>{t('slotsEmpty')}</p>
        : (
          <ul className={styles['rows']}>
            {views.map((view) => {
              const route = view.provider !== undefined && view.model !== undefined
                ? `${view.provider}/${view.model}`
                : t('slotUnset')
              const sourceKey = SOURCE_LABEL_KEYS[view.source] ?? 'slotSourceMainRoute'
              return (
                <li key={view.slot} className={styles['rowCard']}>
                  <div className={styles['rowHead']}>
                    <span className={styles['rowIdentity']}>
                      <span className={styles['rowName']}>{t(SLOT_LABEL_KEYS[view.slot] ?? 'slotTitle')}</span>
                    </span>
                    <span className={styles['rowActions']}>
                      {view.slot === 'vision' && !readOnly
                        ? (
                          <button
                            type="button"
                            className={styles['secondaryButton']}
                            aria-label={t('visionEdit')}
                            disabled={editing}
                            onClick={openEditor}
                          >
                            {t('visionEdit')}
                          </button>
                        )
                        : null}
                    </span>
                  </div>
                  <div className={styles['field']}>
                    <span className={styles['modelFieldLabel']}>{route}</span>
                    <span className={styles['modelCatalogMeta']}>{t(sourceKey)}</span>
                    {view.source === 'main-route' && view.provider === undefined
                      ? <span className={styles['modelCatalogMeta']}>{t('slotSourceMainRouteHint')}</span>
                      : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}

      {editing
        ? (
          <div className={styles['addCard']}>
            <div className={styles['editorHeader']}>
              <span className={styles['editorTitle']}>{t('slotVision')}</span>
            </div>
            <div className={styles['field']}>
              <label className={styles['fieldLabel']} htmlFor="vision-provider">{t('visionProviderLabel')}</label>
              <select
                id="vision-provider"
                className={`${styles['input']} ${styles['selectInput']}`}
                value={draftProvider}
                disabled={saving}
                onChange={(event) => { setDraftProvider(event.target.value) }}
              >
                <option value="" disabled>{t('slotUnset')}</option>
                {providerOptions}
              </select>
            </div>
            <div className={styles['field']}>
              <label className={styles['fieldLabel']} htmlFor="vision-model">{t('visionModelLabel')}</label>
              <input
                id="vision-model"
                className={styles['input']}
                type="text"
                value={draftModel}
                placeholder={t('visionModelPlaceholder')}
                disabled={saving}
                onChange={(event) => { setDraftModel(event.target.value) }}
              />
            </div>
            {draftProvider.length > 0
              ? (
                <div className={styles['field']}>
                  <span className={styles['modelCatalogMeta']}>
                    {refCopy(t('visionKeyHint'), deriveKeyRef(draftProvider))}
                  </span>
                  <span className={styles['modelCatalogMeta']}>{t('visionKeyRefOnly')}</span>
                </div>
              )
              : null}
            {error !== undefined
              ? <p className={styles['error']}>{error}</p>
              : null}
            <div className={styles['editorActions']}>
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={saving}
                onClick={closeEditor}
              >
                {t('visionCancel')}
              </button>
              {visionView?.provider !== undefined
                ? (
                  <button
                    type="button"
                    className={styles['dangerButton']}
                    disabled={saving}
                    onClick={() => { void clearSlot() }}
                  >
                    {t('visionUnset')}
                  </button>
                )
                : null}
              <button
                type="button"
                className={styles['primaryButton']}
                disabled={saving}
                onClick={() => { void save() }}
              >
                {saving ? t('visionSaving') : t('visionSave')}
              </button>
            </div>
          </div>
        )
        : null}
    </section>
  )
}
