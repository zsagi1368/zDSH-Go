/**
 * The per-model reasoning-effort declaration for a pi-ai route.
 *
 * A model of the installed catalog inherits its levels from that catalog. A
 * hand-declared model has no catalog entry to inherit from, so it declares no
 * levels — and a model with no declared levels offers no effort control at
 * all, in the composer's model picker and everywhere else. That is the whole
 * gap this component closes: the levels a hand-declared model offers are a
 * fact about the endpoint, and without a way to state it the surface has
 * nothing to offer.
 *
 * The declaration is a map from level to the value dispatch sends for it. A
 * level's value is a fact about the ENDPOINT's vocabulary — most gateways
 * accept the level name itself, some rename it — so the field defaults to the
 * level name and stays editable.
 *
 * `off` is the one level that may leave its value empty: for most providers
 * not thinking is the parameter's absence, and a level that sent an empty
 * value would be a request the provider cannot read.
 */

import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Every level a profile may declare, in escalation order. This is a copy of
 * the adapter's own vocabulary: the client package cannot import the Host
 * package, so the two must stay in step. The Host refuses any level it does
 * not know, and refuses a declaration offering no level beyond `off`, so a
 * drift shows up as a refused write rather than as a silently wrong request.
 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One level a model may declare. */
type Level = typeof LEVELS[number]

/** The declaration as it is stored: level to the value dispatch sends. */
type Efforts = Partial<Record<Level, string | null>>

/** Props of {@link ModelReasoningEfforts}. */
export interface ModelReasoningEffortsProps {
  /** The model row this declaration belongs to. */
  model: Record<string, unknown>
  /** One-based row position, for the accessible group label. */
  position: number
  /** Prevent changes while read-only or saving. */
  disabled: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
  /** Replace this row, preserving unrelated configuration. */
  onChange: (model: Record<string, unknown>) => void
}

/**
 * Read a stored declaration as a level map.
 * @param value - the row's `reasoningEfforts` field, of any shape.
 * @returns the level map, or undefined when the row declares none.
 */
function effortsOf(value: unknown): Efforts | undefined {
  if (value === undefined || value === null) return undefined
  if (value === false) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
    .filter(([level]) => (LEVELS as readonly string[]).includes(level))
    .map(([level, wire]) => {
      const named = level as Level
      // A wire value is a string or nothing; anything else is not a spelling
      // of a level, so it is read as absent rather than stringified.
      const spelling = typeof wire === 'string' ? wire : null
      return [named, spelling] as [Level, string | null]
    })
  return Object.fromEntries(entries)
}

/**
 * The wire value a level sends, as the field shows it: the stored value, or
 * the level's own name when the level was checked but its value left blank.
 * @param efforts - the declaration as stored.
 * @param level - the level being read.
 * @returns the text the field shows.
 */
function wireText(efforts: Efforts | undefined, level: Level): string {
  const value = efforts?.[level]
  if (value === undefined) return ''
  if (value === null) return level === 'off' ? '' : level
  return value
}

/**
 * Render one model's reasoning-effort declaration.
 * @param props - the model row, its position, and the row replacement action.
 * @returns the level checkboxes and their wire values.
 */
export function ModelReasoningEfforts(props: ModelReasoningEffortsProps): ReactNode {
  const { model, position, disabled, t, onChange } = props
  const efforts = effortsOf(model['reasoningEfforts'])
  // `false` is an explicit "this model does not reason", which is different
  // from declaring nothing: the first refuses reasoning, the second inherits
  // the catalog's capability.
  const disabledReasoning = model['reasoningEfforts'] === false

  const declare = (next: Efforts): void => {
    // An empty declaration is not a spelling of "no levels": the adapter
    // refuses it, and so does this control, by dropping the field entirely.
    if (Object.keys(next).length === 0) {
      const copy = { ...model }
      Reflect.deleteProperty(copy, 'reasoningEfforts')
      onChange(copy)
      return
    }
    onChange({ ...model, reasoningEfforts: next })
  }

  const toggle = (level: Level, checked: boolean): void => {
    const next: Efforts = { ...efforts }
    if (!checked) {
      Reflect.deleteProperty(next, level)
    } else if (level === 'off') {
      // The one level that may carry no value: not thinking is the parameter's
      // absence, and sending an empty value is a request no provider reads.
      next.off = null
    } else {
      next[level] = level
    }
    declare(next)
  }

  const setWire = (level: Level, text: string): void => {
    const next: Efforts = { ...efforts }
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      // Only `off` may go valueless; another level with no value would send
      // nothing for a level the provider was told is supported.
      next[level] = level === 'off' ? null : ''
    } else {
      next[level] = trimmed
    }
    declare(next)
  }

  return (
    <fieldset className={styles['modelInputTypes']} aria-label={`${t('modelReasoningEfforts')} ${String(position)}`}>
      <legend className={styles['modelFieldLabel']}>{t('modelReasoningEfforts')}</legend>
      <p className={styles['advancedHint']}>{t('modelReasoningEffortsHint')}</p>
      {LEVELS.map((level) => {
        const declared = efforts !== undefined && level in efforts
        const label = t(`modelReasoningLevel.${level}`)
        return (
          <div className={styles['modelReasoningRow']} key={level}>
            <Checkbox
              label={label}
              checked={declared}
              disabled={disabled}
              onChange={(checked) => { toggle(level, checked) }}
            />
            <input
              className={styles['input']}
              type="text"
              value={wireText(efforts, level)}
              placeholder={t('modelReasoningWirePlaceholder')}
              aria-label={`${label} ${String(position)}`}
              disabled={disabled || !declared}
              onChange={(event) => { setWire(level, event.target.value) }}
            />
          </div>
        )
      })}
      {disabledReasoning
        ? <p className={styles['advancedHint']}>{t('modelReasoningDisabled')}</p>
        : null}
    </fieldset>
  )
}
