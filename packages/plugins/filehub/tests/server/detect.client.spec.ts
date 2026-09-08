/**
 * Byte-sniffing layer spectrum (P01 §6-A): one case per authoritative magic
 * signature, plus the text pipeline (BOM precedence, NUL gating, GB18030
 * double-byte gate) and the ftyp anti-disguise rule.
 */
import { describe, expect, it } from 'vitest'

import { gb18030DoubleByteRatio, sniff } from '../../src/detect.js'

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]
const GIF_BYTES = [...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0]
const BMP_BYTES = [
  0x42, 0x4d, // 'BM'
  0x46, 0, 0, 0, // file size
  0, 0, 0, 0,
  0x8a, 0, 0, 0, // pixel data offset
  0x28, 0, 0, 0, // DIB header size = 40 (plausible)
]
function zipBytes(entries: string[]): Uint8Array {
  // Minimal stand-in: local file header signature + entry names concatenated.
  const encoder = new TextEncoder()
  const parts: Array<Uint8Array> = []
  for (const name of entries) {
    parts.push(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
    parts.push(encoder.encode(name))
    parts.push(new Uint8Array([0, 1, 2, 3]))
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
function riffForm(form: string): Uint8Array {
  const bytes = new Uint8Array(12 + 4)
  bytes.set(new TextEncoder().encode('RIFF'), 0)
  bytes.set(new TextEncoder().encode(form), 8)
  return bytes
}
function ftypBytes(brand: string): Uint8Array {
  const bytes = new Uint8Array(16)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 16)
  bytes.set(new TextEncoder().encode('ftyp'), 4)
  bytes.set(new TextEncoder().encode(brand.padEnd(4, ' ').slice(0, 4)), 8)
  return bytes
}

describe('sniff: magic bytes are authoritative', () => {
  it('detects PNG', () => {
    expect(sniff(new Uint8Array(PNG_BYTES))).toEqual({
      mime: 'image/png', kind: 'image', label: 'PNG image',
    })
  })

  it('detects JPEG', () => {
    expect(sniff(new Uint8Array(JPEG_BYTES)).mime).toBe('image/jpeg')
  })

  it('detects GIF87a/89a', () => {
    expect(sniff(new Uint8Array(GIF_BYTES))).toEqual({
      mime: 'image/gif', kind: 'image', label: 'GIF image',
    })
  })

  it('detects BMP via plausible DIB header size', () => {
    expect(sniff(new Uint8Array(BMP_BYTES)).mime).toBe('image/bmp')
  })

  it("does not mistake prose starting with 'BM' for a bitmap", () => {
    const text = new TextEncoder().encode('BMW owners manual, plain text edition')
    expect(sniff(text).kind).toBe('text')
  })

  it('detects WebP inside RIFF', () => {
    const webp = riffForm('WEBP')
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniff(webp).mime).toBe('image/webp')
  })

  it('detects WAV and AVI forms of RIFF', () => {
    expect(sniff(riffForm('WAVE')).mime).toBe('audio/wav')
    expect(sniff(riffForm('AVI ')).mime).toBe('video/x-msvideo')
  })

  it('detects PDF', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 trailing bytes look like text')
    expect(sniff(pdf)).toEqual({ mime: 'application/pdf', kind: 'binary', label: 'PDF document' })
  })

  it('a known binary signature cannot be rescued by a text hint', () => {
    // PNG magic followed by perfectly valid UTF-8 prose.
    const poisoned = new Uint8Array(PNG_BYTES.length + 12)
    poisoned.set(PNG_BYTES, 0)
    poisoned.set(new TextEncoder().encode('hello world!'), PNG_BYTES.length)
    expect(sniff(poisoned).kind).toBe('image')
  })
})

describe('sniff: ZIP family and OOXML central entries', () => {
  it('classifies plain ZIP as archive', () => {
    const result = sniff(zipBytes(['readme.txt', 'data/bin']))
    expect(result.mime).toBe('application/zip')
    expect(result.kind).toBe('archive')
  })

  it('distinguishes docx / xlsx / pptx packages', () => {
    expect(sniff(zipBytes(['[Content_Types].xml', 'word/document.xml'])).label).toContain('Word')
    expect(sniff(zipBytes(['xl/workbook.xml', '_rels/.rels'])).label).toContain('Excel')
    expect(sniff(zipBytes(['ppt/slides/slide1.xml'])).label).toContain('PowerPoint')
  })
})

