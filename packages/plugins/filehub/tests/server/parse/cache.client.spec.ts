/**
 * Parse-cache suites: content addressing, in-flight dedupe (one parse shared
 * across same-key concurrency), dual-bound LRU eviction, and version stamping.
 */

import { describe, expect, it } from 'vitest'

import { ParseCache, PARSE_RECORD_VERSION } from '../../../src/server/parse/cache.js'
import type { ParsedDocument } from '../../../src/server/parse/types.js'

let counter = 0
function makeDoc(text: string): ParsedDocument {
  counter += 1
  return { format: 'text', text, overview: { format: 'text' }, warnings: [] }
}

function keyOf(text: string, format = 'mime/text', options = 'probe=0'): string {
  return ParseCache.keyOf(Buffer.from(text, 'utf8'), format, options)
}

describe('ParseCache', () => {
  it('keys on content + format + options (same bytes different options miss)', async () => {
    const cache = new ParseCache()
    let parses = 0
    const compute = async (): Promise<ParsedDocument> => {
      parses += 1
      return makeDoc('body')
    }
    await cache.wrap(keyOf('body'), compute)
    await cache.wrap(keyOf('body'), compute) // same key → hit
    await cache.wrap(keyOf('body', 'mime/text', 'probe=1;sheet=-'), compute) // options differ → miss
    await cache.wrap(keyOf('body', 'application/pdf', 'probe=0'), compute) // format differs → miss
    expect(parses).toBe(3)
    expect(cache.size).toBe(3)
  })

  it('dedupes in-flight parses for the same key into one compute', async () => {
    const cache = new ParseCache()
    let parses = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowCompute = async (): Promise<ParsedDocument> => {
      parses += 1
      await gate
      return makeDoc('shared')
    }
    const first = cache.wrap(keyOf('shared'), slowCompute)
    const second = cache.wrap(keyOf('shared'), slowCompute)
    expect(parses).toBe(1) // second caller joined the in-flight promise
    release?.()
    const [a, b] = await Promise.all([first, second])
    expect(a.text).toBe('shared')
    expect(b).toBe(a) // literally the same document object
    expect(parses).toBe(1)
    // Subsequent call is served from the store.
    await cache.wrap(keyOf('shared'), slowCompute)
    expect(parses).toBe(1)
  })

  it('clears the in-flight tombstone when a parse fails so retries work', async () => {
    const cache = new ParseCache()
    let attempts = 0
    const failing = async (): Promise<ParsedDocument> => {
      attempts += 1
      throw new Error('parser exploded')
    }
    await expect(cache.wrap(keyOf('retry'), failing)).rejects.toThrow('parser exploded')
    await expect(cache.wrap(keyOf('retry'), failing)).rejects.toThrow('parser exploded')
    expect(attempts).toBe(2)
  })

  it('evicts least-recently-used beyond the entry bound', async () => {
    const cache = new ParseCache({ maxEntries: 2 })
    const compute = (): Promise<ParsedDocument> => Promise.resolve(makeDoc('x'))
    await cache.wrap(keyOf('a'), compute)
    await cache.wrap(keyOf('b'), compute)
    await cache.wrap(keyOf('a'), compute) // cache HIT refreshes a's recency → b becomes LRU
    await cache.wrap(keyOf('c'), compute)
    expect(cache.size).toBe(2)
    expect(cache.peek(keyOf('a'))).toBeDefined()
    expect(cache.peek(keyOf('b'))).toBeUndefined()
    expect(cache.peek(keyOf('c'))).toBeDefined()
  })

  it('evicts by total byte bound and refuses oversized singles', async () => {
    // Each doc ~10 chars → ~10 bytes cost; bound 25 fits two, not three.
    const cache = new ParseCache({ maxBytes: 25 })
    const compute = (): Promise<ParsedDocument> => Promise.resolve(makeDoc('0123456789'))
    await cache.wrap(keyOf('first'), compute)
    await cache.wrap(keyOf('second'), compute)
    expect(cache.peek(keyOf('first'))).toBeDefined() // 2×10 ≤ 25 — both fit
    await cache.wrap(keyOf('third'), compute) // 3×10 > 25 → oldest ('first') evicted
    expect(cache.peek(keyOf('first'))).toBeUndefined()
    expect(cache.peek(keyOf('second'))).toBeDefined()
    expect(cache.peek(keyOf('third'))).toBeDefined()
    const hugeCompute = (): Promise<ParsedDocument> => Promise.resolve(makeDoc('y'.repeat(64 * 1024)))
    await cache.wrap(keyOf('huge'), hugeCompute)
    expect(cache.peek(keyOf('huge'))).toBeUndefined() // single doc above budget: not cached
  })

  it('stamps records with the reserved parser-version field', async () => {
    const cache = new ParseCache({ maxEntries: 4 })
    const compute = (): Promise<ParsedDocument> => Promise.resolve(makeDoc('versioned'))
    await cache.wrap(keyOf('versioned'), compute)
    // Version lives on the internal record; observable through a re-hit plus
    // PARSE_RECORD_VERSION being exported for future invalidation bumps.
    const hit = await cache.wrap(keyOf('versioned'), async () => {
      throw new Error('must be served from cache')
    })
    expect(hit.text).toBe('versioned')
    expect(PARSE_RECORD_VERSION).toBe(1)
  })
})
