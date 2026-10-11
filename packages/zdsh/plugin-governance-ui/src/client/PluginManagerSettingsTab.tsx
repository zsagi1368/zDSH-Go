import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import type {
  GovernanceHealthReport,
  GovernanceRosterSnapshot,
  GovernedPluginSummary,
  PresetApplicationReport,
} from '@deepseek-ai/dsh-plugin-governance-host/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerLocaleKey } from './locales.ts'
import css from './PluginManagerSettingsTab.module.css'

/** Canonical id of one governed plugin, as issued by the roster. */
export type GovernedPluginRef = GovernedPluginSummary['pluginId']

/** Registration-side Remote face used by the section. */
export interface PluginManagerSettingsTabInjected {
  /** Read the current governed roster. */
  list: () => Promise<GovernanceRosterSnapshot>
  /** Read the aggregate and per-plugin health report. */
  health: () => Promise<GovernanceHealthReport>
  /** Re-enable one disabled plugin. */
  enable: (pluginId: GovernedPluginRef) => Promise<void>
  /** Disable one plugin. */
  disable: (pluginId: GovernedPluginRef) => Promise<void>
  /** Record the operator's admission decision for one plugin. */
  approve: (pluginId: GovernedPluginRef) => Promise<void>
  /** Snapshot current enable/disable decisions under a preset name. */
  presetSave: (name: string) => Promise<void>
  /** Apply one stored preset to the live registry. */
  presetLoad: (name: string) => Promise<PresetApplicationReport>
  /** Delete one stored preset. */
  presetDelete: (name: string) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginManagerSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginManagerSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly roster: GovernanceRosterSnapshot; readonly health: GovernanceHealthReport }

type Notice =
  | { readonly tone: 'info'; readonly text: string; readonly unknown: number }
  | { readonly tone: 'error'; readonly text: string }

const STATUS_KEYS = {
  active: 'statusActive',
  warnings: 'statusWarnings',
  disabled: 'statusDisabled',
  error: 'statusError',
  deprecated: 'statusDeprecated',
} as const satisfies Record<GovernedPluginSummary['status'], PluginManagerLocaleKey>

/** Locale copy for a roster row's origin badge. */
const SOURCE_KEYS = {
  'loader-mirror': 'sourceMirror',
  native: 'sourceNative',
  project: 'sourceProject',
} as const satisfies Record<GovernedPluginSummary['source'], PluginManagerLocaleKey>

/** Whether a roster row currently offers the enable action (rather than disable). */
function isEnabled(row: GovernedPluginSummary): boolean {
  return row.status !== 'disabled'
}

