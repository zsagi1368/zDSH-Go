/**
 * Unified byte-sniffing layer (P01 §6-A). Pure functions, zero dependencies:
 * no fs, no node APIs beyond the standard global `TextDecoder`, so the module
 * is usable from any host surface and trivially unit-testable.
 *
 * Authority order (spec §6-A):
 *   1. magic bytes are authoritative — a known binary signature can never be
 *      "rescued" by a text-looking tail or by the file name hint;
 *   2. BOM declaration wins over the NUL heuristic;
 *   3. without a BOM, NUL presence gates the binary verdict;
 *   4. when UTF-8 decoding fails, a high-frequency GB18030 double-byte ratio
 *      gates the plain-text verdict (mime text/plain; charset=gb18030);
 *   5. the ftyp family is only classified as media when the file-name
 *      extension is on the media whitelist (anti-disguise), otherwise binary.
 */

export type SniffKind = 'image' | 'text' | 'binary' | 'archive' | 'media'

export interface SniffResult {
  /** IANA-ish mime type; text results carry an explicit charset parameter. */
  mime: string
  kind: SniffKind
  /** Stable human-readable descriptor of the detected type. */
  label: string
}

/** How many leading bytes participate in the statistical text analysis. */
const TEXT_SAMPLE_BYTES = 8192

/** How deep into a ZIP container the OOXML entry scan reaches. */
const ZIP_SCAN_BYTES = 64 * 1024

/**
 * Extensions for which an `ftyp`-boxed container may be classified as media.
 * Anything else with an ftyp box stays binary — the box alone proves nothing
 * about the payload being playable (anti-disguise rule).
 */
const MEDIA_FTYP_EXTENSIONS: readonly string[] = [
  'mp4', 'm4v', 'f4v', 'm4a', 'm4b', 'm4p', '3gp', '3g2', 'mj2', 'mov', 'qt',
]

function extensionOf(fileName: string | undefined): string {
  if (!fileName) return ''
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function u32beAt(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  return prefix.every((value, i) => bytes[i] === value)
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]
const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]
const SEVEN_Z_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]
const GZIP_SIGNATURE = [0x1f, 0x8b]

/** DIB header sizes accepted as evidence that "BM…" really is a bitmap. */
const BMP_DIB_SIZES = new Set([12, 16, 40, 52, 56, 64, 84, 108, 124])

function sniffRiff(bytes: Uint8Array): SniffResult | undefined {
  // "RIFF" + u32le size + four-char form type at offset 8.
  if (!asciiAt(bytes, 0, 'RIFF') || bytes.length < 12) return undefined
  const form = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0)
  if (form === 'WEBP') return { mime: 'image/webp', kind: 'image', label: 'WebP image' }
  if (form === 'WAVE') return { mime: 'audio/wav', kind: 'media', label: 'WAV audio' }
  if (form === 'AVI ') return { mime: 'video/x-msvideo', kind: 'media', label: 'AVI video' }
  return { mime: 'application/octet-stream', kind: 'binary', label: 'RIFF binary' }
}

/**
 * Distinguish OOXML packages (docx/xlsx/pptx) from other ZIP containers by
 * scanning local file headers for their characteristic entry prefixes. The
 * central directory lives at the end of large archives, so the scan walks the
 * head of the file where the first entries are stored, bounded by
 * ZIP_SCAN_BYTES.
 */
function sniffZip(bytes: Uint8Array): SniffResult {
  const limit = Math.min(bytes.length, ZIP_SCAN_BYTES)
  let word = false
  let xl = false
  let ppt = false
  for (let i = 0; i + 4 <= limit; i += 1) {
    const lead = bytes[i] ?? 0
    // Compare against correctly-sized windows: 'word' (4), 'xl/' (3), 'ppt/' (4).
    if (lead === 0x77 && asciiAt(bytes, i, 'word')) { word = true; i += 3; continue }
    if (lead === 0x78 && asciiAt(bytes, i, 'xl/')) { xl = true; i += 2; continue }
    if (lead === 0x70 && asciiAt(bytes, i, 'ppt/')) { ppt = true; i += 3; continue }
  }
  if (word) {
    return {
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'archive',
      label: 'Word document (.docx)',
    }
  }
  if (xl) {
    return {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'archive',
      label: 'Excel workbook (.xlsx)',
    }
  }
  if (ppt) {
    return {
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      kind: 'archive',
      label: 'PowerPoint deck (.pptx)',
    }
  }
  return { mime: 'application/zip', kind: 'archive', label: 'ZIP archive' }
}

function sniffFtyp(bytes: Uint8Array, extension: string): SniffResult {
  // Box layout: u32be size then "ftyp" at offsets 4..8, brand at 8..12.
  const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0)
  if (!MEDIA_FTYP_EXTENSIONS.includes(extension)) {
    // Signature matches but the name does not claim to be media → binary.
    return { mime: 'application/octet-stream', kind: 'binary', label: 'ISO-BMFF container' }
  }
  if (brand.startsWith('M4A')) return { mime: 'audio/mp4', kind: 'media', label: 'MPEG-4 audio' }
  if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'media', label: 'QuickTime video' }
  return { mime: 'video/mp4', kind: 'media', label: 'MP4 video' }
}

interface BomInfo {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be'
  length: number
}

function bomOf(bytes: Uint8Array): BomInfo | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', length: 2 }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', length: 2 }
  }
  return undefined
}

/**
 * Ratio of non-ASCII bytes that participate in well-formed GBK-style
 * double-byte pairs (lead 0x81–0xFE, trail 0x40–0x7E or 0x80–0xFE). Used as
 * the "high-frequency double-byte" gate: prose in a Chinese encoding pairs up
 * almost all of its high bytes; random binary data does not.
 */
