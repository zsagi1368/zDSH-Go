/**
 * Console pure model: client-side search/kind filtering, grouped vs flat row
 * building, and the virtual-scroll windowing math (first screen, scroll page
 * flips, clamping, degenerate inputs).
 */
import { describe, expect, it } from 'vitest'

import {
  buildRows,
  computeWindow,
  filterEntries,
  flattenLibrary,
  matchesFilter,
} from '../../src/client/console/model.js'
import type { ConsoleEntry, LibraryResponse } from '../../src/client/console/model.js'

function entry(overrides: Partial<ConsoleEntry>): ConsoleEntry {
  return {
    path: `C:/w/.filehub/s/${overrides.name ?? 'file.bin'}`,
    relativePath: overrides.name ?? 'file.bin',
    name: overrides.name ?? 'file.bin',
    sessionId: 's1',
    sizeBytes: 10,
    uploadedAtMs: 1000,
    kind: 'binary',
    ...overrides,
  }
}

const ENTRIES: ConsoleEntry[] = [
  entry({ name: 'alpha.png', kind: 'image', sessionId: 's1', sizeBytes: 5, uploadedAtMs: 300 }),
  entry({ name: 'sub/report.pdf', relativePath: 'sub/report.pdf', kind: 'document', sessionId: 's2', sizeBytes: 7, uploadedAtMs: 900 }),
  entry({ name: 'notes.txt', kind: 'text', sessionId: 's1', sizeBytes: 3, uploadedAtMs: 100 }),
]

describe('filtering', () => {
  it('matches by name and full path, case-insensitively', () => {
    const report = ENTRIES[1]!
    expect(matchesFilter(report, 'REP', 'all')).toBe(true)
    expect(matchesFilter(report, 'sub/', 'all')).toBe(true)
    expect(matchesFilter(report, 'zzz', 'all')).toBe(false)
  })

  it('kind chip excludes other kinds; "all" passes everything', () => {
    expect(ENTRIES.filter(e => matchesFilter(e, '', 'image'))).toHaveLength(1)
    expect(ENTRIES.filter(e => matchesFilter(e, '', 'text')).map(e => e.kind)).toEqual(['text'])
    expect(filterEntries(ENTRIES, '', 'all')).toHaveLength(3)
  })

  it('combines q + chip and sorts newest first', () => {
    const filtered = filterEntries([...ENTRIES].reverse(), '', 'all')
    expect(filtered.map(e => e.uploadedAtMs)).toEqual([900, 300, 100])
    expect(filterEntries(ENTRIES, 'report', 'image')).toHaveLength(0)
    expect(filterEntries(ENTRIES, 'report', 'document')).toHaveLength(1)
  })

  it('flattenLibrary preserves the server session order', () => {
    const response: LibraryResponse = {
      sessions: [
        { sessionId: 'recent', entries: [entry({ name: 'a', sessionId: 'recent' })], totalBytes: 10 },
        { sessionId: 'older', entries: [entry({ name: 'b', sessionId: 'older' })], totalBytes: 10 },
      ],
      totalBytes: 20,
      truncated: false,
    }
    expect(flattenLibrary(response).map(e => e.sessionId)).toEqual(['recent', 'older'])
  })
})

describe('buildRows', () => {
  it('flat mode emits one row per entry', () => {
    const rows = buildRows(ENTRIES, false)
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.type === 'entry')).toBe(true)
  })

  it('grouped mode interleaves headers with correct count/bytes aggregates', () => {
    // Real usage: rows come from filterEntries, which sorts newest-first.
    const rows = buildRows(filterEntries(ENTRIES, '', 'all'), true)
    const headers = rows.filter((row): row is Extract<typeof row, { type: 'header' }> => row.type === 'header')
    expect(headers).toHaveLength(2) // s2 (newest), then s1
    expect(headers[0]).toMatchObject({ sessionId: 's2', count: 1, bytes: 7 })
    expect(headers[1]).toMatchObject({ sessionId: 's1', count: 2, bytes: 8 })
    // First row is a header (group insertion order follows recency).
    expect(rows[0]?.type).toBe('header')
  })
})

describe('computeWindow', () => {
  const ROW_H = 28
  it('renders the first screen plus overscan without scrolling', () => {
    const slice = computeWindow(1000, 0, 280, ROW_H, 6)
    expect(slice.start).toBe(0)
    // ceil(280/28)=10 visible + 12 overscan.
    expect(slice.end).toBe(22)
    expect(slice.padTop).toBe(0)
    expect(slice.padBottom).toBe((1000 - 22) * ROW_H)
  })

  it('flips pages as scrollTop advances and keeps the scrollbar honest', () => {
    const slice = computeWindow(1000, 28 * 100, 280, ROW_H, 6)
    expect(slice.start).toBe(94) // 100 - 6 overscan
    expect(slice.padTop).toBe(slice.start * ROW_H)
    expect(slice.end - slice.start).toBe(22)

    const tail = computeWindow(50, 28 * 49, 280, ROW_H, 6)
    expect(tail.end).toBe(50) // clamped to total
    expect(tail.padBottom).toBe(0)
    expect(tail.padTop + (tail.end - tail.start) * ROW_H + tail.padBottom <= 50 * ROW_H).toBe(true)
  })

  it('degenerates safely on empty lists and hostile geometry', () => {
    expect(computeWindow(0, 0, 280, ROW_H)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 })
    expect(computeWindow(10, 0, 0, ROW_H).end).toBe(0)
    expect(computeWindow(10, 0, 280, 0).end).toBe(0)
    expect(computeWindow(10, -500, 280, ROW_H).start).toBe(0) // negative scroll clamps
    expect(computeWindow(5, 999_999, 280, ROW_H)).toEqual({
      start: 0,
      end: 5,
      padTop: 0,
      padBottom: 0,
    }) // scrollTop beyond content still shows everything
  })
})
