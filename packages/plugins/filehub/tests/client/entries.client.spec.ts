// @vitest-environment jsdom
/**
 * Drag-collection unit tests for the M1 entry surfaces (FR-A2). Covers the
 * webkitGetAsEntry recursive walk including the readEntries-until-empty
 * pagination pitfall, deep nesting, empty directories, unreadable subtrees,
 * and the plain-files fallback for browsers without the entry API.
 */
import { describe, expect, it } from 'vitest'

import {
  collectFromDataTransfer,
} from '../../src/client/upload/entries.js'
import type {
  DataTransferItemLike,
  FileSystemDirectoryReaderLike,
  FileSystemEntryLike,
} from '../../src/client/upload/entries.js'

function makeFile(name: string): File {
  return new File([new Uint8Array(4)], name, { type: 'application/octet-stream' })
}

function fileEntry(name: string): FileSystemEntryLike {
  const file = makeFile(name)
  return { isFile: true, isDirectory: false, name, file: (ok) =>{  ok(file) } }
}

/** Directory entry whose reader yields one page per call (the browser contract: ≤100 per read). */
function dirEntry(
  name: string,
  pages: FileSystemEntryLike[][],
  counter?: { reads: number },
): FileSystemEntryLike {
  let pageIndex = 0
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: (): FileSystemDirectoryReaderLike => ({
      readEntries: (ok) => {
        if (counter !== undefined) counter.reads += 1
        const page = pages[pageIndex] ?? []
        pageIndex += 1
        ok([...page])
      },
    }),
  }
}

function item(entry: FileSystemEntryLike | null, kind = 'file'): DataTransferItemLike {
  return { kind, webkitGetAsEntry: () => entry }
}

function names(dropped: Awaited<ReturnType<typeof collectFromDataTransfer>>): string[] {
  return dropped.map(entry => `${entry.relativePath}:${entry.file.name}`)
}

describe('collectFromDataTransfer', () => {
  it('collects a single dropped file with its name as relative path', async () => {
    const dropped = await collectFromDataTransfer([item(fileEntry('a.txt'))])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.file.name).toBe('a.txt')
    expect(dropped[0]!.relativePath).toBe('a.txt')
  })

  it('drains directory readers until an EMPTY page (the ≤100-per-read pitfall)', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) => fileEntry(`f${String(index).padStart(3, '0')}.txt`))
    const pageTwo = Array.from({ length: 20 }, (_, index) => fileEntry(`g${String(index).padStart(2, '0')}.txt`))
    const counter = { reads: 0 }
    const root = dirEntry('pkg', [pageOne, pageTwo], counter)
    const dropped = await collectFromDataTransfer([item(root)])
    expect(counter.reads).toBe(3) // two non-empty pages + the terminating empty page
    expect(dropped).toHaveLength(120)
    expect(names(dropped)).toContain('pkg/f000.txt:f000.txt')
    expect(names(dropped)).toContain('pkg/g19.txt:g19.txt')
  })

  it('walks deeply nested directories preserving hierarchy', async () => {
    const leaf = dirEntry('c', [[fileEntry('f.txt')]])
    const mid = dirEntry('b', [[leaf]])
    const root = dirEntry('a', [[mid]])
    const dropped = await collectFromDataTransfer([item(root)])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.relativePath).toBe('a/b/c/f.txt')
  })

  it('contributes nothing for empty directories but still terminates', async () => {
    const counter = { reads: 0 }
    const dropped = await collectFromDataTransfer([item(dirEntry('void', [], counter)), item(fileEntry('keep.txt'))])
    expect(counter.reads).toBeGreaterThanOrEqual(1)
    expect(names(dropped)).toEqual(['keep.txt:keep.txt'])
  })

  it('skips unreadable files and denied directories without rejecting the batch', async () => {
    const brokenNoAccessor: FileSystemEntryLike = { isFile: true, isDirectory: false, name: 'nope.bin' }
    const brokenErroring: FileSystemEntryLike = {
      isFile: true,
      isDirectory: false,
      name: 'boom.bin',
      file: (_ok, error) => error?.(new Error('denied')),
    }
    const deniedDir: FileSystemEntryLike = {
      isFile: false,
      isDirectory: true,
      name: 'locked',
      createReader: () => ({
        readEntries: (_ok, error) => error?.(new Error('permission')),
      }),
    }
    const dropped = await collectFromDataTransfer([
      item(brokenNoAccessor),
      item(brokenErroring),
      item(deniedDir),
      item(fileEntry('fine.txt')),
    ])
    expect(names(dropped)).toEqual(['fine.txt:fine.txt'])
  })

  it('ignores non-file items and null entries', async () => {
    const dropped = await collectFromDataTransfer([
      item(fileEntry('real.txt')),
      item(null),
      { kind: 'string', webkitGetAsEntry: () => null },
      { kind: 'string', webkitGetAsEntry: () => fileEntry('ghost.txt') },
    ])
    expect(names(dropped)).toEqual(['real.txt:real.txt'])
  })

  it('falls back to dataTransfer.files when no entry API result exists', async () => {
    const plain = makeFile('plain.txt')
    const withRelative = makeFile('nested.csv') as File & { webkitRelativePath?: string }
    withRelative.webkitRelativePath = 'bundle/nested.csv'
    const dropped = await collectFromDataTransfer([item(null), item(null)], [plain, withRelative])
    expect(names(dropped)).toEqual(['plain.txt:plain.txt', 'bundle/nested.csv:nested.csv'])
  })

  it('prefers entry traversal over the flat fallback when both exist', async () => {
    const fallback = makeFile('flat.txt')
    const dropped = await collectFromDataTransfer([item(fileEntry('entry.txt'))], [fallback])
    expect(names(dropped)).toEqual(['entry.txt:entry.txt'])
  })

  it('collects multiple mixed roots in one pass', async () => {
    const root = dirEntry('docs', [[fileEntry('spec.md')]])
    const dropped = await collectFromDataTransfer([item(fileEntry('top.txt')), item(root), item(fileEntry('end.bin'))])
    expect(dropped).toHaveLength(3)
    expect(new Set(names(dropped))).toEqual(
      new Set(['top.txt:top.txt', 'docs/spec.md:spec.md', 'end.bin:end.bin']),
    )
  })
})
