/**
 * M5 file console view (P01 §6-E FR-E1/E2/E3): a `conversation.view` tab that
 * aggregates every session's files into one searchable, type-filterable,
 * windowed list, with usage statistics and two-step cleanup actions.
 *
 * Slot facts (verified against host d.ts):
 * - ui-conversation lib/types/client/contract/slots.d.ts:117-121 declares
 *   `'conversation.view': { kind: 'list'; scope: 'session'; owner:
 *   ConvViewOwnerProps }`; the component receives the framework session kit
 *   (`sessionId`) plus the optional inspect handoff, which this view ignores.
 * - Registration mirrors the first-party precedent
 *   (Fork/packages/client/ui-trajectory/src/client/index.ts:43-62):
 *   ctx.slots.inject(name, () => ctx.slots.register({name, id, order, label},
 *   Component)) — label is a thunk so the tab caption follows locale switches
 *   without re-registration.
 *
 * Deliberately NOT implemented: dragging a console row back into the
 * conversation as a mention. The host has no verified drag-out protocol for
 * slot content (the composer's drag pipeline is upload-only), so per plan
 * discipline the feature stays out rather than guessing at DOM events.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { t } from '../i18n.js'
import { formatBytes, injectStylesOnce } from '../util.js'
import type { Lang } from '../util.js'
import {
  fetchConsoleSettings,
  fetchLibrary,
  fetchUsage,
  postCleanup,
} from './api.js'
import { CONSOLE_STYLES } from './styles.js'
import { useI18nLang } from './useLang.js'
import {
  buildRows,
  computeWindow,
  filterEntries,
  flattenLibrary,
  formatTimestamp,
  KIND_FILTERS,
} from './model.js'
import type {
  CleanupReportShape,
  ConsoleEntry,
  KindFilter,
  LibraryResponse,
  UsageResponse,
} from './model.js'

/** Fixed row height — MUST match .zdsh-filehub-console-row height. */
const ROW_HEIGHT = 28
/** Fixed list viewport height — MUST match .zdsh-filehub-console-list height. */
const LIST_HEIGHT = 300

interface ConsoleKindStyle {
  readonly color: string
}
const KIND_COLORS: Record<string, ConsoleKindStyle> = {
  image: { color: '#4c8dff' },
  document: { color: '#b58cff' },
  text: { color: '#3fbf7f' },
  media: { color: '#ff8a5c' },
  binary: { color: 'rgba(127,127,127,0.8)' },
}

/** Minimal structural props of the conversation.view seat (session kit). */
export interface FileConsoleViewProps {
  readonly sessionId?: string | undefined
}

type SettingsGate =
  | { readonly stage: 'loading' }
  | { readonly stage: 'disabled' }
  | { readonly stage: 'error'; readonly message: string }
  | { readonly stage: 'open'; readonly defaultView: 'grouped' | 'flat' }

type CleanupStage =
  | { readonly phase: 'idle' }
  | { readonly phase: 'busy' }
  | { readonly phase: 'confirm'; readonly scope: 'expired' | 'session'; readonly report: CleanupReportShape }
  | { readonly phase: 'done'; readonly message: string }
  | { readonly phase: 'failed'; readonly message: string }

/**
 * The Files tab body. Renders nothing until its settings gate resolves — a
 * disabled feature costs zero layout (FR-E5 degradation contract).
 */
