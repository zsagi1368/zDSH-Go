/**
 * Client mention grammar tests: draft token scanning aligned with the host
 * word-initial `@` rule, formatMentionToken parity with host formatFileMention
 * examples, and exact-occurrence removal.
 */
import { describe, expect, it } from 'vitest'

import { formatMentionToken, removeDraftRange, scanDraftTokens } from '../../src/client/mention/grammar.js'

describe('scanDraftTokens', () => {
  it('matches word-initial tokens and reports spans', () => {
    const tokens = scanDraftTokens('check @src/app.ts please')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ value: 'src/app.ts', quoted: false, start: 6, end: 17 })
  })

  it('never triggers inside an email address', () => {
    expect(scanDraftTokens('user@example.com stays inert')).toEqual([])
  })

  it('scans quoted tokens with spaces', () => {
    const tokens = scanDraftTokens('@"docs/my notes.md" end')
    expect(tokens[0]).toMatchObject({ value: 'docs/my notes.md', quoted: true })
    expect(tokens[0]!.raw).toBe('@"docs/my notes.md"')
  })

  it('ignores unterminated quotes', () => {
    expect(scanDraftTokens('@"oops')).toEqual([])
  })

  it('handles multiple occurrences with independent spans', () => {
    const tokens = scanDraftTokens('@a @b @a')
    expect(tokens.map(token => token.value)).toEqual(['a', 'b', 'a'])
  })
})

describe('formatMentionToken (host formatFileMention parity)', () => {
  // Parity anchors from Fork/packages/context/file-reference-local/tests/search.spec.ts:64-73.
  it('formats files plain and directories with a trailing slash', () => {
    expect(formatMentionToken('src/index.ts', 'file')).toBe('@src/index.ts')
    expect(formatMentionToken('src', 'directory')).toBe('@src/')
  })

  it('quotes paths containing whitespace', () => {
    expect(formatMentionToken('docs/design notes.md', 'file')).toBe('@"docs/design notes.md"')
    expect(formatMentionToken('docs/design notes', 'directory')).toBe('@"docs/design notes/')
  })

  it('preserves an explicitly opened quote', () => {
    expect(formatMentionToken('README.md', 'file', true)).toBe('@"README.md"')
  })

  it('refuses control characters and embedded quotes', () => {
    expect(formatMentionToken('bad\nname', 'file')).toBeUndefined()
    expect(formatMentionToken('bad "name".md', 'file')).toBeUndefined()
  })
})

describe('removeDraftRange', () => {
  it('removes exactly one occurrence span', () => {
    const draft = 'look @a.md and @b.md'
    const [token] = scanDraftTokens(draft)
    expect(removeDraftRange(draft, token!.start, token!.end)).toBe('look  and @b.md')
  })

  it('is a no-op outside valid bounds', () => {
    expect(removeDraftRange('abc', -1, 2)).toBe('abc')
    expect(removeDraftRange('abc', 2, 2)).toBe('abc')
    expect(removeDraftRange('abc', 1, 9)).toBe('abc')
  })

  it('deletes the second occurrence precisely when asked', () => {
    const draft = '@a then @a'
    const tokens = scanDraftTokens(draft)
    const second = tokens[1]
    expect(removeDraftRange(draft, second!.start, second!.end)).toBe('@a then ')
  })
})
