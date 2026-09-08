/**
 * WebStack 设置卡（`settings.plugin.item` keyed slot 的 webstack 单元）。
 *
 * 达成层级（降级梯，见 ../index.ts 装配说明）：
 * 1. 宿主 settingsScope 可达且 writable —— 暂存草稿可编辑，保存经
 *    scope.set 点路径逐条排队写入宿主设置文档；
 * 2. settingsScope 可达但只读（memory 模式 / 文档锁写）—— 只读展示生效值；
 * 3. settingsScope 不可达（本仓库 devDeps 未含 dsh-client-ui-settings，
 *   宿主写配置机制不可达的降级路径）—— 以 DEFAULT_SETTINGS 为基线的
 *    只读展示卡，并渲染 degradedNotice 说明。
 *
 * 密钥永不回显：engines.<id>.apiKey / credentialRef 不在可编辑字段集内，
 * 本组件不渲染任何密钥材料（连掩码占位都不渲染），密钥管理走宿主侧
 * credentials 域（README「引擎与凭据」节）。
 *
 * @module webstack/client/settings-card
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  canSave,
  type DraftState,
  draftIssues,
  LAYERS,
  type WebstackSettingsShape,
} from './draft-state.ts'
import type { CardKey } from './locale.ts'

/** 卡片视图快照：状态机相 + 降级标记。 */
export interface CardViewState {
  machine: DraftState
  /** 只读降级：scope 缺席或不可写时为 true。 */
  readOnly: boolean
  /** 宿主 scope 同步态；unbound = 走默认基线的降级展示。 */
  scopeStatus: 'unbound' | 'loading' | 'ready' | 'unavailable'
}

/** 注册面注入的业务脸（hooks 成员被框架绑定为 useWebstackCard 选择器钩子）。 */
export interface WebstackCardFace {
  hooks: {
    webstackCard: import('@deepseek-ai/dsh-client-store').SnapshotStore<CardViewState>
  }
  editField: (field: keyof WebstackSettingsShape, value: string | number | boolean) => void
  save: () => void
  discard: () => void
}

/** 卡片组件 props：框架合成座席 + 注入脸（结构对齐 ComposedProps）。 */
export interface WebstackSettingsCardProps {
  useWebstackCard: <R>(selector: (snapshot: CardViewState) => R) => R
  editField: (field: keyof WebstackSettingsShape, value: string | number | boolean) => void
  save: () => void
  discard: () => void
  t: TranslateNS<'webstack.card'>
}

const PHASE_LABEL_KEY: Record<DraftState['phase'], CardKey> = {
  clean: 'phaseClean',
  dirty: 'phaseDirty',
  invalid: 'phaseInvalid',
  saving: 'phaseSaving',
  failed: 'phaseFailed',
}

const rowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
  padding: '4px 0',
} as const

const labelStyle = { flexShrink: 0 } as const

const inputStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  boxSizing: 'border-box' as const,
}

function BoolRow(props: {
  label: string
  value: boolean
  onChange: (next: boolean) => void
  disabled: boolean
}) {
  return (
    <div style={rowStyle}>
      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={props.value}
          disabled={props.disabled}
          onChange={event => props.onChange(event.target.checked)}
        />{' '}
        {props.label}
      </label>
    </div>
  )
}

function NumRow(props: {
  label: string
  value: number
  field: keyof WebstackSettingsShape
  onEdit: WebstackSettingsCardProps['editField']
  disabled: boolean
}) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{props.label}</span>
      <input
        style={inputStyle}
        type="number"
        value={String(props.value)}
        disabled={props.disabled}
        onChange={event => props.onEdit(props.field, event.target.value)}
      />
    </div>
  )
}

/**
 * 设置卡组件。纯展示层：一切数据经 useWebstackCard 选择器读视图快照，
 * 一切变更经 editField/save/discard 回调上行——组件自身零副作用。
 */
