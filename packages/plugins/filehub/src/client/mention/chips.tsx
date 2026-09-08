/**
 * Chip reference bar (spec FR-B7): one chip per @token parsed out of the live
 * composer draft. Clicking a chip locates the token (best-effort caret
 * placement in the composer textarea — the host exposes no public selection
 * API, see LOCATE SEAM below); the × button deletes exactly that occurrence.
 *
 * Mounted as a SECOND entry in the same `conversation.input.dock` slot: the
 * slot is declared `kind: 'list'` (Fork/packages/client/ui-conversation/
 * lib/types/client/contract/slots.d.ts:244-248), so multiple injectors are
 * allowed and entries render by ascending order — confirmed, no merge into
 * the M1 dock component needed.
 */
import { useCallback, useEffect } from 'react'
import type { ReactNode } from 'react'

import { injectStylesOnce } from '../util.js'
import { scanDraftTokens } from './grammar.js'
import type { DraftToken } from './grammar.js'
import { iconForEntry } from './icons.js'
import { setMentionSessionSeam } from './source.js'

export const MENTION_CHIPS_STYLES = `
.zdsh-filehub-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 0;
}
.zdsh-filehub-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 260px;
  padding: 2px 4px 2px 6px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.16);
  font-size: 12px;
  line-height: 1.3;
  border: none;
  color: inherit;
  cursor: pointer;
}
.zdsh-filehub-chip:hover { background: rgba(127, 127, 127, 0.28); }
.zdsh-filehub-chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button.zdsh-filehub-chip-x {
  flex: none;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 2px 3px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
}
button.zdsh-filehub-chip-x:hover { opacity: 1; background: rgba(127, 127, 127, 0.3); }
`

/** Structural subset of the framework InputState this component reads. */
export interface ChipsInputLike {
  readonly draft: string
}

/** Structural subset of the public InputActions face. */
export interface ChipsInputActionsLike {
  setDraft(text: string): void
}

export interface FileHubChipsProps {
  readonly sessionId?: string | undefined
  /** Framework standard kit (session-scope slots receive useInput/inputActions). */
  readonly useInput?: (<S>(selector: (state: ChipsInputLike) => S) => S) | undefined
  readonly inputActions?: ChipsInputActionsLike | undefined
  /** Direct draft override (tests; bypasses useInput). */
  readonly draft?: string | undefined
  /** Locate override (tests). */
  readonly onLocate?: ((token: DraftToken) => void) | undefined
}

/**
 * Best-effort locate (LOCATE SEAM): focus the composer textarea inside the
 * same card as this dock strip and place the caret over the token span. The
 * `[data-composer-card]` anchor is what the host's own MenuView uses for its
 * outside-click guard, so it is the most stable handle available to plugins;
 * failure is silent by design (a chip click must never throw).
 */
function defaultLocate(root: HTMLElement | null, token: DraftToken): void {
  try {
    const card = root?.closest('[data-composer-card]') ?? root?.ownerDocument.querySelector('[data-composer-card]')
    const textarea = card?.querySelector('textarea')
    if (!textarea) return
    textarea.focus()
    const start = Math.min(token.start, textarea.value.length)
    const end = Math.min(token.end, textarea.value.length)
    textarea.setSelectionRange(start, end)
  } catch {
    // No textarea / restricted selection: locating is a nicety, not a contract.
  }
}

/**
 * Render chips for every @token in the draft. Renders nothing while the draft
 * holds no tokens (conservative slot citizen like the M1 dock).
 */
export function FileHubChips(props: FileHubChipsProps): ReactNode {
  const { sessionId, useInput, inputActions, draft: draftOverride, onLocate } = props

  useEffect(() => {
    setMentionSessionSeam(sessionId ?? null)
    return () =>{  setMentionSessionSeam(null) }
  }, [sessionId])

  useEffect(() => {
    injectStylesOnce('zdsh-filehub-mention-chip-styles', MENTION_CHIPS_STYLES)
  }, [])

  const draft = useInput ? useInput(state => state.draft) : draftOverride ?? ''
  const tokens = scanDraftTokens(draft)

  // Kind is unknown client-side until picked/searched; directories carry a
  // trailing slash in their raw form, which is the only signal we re-derive.
  const kindOf = (token: DraftToken): 'file' | 'directory' =>
    !token.quoted && token.value.endsWith('/') ? 'directory' : 'file'

  const removeToken = useCallback(
    (token: DraftToken): void => {
      if (!inputActions) return
      inputActions.setDraft(draft.slice(0, token.start) + draft.slice(token.end))
    },
    [draft, inputActions],
  )

  const locateToken = useCallback(
    (token: DraftToken, root: HTMLElement | null): void => {
      if (onLocate) {
        onLocate(token)
        return
      }
      defaultLocate(root, token)
    },
    [onLocate],
  )

  if (tokens.length === 0) return null

  return (
    <div className="zdsh-filehub-chips" data-testid="zdsh-filehub-chips">
      {tokens.map((token, index) => (
        <ChipRow
          key={`${token.start}:${token.raw}`}
          token={token}
          index={index}
          kind={kindOf(token)}
          onRemove={() =>{  removeToken(token) }}
          onLocate={locateToken}
        />
      ))}
    </div>
  )
}

interface ChipRowProps {
  readonly token: DraftToken
  readonly index: number
  readonly kind: 'file' | 'directory'
  readonly onRemove: () => void
  readonly onLocate: (token: DraftToken, root: HTMLElement | null) => void
}

function ChipRow(props: ChipRowProps): ReactNode {
  const { token, index, kind, onRemove, onLocate } = props
  const base = token.value.replace(/\/$/u, '')
  const slash = base.lastIndexOf('/')
  const label = slash >= 0 ? base.slice(slash + 1) : base
  return (
    <span
      className="zdsh-filehub-chip"
      data-testid={`zdsh-filehub-chip-${index}`}
      title={token.value}
      role="button"
      tabIndex={0}
      onClick={(event) =>{  onLocate(token, event.currentTarget) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onLocate(token, event.currentTarget)
      }}
    >
      {iconForEntry(kind, token.value)}
      <span className="zdsh-filehub-chip-label">{label}</span>
      <button
        type="button"
        className="zdsh-filehub-chip-x"
        title="Remove reference"
        aria-label={`Remove reference ${token.value}`}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        ✕
      </button>
    </span>
  )
}
