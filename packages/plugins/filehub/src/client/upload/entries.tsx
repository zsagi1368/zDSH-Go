/**
 * M1 upload entry surfaces (P01 §6-A FR-A1/A2/A3): the composer tool-row
 * upload button, the full-page drag-and-drop mask (recursive directory
 * traversal through webkitGetAsEntry), and paste-to-upload.
 *
 * All three feed the single shared UploadQueue (P01 §8 UX-1). The component is
 * a conservative slot citizen: it renders only its own content, reads just the
 * framework-standard `sessionId` prop and its own inject face — no owner-share
 * fields, no host-private DOM classes or CSS hooks (styles are self-injected,
 * `zdsh-filehub-` prefixed).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'

import { detectLang, injectStylesOnce } from '../util.js'
import { STYLES } from '../styles.js'
import type { UploadQueue } from './queue.js'

// ---------------------------------------------------------------------------
// Session seam
// ---------------------------------------------------------------------------

let currentSessionId: string | null = null

/**
 * Current conversation id as last reported by a mounted entry component, or
 * null when no session is known. This is the explicit "会话未就绪" seam: when
 * null, enqueues fail loud in the queue instead of silently vanishing.
 *
 * INTEGRATION CHECKPOINT: session-scoped slots receive the framework-resolved
 * `sessionId` standard prop (runtime d.ts merges it into
 * SessionStandardProps), so mounted entries keep this current; if a future
 * host exposes a stronger "current session" API on ctx, resolveSessionId can
 * consult it here without touching call sites.
 */
export function resolveSessionId(): string | null {
  return currentSessionId !== null && currentSessionId !== '' ? currentSessionId : null
}

// ---------------------------------------------------------------------------
// Drag collection (pure, exported for unit tests)
// ---------------------------------------------------------------------------

/** Structural view of DataTransferItem — real instances satisfy it. */
export interface DataTransferItemLike {
  readonly kind: string
  webkitGetAsEntry(): FileSystemEntryLike | null
}

/** Structural view of the file-system entry tree used for directory drops. */
export interface FileSystemEntryLike {
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly name: string
  file?: (successCallback: (file: File) => void, errorCallback?: (error: unknown) => void) => void
  createReader?: () => FileSystemDirectoryReaderLike
}

export interface FileSystemDirectoryReaderLike {
  readEntries: (
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (error: unknown) => void,
  ) => void
}

/** One collected drop/paste/picker item ready for enqueue(). */
export interface DroppedFile {
  readonly file: File
  /** Forward-slash path relative to the drop root; equals file.name for plain files. */
  readonly relativePath: string
}

function entryToFile(entry: FileSystemEntryLike): Promise<File> {
  return new Promise<File>((resolve, reject) => {
    entry.file?.(
      (file) =>{  resolve(file) },
      (error) =>{  reject(error instanceof Error ? error : new Error(`failed to read ${entry.name}`)) },
    )
    // A missing file() callback means an unreadable entry; reject so the
    // subtree fails instead of hanging the whole batch.
    if (!entry.file) reject(new Error(`entry ${entry.name} provides no file accessor`))
  })
}

/**
 * Drain one directory reader. CLASSIC PITFALL (deliberately handled):
 * readEntries returns at most ~100 entries per call and MUST be called
 * repeatedly until it yields an empty array — a single read silently drops
 * everything past the first page.
 */
function readAllEntries(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  const collected: FileSystemEntryLike[] = []
  return new Promise<FileSystemEntryLike[]>((resolve, reject) => {
    const readPage = (): void => {
      reader.readEntries(
        (page) => {
          if (page.length === 0) {
            resolve(collected)
            return
          }
          collected.push(...page)
          readPage()
        },
        (error) =>{  reject(error instanceof Error ? error : new Error('readEntries failed')) },
      )
    }
    readPage()
  })
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string, out: DroppedFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    try {
      const file = await entryToFile(entry)
      out.push({ file, relativePath: `${prefix}${file.name}` })
    } catch {
      // Unreadable single file: skip it, keep the rest of the batch alive.
    }
    return
  }
  if (entry.isDirectory && entry.createReader) {
    let children: FileSystemEntryLike[]
    try {
      children = await readAllEntries(entry.createReader())
    } catch {
      return // Denied/unreadable directory: contribute nothing, never throw.
    }
    const nextPrefix = `${prefix}${entry.name}/`
    await Promise.all(children.map(child => walkEntry(child, nextPrefix, out)))
  }
}

/**
 * Collect files from a drop event's items, preserving folder hierarchy.
 *
 * Falls back to `fallbackFiles` (the event's dataTransfer.files, using
 * webkitRelativePath when present) only when the entry API yields nothing —
 * browsers without webkitGetAsEntry still get plain-file support.
 *
 * Never rejects: unreadable subtrees are skipped so one bad entry cannot kill
 * a whole drop batch.
 */