/** Render the governance roster, health counts, lifecycle/admission actions, and presets. */
export function PluginManagerSettingsTab({
  list, health, enable, disable, approve, presetSave, presetLoad, presetDelete, t,
}: PluginManagerSettingsTabProps): ReactNode {
  const presetInputId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [pending, setPending] = useState<'roster' | 'preset' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [presetName, setPresetName] = useState('')
  const [knownPresets, setKnownPresets] = useState<readonly string[]>([])

  useEffect(() => {
    let current = true
    setPending(null)
    void Promise.all([Promise.resolve().then(() => list()), Promise.resolve().then(() => health())]).then(
      ([roster, report]) => { if (current) setState({ status: 'ready', roster, health: report }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [list, health, request])

  const refresh = useCallback((): void => { setRequest(value => value + 1) }, [])

  /** Run one roster mutation: block re-entry, refresh on success, surface failures. */
  const runRosterAction = useCallback((run: () => Promise<void>): void => {
    if (pending !== null) return
    setPending('roster')
    void Promise.resolve().then(run).then(
      () => { refresh() },
      (error: unknown) => {
        setPending(null)
        setNotice({ tone: 'error', text: `${t('actionFailed')}${error instanceof Error ? error.message : String(error)}` })
      },
    )
  }, [pending, refresh, t])

  /** Run one preset operation against the entered name. */
  const runPresetAction = useCallback((kind: 'save' | 'load' | 'delete'): void => {
    const name = presetName.trim()
    if (name.length === 0 || pending !== null) return
    setPending('preset')
    const outcome = (async (): Promise<{ text: string; unknownCount: number }> => {
      if (kind === 'save') {
        await presetSave(name)
        return { text: t('presetSaved'), unknownCount: 0 }
      }
      if (kind === 'delete') {
        await presetDelete(name)
        return { text: t('presetDeleted'), unknownCount: 0 }
      }
      const report = await presetLoad(name)
      return { text: t('presetApplied'), unknownCount: report.unknown.length }
    })()
    void outcome.then(
      ({ text, unknownCount }) => {
        setPending(null)
        setKnownPresets(names => names.includes(name) ? names : [...names, name])
        setNotice({ tone: 'info', text, unknown: unknownCount })
      },
      (error: unknown) => {
        setPending(null)
        setNotice({ tone: 'error', text: `${t('actionFailed')}${error instanceof Error ? error.message : String(error)}` })
      },
    )
  }, [pending, presetDelete, presetLoad, presetName, presetSave, t])

  const retry = (): void => {
    setState({ status: 'loading' })
    refresh()
  }

  const trimmedPresetName = presetName.trim()
  const presetActionsDisabled = pending !== null || trimmedPresetName.length === 0

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || pending !== null}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {notice !== null ? (
        <p className={css.notice} data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
          {notice.tone === 'info' && notice.unknown > 0
            ? <span className={css.noticeDetail}>{t('presetUnknown')}: {notice.unknown}</span>
            : null}
        </p>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <div className={css.healthStrip} data-health-report>
            <h3>{t('health')}</h3>
            <ul className={css.healthChips}>
              {([
                ['total', t('healthTotal'), state.health.total],
                ['active', t('healthActive'), state.health.active],
                ['warnings', t('healthWarnings'), state.health.warnings],
                ['errors', t('healthErrors'), state.health.errors],
                ['disabled', t('healthDisabled'), state.health.disabled],
              ] as const).map(([key, label, value]) => (
                <li className={css.healthChip} data-health={key} key={key}>
                  <span className={css.healthValue}>{value}</span>
                  <span className={css.healthLabel}>{label}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={css.rosterHeading}>
            <h3>{t('roster')}</h3>
            <span data-plugin-count={state.roster.plugins.length}>{state.roster.plugins.length}</span>
          </div>
          {state.roster.plugins.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.roster.plugins.length > 0 ? (
            <table className={css.roster}>
              <thead>
                <tr>
                  <th scope="col">{t('colPlugin')}</th>
                  <th scope="col">{t('colVersion')}</th>
                  <th scope="col">{t('colSource')}</th>
                  <th scope="col">{t('colStatus')}</th>
                  <th scope="col">{t('colApproval')}</th>
                  <th scope="col">{t('colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {state.roster.plugins.map((row) => {
                  const status = t(STATUS_KEYS[row.status])
                  const approval = row.approved
                    ? t('approvedTag')
                    : row.approvalRequired ? t('approvalRequiredTag') : t('approvalNotRequiredTag')
                  return (
                    <tr key={row.pluginId} data-plugin-row={row.pluginId}>
                      <td className={css.pluginCell}>
                        <strong title={row.pluginId}>{row.displayName}</strong>
                        <code>{row.pluginId}</code>
                        {row.warnings.length > 0 ? (
                          <span className={css.warningTag} data-warnings={row.warnings.length}>
                            {t('healthWarnings')}: {row.warnings.length}
                          </span>
                        ) : null}
                      </td>
                      <td className={css.versionCell}>{row.version}</td>
                      <td>
                        <span className={css.sourceBadge} data-source={row.source}>
                          {t(SOURCE_KEYS[row.source])}
                          {row.projectRoot !== undefined ? (
                            <span className={css.projectRoot} data-project-root title={row.projectRoot}>
                              {row.projectRoot}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <span className={css.statusBadge} data-status={row.status}>{status}</span>
                      </td>
                      <td>
                        <span
                          className={css.approvalBadge}
                          data-approval={row.approved ? 'approved' : row.approvalRequired ? 'required' : 'auto'}
                        >
                          {approval}
                        </span>
                      </td>
                      <td className={css.actionsCell}>
                        <span className={css.actionRow}>
                          {isEnabled(row) ? (
                            <button
                              type="button"
                              disabled={pending !== null}
                              onClick={() => { runRosterAction(() => disable(row.pluginId)) }}
                            >
                              {t('disable')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={pending !== null || (row.approvalRequired && !row.approved)}
                              title={row.approvalRequired && !row.approved ? t('approvalRequiredTag') : undefined}
                              onClick={() => { runRosterAction(() => enable(row.pluginId)) }}
                            >
                              {t('enable')}
                            </button>
                          )}
                          {row.approvalRequired && !row.approved ? (
                            <button
                              type="button"
                              disabled={pending !== null}
                              onClick={() => { runRosterAction(() => approve(row.pluginId)) }}
                            >
                              {t('approve')}
                            </button>
                          ) : null}
                          <span className={css.deferredTag} data-not-implemented title={t('deferredTag')}>
                            {t('deferredTag')}
                          </span>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : null}
          <form
            className={css.presets}
            data-preset-form
            onSubmit={(event) => {
              event.preventDefault()
              runPresetAction('load')
            }}
          >
            <h3>{t('presets')}</h3>
            <div className={css.presetRow}>
              <label className={css.visuallyHidden} htmlFor={presetInputId}>{t('presetName')}</label>
              <input
                id={presetInputId}
                type="text"
                list={`${presetInputId}-names`}
                value={presetName}
                placeholder={t('presetPlaceholder')}
                onChange={(event) => { setPresetName(event.currentTarget.value) }}
              />
              <datalist id={`${presetInputId}-names`}>
                {knownPresets.map(name => <option value={name} key={name} />)}
              </datalist>
              <button
                type="button"
                disabled={presetActionsDisabled}
                onClick={() => { runPresetAction('save') }}
              >
                {t('presetSave')}
              </button>
              <button
                type="submit"
                disabled={presetActionsDisabled}
              >
                {t('presetLoad')}
              </button>
              <button
                type="button"
                disabled={presetActionsDisabled}
                onClick={() => { runPresetAction('delete') }}
              >
                {t('presetDelete')}
              </button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  )
}
