/**
 * M1 upload queue dock (P01 §6-A FR-A6/FR-A10): one row per queued file —
 * type badge, name, size, progress bar, status, retry and remove. Done rows
 * remove through the server's idempotent DELETE before dropping the row
 * (FR-A9: 204 even when already gone).
 *
 * Conservative slot citizen like the entries component: renders nothing while
 * the queue is empty (the dock strip stays layout-free), reads only its own
 * inject face plus the framework-standard props it ignores.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import { formatBytes, injectStylesOnce } from '../util.js'
import type { Lang } from '../util.js'
import { STYLES } from '../styles.js'
import { t } from '../i18n.js'
import { UPLOAD_ERROR_MESSAGES } from './queue.js'
import type { UploadQueue, UploadQueueItem } from './queue.js'
import { useLang } from './entries.js'

/** Default DELETE against the plugin wire API; injectable for tests. */
export async function deleteUploadedFile(path: string): Promise<void> {
  const response = await fetch(`/api/filehub/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 204) {
    throw new Error(`delete failed with HTTP ${response.status}`)
  }
}

const STATUS_LABELS: Readonly<Record<UploadQueueItem['status'], { en: string; zh: string }>> = {
  pending: { en: 'Queued', zh: '排队中' },
  uploading: { en: 'Uploading', zh: '上传中' },
  done: { en: 'Done', zh: '已完成' },
  error: { en: 'Failed', zh: '失败' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
}

function extensionBadge(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1) : ''
  return (ext.length > 0 && ext.length <= 5 ? ext : 'file').toUpperCase()
}

function percentOf(item: UploadQueueItem): number {
  if (item.status === 'done') return 100
  if (item.sizeBytes <= 0) return 0
  return Math.min(100, Math.round((item.sentBytes / item.sizeBytes) * 100))
}

export interface FileHubDockProps {
  readonly sessionId?: string | undefined
  readonly queue: UploadQueue
  /** Override the DELETE call (tests). */
  readonly onDeleteUploaded?: ((path: string) => Promise<void>) | undefined
}

export function FileHubDock(props: FileHubDockProps): ReactNode {
  const { queue, onDeleteUploaded } = props
  const lang: Lang = useLang()
  const items = useSyncExternalStore(
    useCallback((listener: () => void) => queue.subscribe(listener), [queue]),
    () => queue.getItems(),
    () => queue.getItems(),
  )
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [deleteErrors, setDeleteErrors] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    injectStylesOnce('zdsh-filehub-styles', STYLES)
  }, [])

  const removeRow = useCallback(
    (id: string): void => {
      queue.remove(id)
    },
    [queue],
  )

  /** Done rows must hit the server DELETE before leaving the list. */
  const removeUploaded = useCallback(
    (item: UploadQueueItem): void => {
      const path = item.result?.path
      if (!path) {
        removeRow(item.id)
        return
      }
      setDeletingIds(previous => new Set(previous).add(item.id))
      setDeleteErrors((previous) => {
        if (!(item.id in previous)) return previous
        const { [item.id]: _removed, ...next } = previous
        return next
      })
      const deleter = onDeleteUploaded ?? deleteUploadedFile
      deleter(path)
        .then(() =>{  removeRow(item.id) })
        .catch(() => {
          setDeletingIds((previous) => {
            const next = new Set(previous)
            next.delete(item.id)
            return next
          })
          setDeleteErrors(previous => ({
            ...previous,
            [item.id]: lang === 'zh' ? '删除失败，可重试' : 'Delete failed; try again',
          }))
        })
    },
    [lang, onDeleteUploaded, removeRow],
  )

  const retryItem = useCallback(
    (id: string): void => {
      queue.retry(id)
    },
    [queue],
  )

  if (items.length === 0) return null

  return (
    <div className="zdsh-filehub-dock" data-testid="zdsh-filehub-dock">
      {items.map(item => (
        <DockRow
          key={item.id}
          item={item}
          lang={lang}
          deleting={deletingIds.has(item.id)}
          deleteError={deleteErrors[item.id]}
          onRetry={retryItem}
          onRemove={removeRow}
          onRemoveUploaded={removeUploaded}
        />
      ))}
    </div>
  )
}

interface DockRowProps {
  readonly item: UploadQueueItem
  readonly lang: Lang
  readonly deleting: boolean
  readonly deleteError: string | undefined
  readonly onRetry: (id: string) => void
  readonly onRemove: (id: string) => void
  readonly onRemoveUploaded: (item: UploadQueueItem) => void
}

/**
 * M4 vision badge source: the upload contract carries an optional
 * `imageCaption` on image uploads (src/contract.ts UploadResultSchema). The
 * generic queue parser currently forwards only the four core fields, so this
 * reads the field defensively — the badge lights up the moment the passthrough
 * lands, and stays absent otherwise (never claims a caption that isn't there).
 */
interface CaptionedUploadResult {
  readonly sniffedType: string
  readonly imageCaption?: string | undefined
}

function captionOf(item: UploadQueueItem): string | undefined {
  const result = item.result as Partial<CaptionedUploadResult> | undefined
  const caption = result?.imageCaption
  return typeof caption === 'string' && caption.length > 0 ? caption : undefined
}

function DockRow(props: DockRowProps): ReactNode {
  const { item, lang, deleting, deleteError, onRetry, onRemove, onRemoveUploaded } = props
  const statusLabel = STATUS_LABELS[item.status][lang]
  const percent = percentOf(item)
  // Server-authoritative sniffed type wins over the name-derived badge.
  const badgeSource = item.result?.sniffedType ?? ''
  const badge =
    badgeSource !== '' ? badgeSource.slice(badgeSource.indexOf('/') + 1).toUpperCase().slice(0, 5) : extensionBadge(item.name)
  const errorText = item.error ? UPLOAD_ERROR_MESSAGES[item.error.code][lang] : undefined
  const caption = item.status === 'done' ? captionOf(item) : undefined

  return (
    <div className="zdsh-filehub-row" data-status={item.status}>
      <span className="zdsh-filehub-badge">{badge}</span>
      <span className="zdsh-filehub-name" title={item.relativePath !== '' ? item.relativePath : item.name}>
        {item.name}
      </span>
      <span className="zdsh-filehub-size">{formatBytes(item.status === 'done' ? item.sizeBytes : Math.max(item.sentBytes, 0))}</span>
      {caption ? (
        <span className="zdsh-filehub-explained" title={caption}>
          {t('dock.explained')}
        </span>
      ) : null}
      {item.status === 'uploading' || item.status === 'pending' ? (
        <span
          className="zdsh-filehub-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span className="zdsh-filehub-bar-fill" style={{ width: `${percent}%` }} />
        </span>
      ) : null}
      {errorText ? (
        <span className="zdsh-filehub-error-text" title={errorText}>
          {errorText}
        </span>
      ) : null}
      {deleteError ? (
        <span className="zdsh-filehub-error-text" title={deleteError}>
          {deleteError}
        </span>
      ) : null}
      <span className={`zdsh-filehub-status zdsh-filehub-status--${item.status}`}>{statusLabel}</span>
      <span className="zdsh-filehub-xbtns">
        {(item.status === 'error' && (item.error?.retryable ?? false)) || item.status === 'cancelled' ? (
          <button
            type="button"
            className="zdsh-filehub-xbtn"
            title={lang === 'zh' ? '重试' : 'Retry'}
            onClick={() =>{  onRetry(item.id) }}
          >
            ⟳
          </button>
        ) : null}
        {item.status === 'uploading' ? (
          <button
            type="button"
            className="zdsh-filehub-xbtn"
            title={lang === 'zh' ? '取消' : 'Cancel'}
            onClick={() =>{  onRemove(item.id) }}
          >
            ✕
          </button>
        ) : item.status === 'done' ? (
          <button
            type="button"
            className="zdsh-filehub-xbtn"
            disabled={deleting}
            title={lang === 'zh' ? '从工作区删除' : 'Delete from workspace'}
            onClick={() =>{  onRemoveUploaded(item) }}
          >
            {deleting ? '…' : '✕'}
          </button>
        ) : (
          <button
            type="button"
            className="zdsh-filehub-xbtn"
            title={lang === 'zh' ? '移除' : 'Remove'}
            onClick={() =>{  onRemove(item.id) }}
          >
            ✕
          </button>
        )}
      </span>
    </div>
  )
}
