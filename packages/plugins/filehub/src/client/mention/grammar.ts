/**
 * Client-side @token grammar, aligned byte-for-byte with the host
 * `@deepseek-ai/dsh-file-reference/grammar` (verified:
 * Fork/packages/context/file-reference/src/grammar.ts:26-55) and with the
 * server-side scanner in src/server/mention.ts (mirrored unit tests pin both).
 *
 * Kept dependency-free so the client bundle carries no host runtime import.
 */

/** One scanned @token occurrence inside draft text. */
export interface DraftToken {
  /** Raw text as typed, e.g. `@"docs/my notes.md"`. */
  readonly raw: string
  /** Path value after `@` (quotes stripped on the quoted form). */
  readonly value: string
  readonly quoted: boolean
  /** Half-open [start, end) span of raw within the text. */
  readonly start: number
  readonly end: number
}

function isSpaceChar(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char)
}

/**
 * Word-initial @tokens only: an `@` glued to the previous word (email
 * addresses) never triggers. Handles the quoted form for paths containing
 * whitespace; unterminated quotes are ignored entirely.
 */
export function scanDraftTokens(text: string): DraftToken[] {
  const tokens: DraftToken[] = []
  let index = 0
  while (index < text.length) {
    const atWordBoundary = index === 0 || isSpaceChar(text[index - 1])
    if (text[index] !== '@' || !atWordBoundary) {
      index += 1
      continue
    }
    if (text[index + 1] === '"') {
      const close = text.indexOf('"', index + 2)
      if (close > index + 2) {
        const value = text.slice(index + 2, close)
        tokens.push({ raw: text.slice(index, close + 1), value, quoted: true, start: index, end: close + 1 })
        index = close + 1
        continue
      }
      break
    }
    let cursor = index + 1
    while (cursor < text.length && !isSpaceChar(text[cursor])) cursor += 1
    if (cursor > index + 1) {
      const value = text.slice(index + 1, cursor)
      tokens.push({ raw: text.slice(index, cursor), value, quoted: false, start: index, end: cursor })
    }
    index = cursor
  }
  return tokens
}

/**
 * Format one candidate as insertion text, mirroring host formatFileMention:
 * directories carry a trailing slash; whitespace paths use `@"..."`; control
 * characters or embedded quotes make the path unrepresentable (undefined).
 */
export function formatMentionToken(
  relativePath: string,
  kind: 'file' | 'directory',
  preserveQuote = false,
): string | undefined {
  const pathWithSlash = kind === 'directory' ? `${relativePath}/` : relativePath
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(pathWithSlash)) return undefined
  const quoted = preserveQuote || /\s/u.test(pathWithSlash)
  if (!quoted) return `@${pathWithSlash}`
  return kind === 'directory' ? `@"${pathWithSlash}` : `@"${pathWithSlash}"`
}

/**
 * Remove exactly one occurrence [start, end) from the draft. Pure string cut;
 * surrounding whitespace is left untouched (the user owns spacing).
 */
export function removeDraftRange(draft: string, start: number, end: number): string {
  if (start < 0 || end <= start || end > draft.length) return draft
  return draft.slice(0, start) + draft.slice(end)
}