export function gb18030DoubleByteRatio(sample: Uint8Array): { ratio: number; pairs: number } {
  let paired = 0
  let loneHigh = 0
  let pairs = 0
  const length = sample.length
  let i = 0
  while (i < length) {
    const lead = sample[i] ?? 0
    if (lead < 0x80) {
      i += 1
      continue
    }
    const trail = sample[i + 1] ?? -1
    const validPair =
      lead >= 0x81 && lead <= 0xfe &&
      ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfe))
    if (validPair) {
      paired += 2
      pairs += 1
      i += 2
    } else {
      loneHigh += 1
      i += 1
    }
  }
  const total = paired + loneHigh
  return { ratio: total === 0 ? 0 : paired / total, pairs }
}

/**
 * Decode `bytes` as UTF-8 strictly, tolerating a single truncated character at
 * the very end of the sample (the caller sampled a fixed byte count and may
 * have cut a multi-byte sequence in half — that is not evidence of invalidity).
 */
function decodesAsUtf8(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  if (safeDecode(decoder, bytes)) return true
  for (let drop = 1; drop <= 3 && drop <= bytes.length; drop += 1) {
    if (safeDecode(decoder, bytes.subarray(0, bytes.length - drop))) return true
  }
  return false
}

function safeDecode(decoder: TextDecoder, bytes: Uint8Array): boolean {
  try {
    decoder.decode(bytes)
    return true
  } catch {
    return false
  }
}

function textVerdict(bytes: Uint8Array): SniffResult {
  const sample = bytes.length > TEXT_SAMPLE_BYTES ? bytes.subarray(0, TEXT_SAMPLE_BYTES) : bytes

  // BOM beats the NUL heuristic (spec §6-A): declared encodings are trusted.
  const bom = bomOf(sample)
  if (bom) {
    switch (bom.encoding) {
      case 'utf-8':
        return { mime: 'text/plain; charset=utf-8', kind: 'text', label: 'Plain text (UTF-8)' }
      case 'utf-16le':
        return { mime: 'text/plain; charset=utf-16le', kind: 'text', label: 'Plain text (UTF-16LE)' }
      case 'utf-16be':
        return { mime: 'text/plain; charset=utf-16be', kind: 'text', label: 'Plain text (UTF-16BE)' }
    }
  }

  // No BOM: NUL bytes gate the binary verdict. Plain prose contains none;
  // UTF-16-without-BOM (NUL after every ASCII char) lands here correctly.
  let nuls = 0
  for (const byte of sample) {
    if (byte === 0) nuls += 1
  }
  if (nuls / Math.max(1, sample.length) >= 0.01) {
    return { mime: 'application/octet-stream', kind: 'binary', label: 'Binary data' }
  }

  if (decodesAsUtf8(sample)) {
    return { mime: 'text/plain; charset=utf-8', kind: 'text', label: 'Plain text (UTF-8)' }
  }

  // UTF-8 failed: gate on GB18030 double-byte frequency.
  const gb = gb18030DoubleByteRatio(sample)
  if (gb.pairs >= 4 && gb.ratio >= 0.85) {
    return { mime: 'text/plain; charset=gb18030', kind: 'text', label: 'Plain text (GB18030)' }
  }
  return { mime: 'application/octet-stream', kind: 'binary', label: 'Binary data' }
}

/**
 * Sniff a byte buffer into `{ mime, kind, label }`. `fileName` only ever
 * refines a magic-bytes match (the ftyp anti-disguise gate); it can never
 * override a signature verdict.
 */
export function sniff(bytes: Uint8Array, fileName?: string): SniffResult {
  if (bytes.length === 0) {
    return { mime: 'application/octet-stream', kind: 'binary', label: 'Empty file' }
  }

  // ---- Magic bytes are authoritative -------------------------------------
  if (startsWith(bytes, PNG_SIGNATURE)) return { mime: 'image/png', kind: 'image', label: 'PNG image' }
  if (startsWith(bytes, JPEG_SIGNATURE)) return { mime: 'image/jpeg', kind: 'image', label: 'JPEG image' }
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return { mime: 'image/gif', kind: 'image', label: 'GIF image' }
  }
  const riff = sniffRiff(bytes)
  if (riff) return riff
  if (asciiAt(bytes, 0, 'BM')) {
    // Two-byte signature: require a plausible DIB header size so ordinary
    // prose that happens to start with "BM" is not misread as a bitmap.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const dibSize = bytes.length >= 18 ? view.getUint32(14, true) : 0
    if (BMP_DIB_SIZES.has(dibSize)) {
      return { mime: 'image/bmp', kind: 'image', label: 'BMP image' }
    }
  }
  if (asciiAt(bytes, 0, '%PDF-')) {
    return { mime: 'application/pdf', kind: 'binary', label: 'PDF document' }
  }
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return sniffZip(bytes)
  }
  if (asciiAt(bytes, 0, 'OggS')) return { mime: 'audio/ogg', kind: 'media', label: 'Ogg audio' }
  if (u32beAt(bytes, 4) === 0x66747970) {
    return sniffFtyp(bytes, extensionOf(fileName))
  }
  if (startsWith(bytes, RAR4_SIGNATURE) || startsWith(bytes, RAR5_SIGNATURE)) {
    return { mime: 'application/x-rar-compressed', kind: 'archive', label: 'RAR archive' }
  }
  if (startsWith(bytes, SEVEN_Z_SIGNATURE)) {
    return { mime: 'application/x-7z-compressed', kind: 'archive', label: '7z archive' }
  }
  if (startsWith(bytes, GZIP_SIGNATURE)) {
    return { mime: 'application/gzip', kind: 'archive', label: 'Gzip archive' }
  }

  // ---- Statistical text/binary classification ----------------------------
  return textVerdict(bytes)
}
