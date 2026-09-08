/**
 * Search transport for the @ picker: debounced GET /api/filehub/search with
 * latest-wins cancellation, plus the local filter/rank refinement applied on
 * top of the server ordering (spec FR-B6: 防抖拉取 + 本地过滤排序).
 */

/** Structural FileEntry as served by /api/filehub/search. */
export interface SearchEntry {
  readonly path: string
  readonly relativePath: string
  readonly sizeBytes: number
  readonly kind: 'file' | 'directory'
  readonly uploadedAtMs?: number | undefined
}

export interface SearchResponse {
  readonly sessionId: string
  readonly entries: readonly SearchEntry[]
  readonly truncated: boolean
}

/** Fetch one search page; injectable in tests. */
export type SearchFetcher = (
  sessionId: string,
  query: string,
  signal: AbortSignal,
) => Promise<SearchResponse>

export function makeHttpSearchFetcher(): SearchFetcher {
  return async (sessionId, query, signal) => {
    const url = `/api/filehub/search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(query)}`
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`filehub search failed: HTTP ${response.status}`)
    return (await response.json()) as SearchResponse
  }
}

/**
 * Local refinement over the server page: keep entries whose basename or path
 * still contains the query (server already ranked them; we only drop obvious
 * misses caused by the debounce window lagging fast typing).
 */
export function refineEntries(
  entries: readonly SearchEntry[],
  query: string,
): SearchEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...entries]
  return entries.filter((entry) => {
    const normalized = entry.relativePath.toLowerCase()
    const slash = normalized.lastIndexOf('/')
    const base = normalized.slice(slash + 1)
    return base.includes(q) || normalized.includes(q)
  })
}

interface PendingCall {
  resolve: (entries: readonly SearchEntry[]) => void
  reject: (cause: unknown) => void
}

/**
 * Trailing-debounce wrapper: at most one wire request per delayMs window;
 * every caller of a collapsed window shares the newest result. Latest query
 * wins; earlier callers of the same window resolve with its result (they were
 * rendering the same menu).
 */
export function createDebouncedSearch(
  fetcher: SearchFetcher,
  sessionId: () => string | null,
  delayMs = 120,
): (query: string, signal: AbortSignal) => Promise<readonly SearchEntry[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let waiters: PendingCall[] = []
  let controller: AbortController | undefined

  const flush = (query: string): void => {
    const currentWaiters = waiters
    waiters = []
    const id = sessionId()
    if (id === null || id === '') {
      for (const waiter of currentWaiters) waiter.reject(new Error('session-missing'))
      return
    }
    controller?.abort()
    const localController = new AbortController()
    controller = localController
    fetcher(id, query, localController.signal)
      .then((response) => {
        if (localController.signal.aborted) return
        for (const waiter of currentWaiters) waiter.resolve(refineEntries(response.entries, query))
      })
      .catch((cause: unknown) => {
        if (localController.signal.aborted) return
        for (const waiter of currentWaiters) waiter.reject(cause)
      })
  }

  return (query, signal) =>
    new Promise<readonly SearchEntry[]>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      waiters.push({ resolve, reject })
      signal.addEventListener('abort', () =>{  reject(new Error('aborted')) }, { once: true })
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() =>{  flush(query) }, Math.max(0, delayMs))
      if (typeof timer.unref === 'function') timer.unref()
    })
}
