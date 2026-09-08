/**
 * Candidate list presentation (spec FR-B7): the full keyboard model lives in
 * pickerModel.ts; this component renders state and forwards raw key events,
 * so a future mount point can host it without re-implementing navigation.
 *
 * MOUNT SEAM (documented honestly): the shipped composer routes ↑↓/Enter/Esc
 * through the host input-trigger controller's own menu (ui-input-trigger
 * ArbitrateKey union has no ArrowRight), and plugins receive no caret-level
 * trigger observation — so this richer picker is NOT force-mounted over the
 * composer in M2. It ships as the presentation layer for the FileHub
 * candidate model (used by tests today; TODO(M5): mount from the settings
 * console preview or a future host overlay hook).
 */
import { useReducer, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { injectStylesOnce } from '../util.js'
import { iconForEntry } from './icons.js'
import {
  disambiguateLabels,
  pickerItemsFromEntries,
  reducePicker,
} from './pickerModel.js'
import type { PickerState } from './pickerModel.js'

export const MENTION_PICKER_STYLES = `
.zdsh-filehub-picker {
  display: flex;
  flex-direction: column;
  min-width: 220px;
  max-height: 260px;
  overflow-y: auto;
  border-radius: 8px;
  background: var(--zdsh-filehub-menu-bg, rgba(24, 26, 31, 0.96));
  color: inherit;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  padding: 4px;
}
.zdsh-filehub-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.zdsh-filehub-option[data-active='true'] { background: rgba(127, 127, 127, 0.22); }
.zdsh-filehub-icon { width: 15px; height: 15px; flex: none; opacity: 0.85; }
.zdsh-filehub-option-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zdsh-filehub-option-kind { flex: none; opacity: 0.55; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
`

export interface MentionPickerProps {
  readonly entries: readonly { relativePath: string; kind: 'file' | 'directory' }[]
  /** Controlled open flag; closed renders null like the host menu does. */
  readonly open: boolean
  readonly onPick?: ((relativePath: string, kind: 'file' | 'directory') => void) | undefined
}

/** Handle one raw keyboard event against the pure model. Exported for tests. */
export function pickerKeyToEvent(key: string): 'highlight-next' | 'highlight-previous' | 'collapse' | null {
  if (key === 'ArrowDown') return 'highlight-next'
  if (key === 'ArrowUp') return 'highlight-previous'
  if (key === 'ArrowLeft') return 'collapse'
  return null
}

/**
 * Render one candidate list with full keyboard navigation. ArrowRight on a
 * directory expands its children in place (supplied via `childrenOf`);
 * files pick immediately on Enter/click.
 */
export function MentionPicker(props: MentionPickerProps & {
  /** Child lookup for ArrowRight directory expansion (tests/mount point). */
  readonly childrenOf?: ((parentPath: string) => readonly { relativePath: string; kind: 'file' | 'directory' }[]) | undefined
}): ReactNode {
  const { entries, open, onPick, childrenOf } = props

  const [state, dispatch] = useReducer(
    (state: PickerState, action: Parameters<typeof reducePicker>[1]): PickerState =>
      reducePicker(state, action),
    entries,
    (initial): PickerState => ({
      items: pickerItemsFromEntries(initial),
      highlight: initial.length > 0 ? 0 : -1,
    }),
  )

  // Re-seed when a new candidate page arrives (debounced fetches swap the
  // array identity); expansion state intentionally resets with the page.
  const seededRef = useRef(entries)
  if (seededRef.current !== entries) {
    seededRef.current = entries
    dispatch({ type: 'replace-items', children: entries })
  }

  const labels = disambiguateLabels(state.items)

  if (!open || state.items.length === 0) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const mapped = pickerKeyToEvent(event.key)
    if (mapped !== null) {
      event.preventDefault()
      dispatch({ type: mapped })
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      const item = state.items[state.highlight]
      if (item?.kind === 'directory') {
        dispatch({ type: 'expand', children: childrenOf?.(item.relativePath) ?? [] })
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = state.items[state.highlight]
      if (item && item.kind === 'file') onPick?.(item.relativePath, item.kind)
    }
    // Escape closes: owned by whoever mounts the picker (open flag).
  }

  injectStylesOnce('zdsh-filehub-mention-picker-styles', MENTION_PICKER_STYLES)

  return (
    <div className="zdsh-filehub-picker" role="listbox" tabIndex={0} onKeyDown={onKeyDown}>
      {state.items.map((item, index) => (
        <div
          key={`${item.depth}:${item.relativePath}`}
          className="zdsh-filehub-option"
          data-active={index === state.highlight}
          data-testid={`zdsh-filehub-option-${index}`}
          role="option"
          aria-selected={index === state.highlight}
          style={{ paddingLeft: 8 + item.depth * 14 }}
          onMouseDown={(event) => {
            event.preventDefault()
            if (item.kind === 'directory') {
              dispatch({ type: 'expand', children: childrenOf?.(item.relativePath) ?? [] })
              return
            }
            onPick?.(item.relativePath, item.kind)
          }}
        >
          {iconForEntry(item.kind, item.relativePath)}
          <span className="zdsh-filehub-option-label">{labels[index]}</span>
          <span className="zdsh-filehub-option-kind">{item.kind === 'directory' ? 'dir' : ''}</span>
        </div>
      ))}
    </div>
  )
}
