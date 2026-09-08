/**
 * Text decoding helpers for the M3 waterfall (stages 1 and the fallback).
 *
 * The charsets mirror src/detect.ts's text verdicts (utf-8 / utf-16le /
 * utf-16be / gb18030): the sniffed `mime` parameter is the single authority,
 * so decoding can never disagree with what the upload layer reported.
 */

/** Charsets detect.ts can declare in a `text/plain; charset=...` mime. */
export type TextCharset = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'

/**
 * Extract the charset parameter from a mime string; defaults to utf-8.
 * Unknown charset names fail closed to utf-8 (non-fatal decode below turns
 * hostile bytes into replacement characters instead of throwing).
 */
export function charsetOfMime(mime: string): TextCharset {
  const match = /charset=([a-z0-9_-]+)/i.exec(mime)
  const name = (match?.[1] ?? 'utf-8').toLowerCase()
  if (name === 'utf-8' || name === 'utf8') return 'utf-8'
  if (name === 'utf-16le') return 'utf-16le'
  if (name === 'utf-16be') return 'utf-16be'
  if (name === 'gb18030' || name === 'gbk') return 'gb18030'
  return 'utf-8'
}

/** Strip a leading BOM from decoded text (TextDecoder keeps it as \uFEFF). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Decode bytes with a NON-fatal decoder for the given charset. Malformed
 * sequences become U+FFFD — the "best-effort" semantics of stage 1 and of
 * the final fallback. Never throws.
 */
export function decodeBestEffort(bytes: Uint8Array, charset: TextCharset): string {
  try {
    // fatal:false is the TextDecoder default; stated explicitly for clarity.
    const decoder = new TextDecoder(charset, { fatal: false })
    return stripBom(decoder.decode(bytes))
  } catch {
    // An unknown-charset TypeError cannot happen (charsetOfMime whitelists),
    // but the fallback must stay total — degrade to lossy latin1.
    return Buffer.from(bytes).toString('latin1')
  }
}