export function FileConsoleView(props: FileConsoleViewProps): ReactNode {
  const lang: Lang = useI18nLang()
  const [gate, setGate] = useState<SettingsGate>({ stage: 'loading' })
  const [library, setLibrary] = useState<LibraryResponse | null>(null)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<KindFilter>('all')
  const [scrollTop, setScrollTop] = useState(0)
  const [selected, setSelected] = useState<ConsoleEntry | null>(null)
  const [copied, setCopied] = useState(false)
  const [cleanup, setCleanup] = useState<CleanupStage>({ phase: 'idle' })
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    injectStylesOnce('zdsh-filehub-console-styles', CONSOLE_STYLES)
  }, [])

  const loadData = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      const [libraryResult, usageResult] = await Promise.all([fetchLibrary(), fetchUsage()])
      setLibrary(libraryResult)
      setUsage(usageResult)
    } catch (error: unknown) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  // Settings gate first; only an enabled feature loads data.
  useEffect(() => {
    // Holder object defeats literal narrowing of the cancellation flag.
    const state = { cancelled: false }
    void (async () => {
      try {
        const settings = await fetchConsoleSettings()
        if (state.cancelled) return
        if (!settings.enabled) {
          setGate({ stage: 'disabled' })
          return
        }
        setGate({ stage: 'open', defaultView: settings['console.defaultView'] })
      } catch (error: unknown) {
        if (!state.cancelled) {
          setGate({ stage: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      }
    })()
    return () => {
      state.cancelled = true
    }
  }, [])

  useEffect(() => {
    if (gate.stage === 'open') void loadData()
  }, [gate.stage, loadData])

  const grouped = gate.stage === 'open' ? gate.defaultView === 'grouped' : true

  const rows = useMemo(() => {
    if (!library) return []
    return buildRows(filterEntries(flattenLibrary(library), query, filter), grouped)
  }, [library, query, filter, grouped])

  const window_ = computeWindow(rows.length, scrollTop, LIST_HEIGHT, ROW_HEIGHT)
  const visible = rows.slice(window_.start, window_.end)

  const startCleanup = useCallback(async (scope: 'expired' | 'session') => {
    setCleanup({ phase: 'busy' })
    try {
      const report = await postCleanup({
        scope,
        ...(scope === 'session' && props.sessionId ? { sessionId: props.sessionId } : {}),
        dryRun: true,
      })
      setCleanup({ phase: 'confirm', scope, report })
    } catch (error: unknown) {
      setCleanup({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [props.sessionId])

  const executeCleanup = useCallback(async () => {
    if (cleanup.phase !== 'confirm') return
    const { scope } = cleanup
    setCleanup({ phase: 'busy' })
    try {
      const report = await postCleanup({
        scope,
        ...(scope === 'session' && props.sessionId ? { sessionId: props.sessionId } : {}),
        dryRun: false,
      })
      setCleanup({
        phase: 'done',
        message: t('console.cleanup.done', {
          count: report.deleted,
          size: formatBytes(report.freedBytes),
        }),
      })
      await loadData()
    } catch (error: unknown) {
      setCleanup({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }, [cleanup, props.sessionId, loadData])

  if (gate.stage === 'loading' || gate.stage === 'disabled') return null
  if (gate.stage === 'error') {
    return (
      <div className="zdsh-filehub-console">
        <div className="zdsh-filehub-console-error">
          {t('console.error.load', { message: gate.message })}
        </div>
      </div>
    )
  }

  const copyPath = async (): Promise<void> => {
    if (!selected) return
    // Locally-widened clipboard face: jsdom and older browsers may omit it.
    type ClipboardFace = { writeText(text: string): Promise<void> }
    const clipboard = (navigator as Omit<Navigator, 'clipboard'> & { clipboard?: ClipboardFace }).clipboard
    try {
      if (clipboard === undefined) return
      await clipboard.writeText(selected.path)
      setCopied(true)
      setTimeout(() =>{  setCopied(false) }, 1500)
    } catch {
      // Clipboard denied: leave the path visible for manual selection.
    }
  }

  return (
    <div className="zdsh-filehub-console" data-testid="zdsh-filehub-console">
      <div className="zdsh-filehub-console-bar">
        <span style={{ fontWeight: 600 }}>{t('console.title')}</span>
        <span className="zdsh-filehub-console-stats">
          {usage !== null
            ? t('console.stats.summary', { files: usage.files, size: formatBytes(usage.totalBytes) })
            : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="zdsh-filehub-btn" onClick={() => void loadData()}>
          {t('console.refresh')}
        </button>
      </div>

      <div className="zdsh-filehub-console-bar">
        <input
          type="search"
          className="zdsh-filehub-console-search"
          placeholder={t('console.search.placeholder')}
          value={query}
          onChange={(event) =>{  setQuery(event.target.value) }}
        />
        {KIND_FILTERS.map(kind => (
          <button
            key={kind}
            type="button"
            className="zdsh-filehub-chip"
            aria-pressed={filter === kind}
            onClick={() =>{  setFilter(kind) }}
          >
            {t(kind === 'all' ? 'console.filter.all' : `console.filter.${kind}`)}
          </button>
        ))}
      </div>

      {library?.truncated ? (
        <div className="zdsh-filehub-console-note">
          {t('console.truncated', { limit: 2000 })}
        </div>
      ) : null}
      {loadError !== null ? (
        <>
          <div className="zdsh-filehub-console-error">{t('console.error.load', { message: loadError })}</div>
          <button type="button" className="zdsh-filehub-btn" onClick={() => void loadData()}>
            {t('console.retry')}
          </button>
        </>
      ) : null}

      {cleanup.phase === 'confirm' ? (
        <div className="zdsh-filehub-confirmcard" data-testid="zdsh-filehub-cleanup-confirm">
          <strong>{t('console.cleanup.confirmTitle')}</strong>
          <span>
            {t('console.cleanup.dryRun', {
              count: cleanup.report.wouldDelete,
              size: formatBytes(cleanup.report.wouldFreeBytes),
            })}
          </span>
          <button type="button" className="zdsh-filehub-btn" onClick={() => void executeCleanup()}>
            {t('console.cleanup.execute')}
          </button>
          <button type="button" className="zdsh-filehub-btn" onClick={() =>{  setCleanup({ phase: 'idle' }) }}>
            {t('console.cleanup.cancel')}
          </button>
        </div>
      ) : null}
      {cleanup.phase === 'done' ? (
        <div className="zdsh-filehub-console-note">{cleanup.message}</div>
      ) : null}
      {cleanup.phase === 'failed' ? (
        <div className="zdsh-filehub-console-error">
          {t('console.cleanup.failed', { message: cleanup.message })}
        </div>
      ) : null}

      <div
        ref={listRef}
        className="zdsh-filehub-console-list"
        onScroll={(event) =>{  setScrollTop((event.target as HTMLDivElement).scrollTop) }}
        role="listbox"
        aria-label={t('console.title')}
      >
        <div style={{ height: window_.padTop }} />
        {rows.length === 0 && library !== null && loadError === null ? (
          <div className="zdsh-filehub-console-note" style={{ padding: '10px 8px' }}>
            {t('console.empty')}
          </div>
        ) : null}
        {visible.map((row, offset) => {
          const index = window_.start + offset
          if (row.type === 'header') {
            return (
              <div
                key={`h:${row.sessionId}:${index}`}
                role="presentation"
                className="zdsh-filehub-console-row zdsh-filehub-console-rowheader"
                style={{ top: index * ROW_HEIGHT }}
              >
                <span className="zdsh-filehub-entryname">
                  {row.sessionId} · {row.count} · {formatBytes(row.bytes)}
                </span>
              </div>
            )
          }
          const entry = row.entry
          const isSelected = selected !== null && selected.path === entry.path
          return (
            <div
              key={`${entry.sessionId}:${entry.relativePath}`}
              role="option"
              aria-selected={isSelected}
              tabIndex={0}
              className="zdsh-filehub-console-row"
              style={{ top: index * ROW_HEIGHT }}
              onClick={() => {
                setSelected(entry)
                setCopied(false)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelected(entry)
                  setCopied(false)
                }
              }}
            >
              <span className="zdsh-filehub-kinddot" style={KIND_COLORS[entry.kind]} />
              <span className="zdsh-filehub-entryname">{entry.name}</span>
              <span className="zdsh-filehub-entrymeta">{entry.sessionId}</span>
              <span className="zdsh-filehub-entrymeta">{formatTimestamp(entry.uploadedAtMs, lang)}</span>
              <span className="zdsh-filehub-entrymeta">{formatBytes(entry.sizeBytes)}</span>
            </div>
          )
        })}
        <div style={{ height: window_.padBottom }} />
      </div>

      {selected !== null ? (
        <div className="zdsh-filehub-console-detail" data-testid="zdsh-filehub-entry-detail">
          <div className="zdsh-filehub-console-detailpath">{selected.path}</div>
          <div className="zdsh-filehub-console-bar">
            <span>{t('console.detail.kind')}: {t(`console.filter.${selected.kind}`)}</span>
            <span>{t('console.detail.size')}: {formatBytes(selected.sizeBytes)}</span>
            <span>{t('console.detail.time')}: {formatTimestamp(selected.uploadedAtMs, lang)}</span>
            <span style={{ flex: 1 }} />
            <button type="button" className="zdsh-filehub-btn" onClick={() => void copyPath()}>
              {copied ? t('console.detail.copied') : t('console.detail.copy')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="zdsh-filehub-console-bar">
        <button
          type="button"
          className="zdsh-filehub-btn"
          disabled={cleanup.phase === 'busy'}
          onClick={() => void startCleanup('expired')}
        >
          {cleanup.phase === 'busy' ? t('console.cleanup.working') : t('console.cleanup.expired')}
        </button>
        <button
          type="button"
          className="zdsh-filehub-btn"
          disabled={props.sessionId === undefined || cleanup.phase === 'busy'}
          onClick={
            props.sessionId
              ? () => void startCleanup('session')
              : undefined
          }
        >
          {t('console.cleanup.session')}
        </button>
      </div>
    </div>
  )
}
