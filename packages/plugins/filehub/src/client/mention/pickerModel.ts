/**
 * Pure picker state model (spec FR-B7): full keyboard navigation with
 * ↑/↓ moving the highlight, Enter picking it, Escape closing, and ArrowRight
 * expanding ONLY directory candidates in place (their children splice in
 * directly below; ArrowLeft collapses). Zero DOM, fully unit-tested.
 */

export interface PickerItem {
  /** Workspace-relative path, forward slashes. */
  readonly relativePath: string
  readonly kind: 'file' | 'directory'
  /** Depth for indent rendering after expansion. */
  readonly depth: number
}

export type PickerEvent =
  | { readonly type: 'highlight-next' }
  | { readonly type: 'highlight-previous' }
  | {
    readonly type: 'expand'
    /** Children of the highlighted directory (already fetched). */
    readonly children: readonly { relativePath: string; kind: 'file' | 'directory' }[]
  }
  | { readonly type: 'collapse' }
  | {
    /** Replace the whole item list with a fresh candidate page (top level). */
    readonly type: 'replace-items'
    readonly children: readonly { relativePath: string; kind: 'file' | 'directory' }[]
  }

export interface PickerState {
  readonly items: readonly PickerItem[]
  /** Index into items; -1 = nothing highlighted. */
  readonly highlight: number
}

export const emptyPickerState: PickerState = { items: [], highlight: -1 }

/** Flatten a search page into top-level picker items. */
export function pickerItemsFromEntries(
  entries: readonly { relativePath: string; kind: 'file' | 'directory' }[],
): PickerItem[] {
  return entries.map(entry => ({ ...entry, depth: 0 }))
}

function indexOfHighlightedDirectory(state: PickerState): number | undefined {
  const item = state.items[state.highlight]
  if (item === undefined || item.kind !== 'directory') return undefined
  return state.highlight
}

/** First index after `parent` whose depth is <= parent.depth. */
function endOfSubtree(items: readonly PickerItem[], parentIndex: number): number {
  const parent = items[parentIndex]
  if (!parent) return items.length
  let cursor = parentIndex + 1
  while (cursor < items.length && (items[cursor]?.depth ?? 0) > parent.depth) cursor += 1
  return cursor
}

/**
 * Reduce one keyboard-driven event. Expansion splices children right below
 * the directory at depth+1 and highlights stays on the directory; collapse
 * removes the whole subtree and keeps highlight on the collapsed directory.
 */
export function reducePicker(state: PickerState, event: PickerEvent): PickerState {
  switch (event.type) {
    case 'highlight-next': {
      if (state.items.length === 0) return state
      const next = Math.min(state.highlight + 1, state.items.length - 1)
      return next === state.highlight ? state : { ...state, highlight: next }
    }
    case 'highlight-previous': {
      if (state.items.length === 0) return state
      const previous = Math.max(state.highlight - 1, 0)
      return previous === state.highlight ? state : { ...state, highlight: previous }
    }
    case 'expand': {
      const parentIndex = indexOfHighlightedDirectory(state)
      if (parentIndex === undefined) return state
      const parent = state.items[parentIndex]
      if (parent === undefined) return state
      const insertAt = parentIndex + 1
      const children: PickerItem[] = event.children.map(child => ({
        relativePath: child.relativePath,
        kind: child.kind,
        depth: parent.depth + 1,
      }))
      const items = [
        ...state.items.slice(0, insertAt),
        ...children,
        ...state.items.slice(endOfSubtree(state.items, parentIndex)),
      ]
      return { items, highlight: parentIndex }
    }
    case 'collapse': {
      const parentIndex = indexOfHighlightedDirectory(state)
      if (parentIndex === undefined) return state
      const from = parentIndex + 1
      if (from >= state.items.length) return state
      const items = [...state.items.slice(0, from), ...state.items.slice(endOfSubtree(state.items, parentIndex))]
      return { items, highlight: parentIndex }
    }
    case 'replace-items': {
      return {
        items: pickerItemsFromEntries(event.children),
        highlight: event.children.length > 0 ? 0 : -1,
      }
    }
  }
}

/**
 * Disambiguation display data: when several candidates share a basename, each
 * gets `parentDir · basename`; unique basenames display bare. Returns labels
 * aligned with the input order.
 */
export function disambiguateLabels(
  items: readonly { relativePath: string }[],
): string[] {
  const basenameOf = (path: string): string => path.slice(path.replace(/\\/g, '/').lastIndexOf('/') + 1)
  const counts = new Map<string, number>()
  for (const item of items) {
    const base = basenameOf(item.relativePath)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return items.map((item) => {
    const base = basenameOf(item.relativePath)
    if ((counts.get(base) ?? 0) <= 1) return base
    const normalized = item.relativePath.replace(/\\/g, '/')
    const slash = normalized.lastIndexOf('/')
    const dir = slash > 0 ? normalized.slice(0, slash) : '/'
    return `${dir} · ${base}`
  })
}