describe('sniff: media containers', () => {
  it('detects Ogg audio', () => {
    const ogg = new TextEncoder().encode('OggS\x00\x02rest-of-page')
    expect(sniff(ogg)).toEqual({ mime: 'audio/ogg', kind: 'media', label: 'Ogg audio' })
  })

  it('detects MP4 (ftyp) only when the extension is on the media whitelist', () => {
    expect(sniff(ftypBytes('isom'), 'clip.mp4').mime).toBe('video/mp4')
    expect(sniff(ftypBytes('M4A '), 'song.m4a').mime).toBe('audio/mp4')
    expect(sniff(ftypBytes('qt  '), 'ref.mov').mime).toBe('video/quicktime')
  })

  it('rejects an ftyp box wearing a non-media extension (anti-disguise)', () => {
    const result = sniff(ftypBytes('isom'), 'payload.txt')
    expect(result.kind).toBe('binary')
    expect(result.mime).toBe('application/octet-stream')
  })

  it('rejects an ftyp box with no usable name at all', () => {
    expect(sniff(ftypBytes('isom')).kind).toBe('binary')
  })
})

describe('sniff: archives beyond zip', () => {
  it('detects RAR4 and RAR5', () => {
    const rar4 = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0])
    const rar5 = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
    expect(sniff(rar4).mime).toBe('application/x-rar-compressed')
    expect(sniff(rar5).mime).toBe('application/x-rar-compressed')
  })

  it('detects 7z and gzip', () => {
    const seven = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0])
    const gz = new Uint8Array([0x1f, 0x8b, 0x08, 0x00])
    expect(sniff(seven).mime).toBe('application/x-7z-compressed')
    expect(sniff(gz).mime).toBe('application/gzip')
  })
})

describe('sniff: text pipeline', () => {
  it('BOM wins over the NUL heuristic (UTF-16LE with NUL bytes stays text)', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x21, 0x00])
    const result = sniff(bytes)
    expect(result.mime).toBe('text/plain; charset=utf-16le')
    expect(result.kind).toBe('text')
  })

  it('UTF-8 BOM declares utf-8 before any other heuristic', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('café')])
    expect(sniff(bytes).mime).toBe('text/plain; charset=utf-8')
  })

  it('UTF-16BE BOM declares utf-16be', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69])
    expect(sniff(bytes).mime).toBe('text/plain; charset=utf-16be')
  })

  it('NUL-heavy content without a BOM is binary', () => {
    const bytes = new Uint8Array(64)
    bytes.fill(0x41, 0, 8)
    // rest stays zeroed → ratio ≈ 0.87 ≥ gate
    const result = sniff(bytes)
    expect(result.kind).toBe('binary')
    expect(result.mime).toBe('application/octet-stream')
  })

  it('plain ASCII prose is UTF-8 text', () => {
    expect(sniff(new TextEncoder().encode('The quick brown fox jumps.')).mime).toBe(
      'text/plain; charset=utf-8',
    )
  })

  it('invalid UTF-8 but high-frequency GB18030 pairs is gb18030 text', () => {
    // "你好世界，测试文本" in GBK/GB18030 — lead/trail byte pairs.
    const bytes = new Uint8Array([
      0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7, 0xa3, 0xac,
      0xb2, 0xe2, 0xca, 0xd4, 0xce, 0xc4, 0xb1, 0xbe,
    ])
    const stats = gb18030DoubleByteRatio(bytes)
    expect(stats.pairs).toBeGreaterThanOrEqual(4)
    const result = sniff(bytes)
    expect(result.kind).toBe('text')
    expect(result.mime).toBe('text/plain; charset=gb18030')
  })

  it('invalid UTF-8 without a GB18030 signature falls back to binary', () => {
    // High bytes that never form valid pairs (trails below 0x40).
    const bytes = new Uint8Array([0x81, 0x21, 0x82, 0x22, 0x83, 0x23, 0x84, 0x24, 0x85, 0x25])
    expect(sniff(bytes).kind).toBe('binary')
  })
})

describe('sniff: degenerate inputs', () => {
  it('empty buffer is binary', () => {
    expect(sniff(new Uint8Array(0))).toEqual({
      mime: 'application/octet-stream', kind: 'binary', label: 'Empty file',
    })
  })

  it('single ASCII byte is text', () => {
    expect(sniff(new Uint8Array([0x41])).kind).toBe('text')
  })
})