export function WebstackSettingsCard(props: WebstackSettingsCardProps) {
  const view = props.useWebstackCard(snapshot => snapshot)
  const machine = view.machine
  const issues = draftIssues(machine)
  const editable = !view.readOnly && machine.phase !== 'saving'
  const phaseLabel = props.t(PHASE_LABEL_KEY[machine.phase])

  return (
    <section data-webstack-card="" data-phase={machine.phase} data-readonly={view.readOnly}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong>{props.t('title')}</strong>
        <span>{phaseLabel}</span>
        {view.readOnly ? <span>{props.t('readOnlyBadge')}</span> : null}
      </header>
      <p>{props.t('subtitle')}</p>
      {view.readOnly ? <p data-webstack-degraded="">{props.t('degradedNotice')}</p> : null}

      <div>
        <BoolRow
          label={props.t('fieldEnabled')}
          value={(view.readOnly ? machine.committed : machine.draft).enabled}
          onChange={next => props.editField('enabled', next)}
          disabled={!editable}
        />
        <div style={rowStyle}>
          <span style={labelStyle}>{props.t('fieldLayer')}</span>
          {view.readOnly ? (
            <span>{machine.committed.layer}</span>
          ) : (
            <select
              style={inputStyle}
              value={machine.draft.layer}
              disabled={!editable}
              onChange={event => props.editField('layer', event.target.value)}
            >
              {LAYERS.map(layer => (
                <option key={layer} value={layer}>
                  {layer}
                </option>
              ))}
            </select>
          )}
        </div>
        <NumRow
          label={props.t('fieldMaxResults')}
          value={(view.readOnly ? machine.committed : machine.draft).maxResults}
          field="maxResults"
          onEdit={props.editField}
          disabled={!editable}
        />
        {!view.readOnly ? (
          <>
            <BoolRow
              label={props.t('fieldAutoFallback')}
              value={machine.draft.autoFallback}
              onChange={next => props.editField('autoFallback', next)}
              disabled={!editable}
            />
            <BoolRow
              label={props.t('fieldFusionEnabled')}
              value={machine.draft.fusionEnabled}
              onChange={next => props.editField('fusionEnabled', next)}
              disabled={!editable}
            />
            <NumRow
              label={props.t('fieldHalfLife')}
              value={machine.draft.timeDecayHalfLifeH}
              field="timeDecayHalfLifeH"
              onEdit={props.editField}
              disabled={!editable}
            />
            <NumRow
              label={props.t('fieldAuthority')}
              value={machine.draft.authorityBoost}
              field="authorityBoost"
              onEdit={props.editField}
              disabled={!editable}
            />
            <NumRow
              label={props.t('fieldDiversity')}
              value={machine.draft.diversityDiscount}
              field="diversityDiscount"
              onEdit={props.editField}
              disabled={!editable}
            />
            <NumRow
              label={props.t('fieldMaxContentChars')}
              value={machine.draft.maxContentChars}
              field="maxContentChars"
              onEdit={props.editField}
              disabled={!editable}
            />
          </>
        ) : null}
        <div style={{ padding: '4px 0' }}>
          <span style={labelStyle}>{props.t('fieldSsrfExempts')}</span>
          {view.readOnly ? (
            <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>
              {machine.committed.ssrfExemptsText.trim() === ''
                ? '-'
                : machine.committed.ssrfExemptsText.trim()}
            </pre>
          ) : (
            <>
              <textarea
                style={{ ...inputStyle, display: 'block', width: '100%' }}
                rows={3}
                value={machine.draft.ssrfExemptsText}
                disabled={!editable}
                onChange={event => props.editField('ssrfExemptsText', event.target.value)}
              />
              <small>{props.t('ssrfHint')}</small>
            </>
          )}
        </div>
      </div>

      {issues.length > 0 ? (
        <ul data-webstack-issues="">
          {issues.map(issue => (
            <li key={`${issue.field}:${issue.message}`}>{props.t(issue.message)}</li>
          ))}
        </ul>
      ) : null}

      {!view.readOnly ? (
        <footer style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            data-webstack-save=""
            disabled={!canSave(machine) || machine.phase === 'saving'}
            onClick={() => props.save()}
          >
            {props.t('actionSave')}
          </button>
          <button
            type="button"
            data-webstack-discard=""
            disabled={machine.phase === 'clean' || machine.phase === 'saving'}
            onClick={() => props.discard()}
          >
            {props.t('actionDiscard')}
          </button>
        </footer>
      ) : null}
    </section>
  )
}