export async function collectFromDataTransfer(
  items: ArrayLike<DataTransferItemLike>,
  fallbackFiles?: ArrayLike<File>,
): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  const roots: FileSystemEntryLike[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item || item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry) roots.push(entry)
  }
  if (roots.length > 0) {
    await Promise.all(roots.map(root => walkEntry(root, '', out)))
    if (out.length > 0) return out
  }
  if (fallbackFiles) {
    for (let index = 0; index < fallbackFiles.length; index += 1) {
      const file = fallbackFiles[index]
      if (!file) continue
      const webkitRelative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
      out.push({ file, relativePath: webkitRelative && webkitRelative !== '' ? webkitRelative.replace(/\\/g, '/') : file.name })
    }
  }
  return out
}

/** True when a drag carries files (not text/URI selections). */
function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  if (!types) return false
  for (let index = 0; index < types.length; index += 1) {
    if (types[index] === 'Files') return true
  }
  return false
}

async function collectFromDragEvent(event: DragEvent): Promise<DroppedFile[]> {
  const transfer = event.dataTransfer
  if (!transfer) return []
  // Snapshot by index: DataTransferItemList mutates during access after drop.
  // Array.from walks the list's length (array-like), so partial lists are safe.
  const snapshot: DataTransferItemLike[] = Array.from(transfer.items)
  const fallback = Array.from(transfer.files)
  return collectFromDataTransfer(snapshot, fallback)
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

/**
 * Props of both M1 slot components. Deliberately minimal: `queue` comes from
 * the registrant's own inject face, `sessionId` from the framework standard
 * kit. INTEGRATION CHECKPOINT: if slot prop composition changes, only these
 * two fields need re-verifying against the runtime d.ts.
 */
export interface FileHubSurfaceProps {
  readonly sessionId?: string | undefined
  readonly queue: UploadQueue
}

// ---------------------------------------------------------------------------
// The composer tool-row entry (button + document-wide drag mask + paste)
// ---------------------------------------------------------------------------

export function UploadEntries(props: FileHubSurfaceProps): ReactNode {
  const { sessionId, queue } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragActive, setDragActive] = useState(false)

  // Keep the module-level session seam current while any entry is mounted.
  useEffect(() => {
    currentSessionId = sessionId ?? null
    return () => {
      currentSessionId = null
    }
  }, [sessionId])

  const enqueueDropped = useCallback(
    (dropped: readonly DroppedFile[]): void => {
      if (dropped.length === 0) return
      queue.enqueue(dropped.map(entry => ({ file: entry.file, relativePath: entry.relativePath })))
    },
    [queue],
  )

  // Document-level drag lifecycle. dragenter/dragover must preventDefault to
  // allow dropping; the depth counter survives child enter/leave flicker.
  useEffect(() => {
    let depth = 0
    const onDragEnter = (event: DragEvent): void => {
      if (!dragHasFiles(event)) return
      event.preventDefault()
      depth += 1
      setDragActive(true)
    }
    const onDragOver = (event: DragEvent): void => {
      if (!dragHasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (event: DragEvent): void => {
      if (!dragHasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragActive(false)
    }
    const onDrop = (event: DragEvent): void => {
      if (!dragHasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragActive(false)
      void collectFromDragEvent(event).then(enqueueDropped)
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [enqueueDropped])

  // Paste-to-upload: every clipboard file enters the queue, non-image files
  // included (FR-A3). The host's own image-paste draft pipeline stays
  // untouched — this channel uploads into the session workspace only.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const files = event.clipboardData?.files
      if (!files || files.length === 0) return
      const dropped: DroppedFile[] = []
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (file) dropped.push({ file, relativePath: file.name })
      }
      enqueueDropped(dropped)
    }
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('paste', onPaste)
    }
  }, [enqueueDropped])

  useEffect(() => {
    injectStylesOnce('zdsh-filehub-styles', STYLES)
  }, [])

  const openPicker = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const onPickerChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const files = event.target.files
      const dropped: DroppedFile[] = []
      if (files) {
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]
          if (file) dropped.push({ file, relativePath: file.name })
        }
      }
      enqueueDropped(dropped)
      event.target.value = ''
    },
    [enqueueDropped],
  )

  const lang = useLang()

  return (
    <>
      <button
        type="button"
        className="zdsh-filehub-btn"
        title={lang === 'zh' ? '上传文件到会话工作区' : 'Upload files to the session workspace'}
        onClick={openPicker}
      >
        <svg className="zdsh-filehub-btn-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 10.5 4.5 7h2V2h3v5h2L8 10.5Z" fill="currentColor" />
          <path d="M2.5 12h11v2h-11v-2Z" fill="currentColor" />
        </svg>
        <span>{lang === 'zh' ? '上传' : 'Upload'}</span>
      </button>
      <input ref={inputRef} type="file" multiple className="zdsh-filehub-hidden-input" onChange={onPickerChange} />
      {dragActive ? (
        <div className="zdsh-filehub-mask" data-testid="zdsh-filehub-drop-mask">
          <div className="zdsh-filehub-mask-card">
            <div className="zdsh-filehub-mask-title">{lang === 'zh' ? '释放以上传' : 'Drop to upload'}</div>
            <div className="zdsh-filehub-mask-sub">
              {lang === 'zh' ? '文件与整个文件夹都会进入上传队列' : 'Files and whole folders join the upload queue'}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** Language hook: navigator locale read once per component mount. */
export function useLang(): 'zh' | 'en' {
  const [lang] = useState(() => detectLang())
  return lang
}
