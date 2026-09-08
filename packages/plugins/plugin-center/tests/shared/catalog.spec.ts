import { describe, expect, it } from 'vitest'
import {
  paginate,
  searchEntries,
  sortEntries,
  validateCatalogEntry,
  isValidCommit,
  type CatalogEntry,
} from '../../src/shared/catalog.js'

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: 'owner/repo',
    source: 'github',
    owner: 'owner',
    repo: 'repo',
    pinnedCommit: 'a'.repeat(40),
    title: { zh: '标题', en: 'Title' },
    summary: { zh: '摘要', en: 'Summary' },
    category: 'misc',
    evidence: 'installable',
    compat: 'unknown',
    scriptsPolicy: 'none',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('catalog entry validation', () => {
  it('accepts a well-formed github entry', () => {
    expect(validateCatalogEntry(entry({})).ok).toBe(true)
  })

  it('rejects github entries without a 40-hex pinned commit', () => {
    for (const bad of ['main', 'abc', `${'a'.repeat(41)}`, undefined]) {
      const result = validateCatalogEntry(entry({ pinnedCommit: bad as string | undefined }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('untrusted_source')
    }
    expect(isValidCommit('b'.repeat(40))).toBe(true)
    expect(isValidCommit('B'.repeat(40))).toBe(false) // uppercase not accepted
  })

  it('rejects npm entries without packageName/version', () => {
    const result = validateCatalogEntry(entry({ source: 'npm', pinnedCommit: undefined }))
    expect(result.ok).toBe(false)
  })
})

describe('ordering and pagination', () => {
  const items: CatalogEntry[] = [
    entry({ id: 'a/a', evidence: 'discovered', updatedAt: '2026-08-03T00:00:00Z' }),
    entry({ id: 'b/b', evidence: 'recommended', updatedAt: '2026-07-01T00:00:00Z' }),
    entry({ id: 'c/c', evidence: 'installable', compat: 'exact', updatedAt: '2026-01-01T00:00:00Z' }),
  ]

  it('orders recommended first, then exact compat, then recency', () => {
    expect(sortEntries(items).map(e => e.id)).toEqual(['b/b', 'c/c', 'a/a'])
  })

  it('bounds pages and clamps out-of-range requests', () => {
    const many = Array.from({ length: 55 }, (_, i) => entry({ id: `x/${i}` }))
    expect(paginate(many, 1, 24)).toMatchObject({ page: 1, total: 55 })
    expect(paginate(many, 3, 24).items).toHaveLength(7)
    expect(paginate(many, 99, 24).page).toBe(3)
    expect(paginate([], 5, 24)).toMatchObject({ items: [], page: 1, total: 0 })
  })

  it('filters by text, category and recommendation', () => {
    const found = searchEntries(items, { text: '标题' })
    expect(found.length).toBeGreaterThan(0)
    expect(searchEntries(items, { category: 'misc' })).toHaveLength(3)
    expect(searchEntries(items, { category: 'nope' })).toHaveLength(0)
    expect(searchEntries(items, { evidenceOnlyRecommended: true }).map(e => e.id)).toEqual(['b/b'])
  })
})
