/**
 * Picker model + candidate pipeline tests (pure): keyboard reduction with
 * ArrowRight directory expansion, basename disambiguation labels, and the
 * debounced search transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDebouncedSearch, refineEntries } from '../../src/client/mention/search.js'
import type { SearchFetcher } from '../../src/client/mention/search.js'
import {
  disambiguateLabels,
  pickerItemsFromEntries,
  reducePicker,
} from '../../src/client/mention/pickerModel.js'
import type { PickerState } from '../../src/client/mention/pickerModel.js'

describe('pickerModel', () => {
  const entries = [
    { relativePath: 'src', kind: 'directory' as const },
    { relativePath: 'src/a.ts', kind: 'file' as const },
    { relativePath: 'README.md', kind: 'file' as const },
  ]

  it('seeds items at depth 0 and clamps highlight moves', () => {
    let state: PickerState = { items: pickerItemsFromEntries(entries), highlight: 0 }
    state = reducePicker(state, { type: 'highlight-next' })
    expect(state.highlight).toBe(1)
    for (let i = 0; i < 10; i += 1) state = reducePicker(state, { type: 'highlight-next' })
    expect(state.highlight).toBe(state.items.length - 1)
    for (let i = 0; i < 10; i += 1) state = reducePicker(state, { type: 'highlight-previous' })
    expect(state.highlight).toBe(0)
  })

  it('expands only directories, splicing children below at depth+1', () => {
    let state: PickerState = { items: pickerItemsFromEntries(entries), highlight: 0 }
    state = reducePicker(state, {
      type: 'expand',
      children: [{ relativePath: 'src/b', kind: 'directory' }],
    })
    expect(state.items.map(item => `${item.depth}:${item.relativePath}`)).toEqual([
      '0:src',
      '1:src/b',
      '0:src/a.ts',
      '0:README.md',
    ])
    // Highlight stays on the expanded directory; ArrowRight on a file is inert.
    expect(state.highlight).toBe(0)
    state = reducePicker({ ...state, highlight: 2 }, { type: 'expand', children: [{ relativePath: 'x', kind: 'file' }] })
    expect(state.items.some(item => item.relativePath === 'x')).toBe(false)
  })

  it('collapses a whole subtree and keeps the directory highlighted', () => {
    let state: PickerState = { items: pickerItemsFromEntries(entries), highlight: 0 }
    state = reducePicker(state, {
      type: 'expand',
      children: [
        { relativePath: 'src/b', kind: 'directory' },
        { relativePath: 'src/b/c.ts', kind: 'file' },
      ],
    })
    state = reducePicker(state, { type: 'collapse' })
    expect(state.items.map(item => item.relativePath)).toEqual(['src', 'src/a.ts', 'README.md'])
    expect(state.highlight).toBe(0)
  })

  it('replace-items reseeds the page and resets the highlight', () => {
    let state: PickerState = { items: pickerItemsFromEntries(entries), highlight: 2 }
    state = reducePicker(state, { type: 'replace-items', children: [{ relativePath: 'only.md', kind: 'file' }] })
    expect(state.items.map(item => item.relativePath)).toEqual(['only.md'])
    expect(state.highlight).toBe(0)
  })

  it('disambiguates duplicate basenames with the parent directory', () => {
    const labels = disambiguateLabels([
      { relativePath: 'pkg-a/index.ts' },
      { relativePath: 'pkg-b/deep/index.ts' },
      { relativePath: 'README.md' },
    ])
    expect(labels[0]).toBe('pkg-a · index.ts')
    expect(labels[1]).toBe('pkg-b/deep · index.ts')
    expect(labels[2]).toBe('README.md')
  })
})

describe('search transport', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refineEntries keeps basename/path hits and drops misses', () => {
    const page = [
      { path: '/w/readme.md', relativePath: 'readme.md', sizeBytes: 0, kind: 'file' as const },
      { path: '/w/src/readme.txt', relativePath: 'src/readme.txt', sizeBytes: 0, kind: 'file' as const },
      { path: '/w/unrelated.bin', relativePath: 'unrelated.bin', sizeBytes: 0, kind: 'file' as const },
    ]
    const refined = refineEntries(page, 'readme')
    expect(refined.map(entry => entry.relativePath)).toEqual(['readme.md', 'src/readme.txt'])
    expect(refineEntries(page, '')).toHaveLength(3)
  })

  it('debounces bursts into one fetch and resolves all waiters with the result', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const fetcher: SearchFetcher = async (_sessionId, query) => {
      calls.push(query)
      return {
        sessionId: 's1',
        entries: [{ path: `/w/${query}.ts`, relativePath: `${query}.ts`, sizeBytes: 0, kind: 'file' }],
        truncated: false,
      }
    }
    const search = createDebouncedSearch(fetcher, () => 's1', 50)
    const first = search('alpha', new AbortController().signal)
    const second = search('beta', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(60)
    expect(calls).toEqual(['beta']) // collapsed to the latest query
    await expect(first).resolves.toEqual([{ path: '/w/beta.ts', relativePath: 'beta.ts', sizeBytes: 0, kind: 'file' }])
    await expect(second).resolves.toHaveLength(1)
  })

  it('fails loud when no session id is available', async () => {
    vi.useFakeTimers()
    const fetcher: SearchFetcher = async () => ({ sessionId: '', entries: [], truncated: false })
    const search = createDebouncedSearch(fetcher, () => null, 10)
    // Attach the rejection handler BEFORE the timer fires so the rejection
    // never lands as an unhandled rejection between ticks.
    const expectation = expect(search('q', new AbortController().signal)).rejects.toThrow('session-missing')
    await vi.advanceTimersByTimeAsync(20)
    await expectation
  })
})
