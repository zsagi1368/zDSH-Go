/**
 * Zero-dependency document fixtures for the M3 parse suites.
 *
 * A minimal ZIP writer (STORED entries only + a hand-rolled CRC32) produces
 * byte-legal .docx/.xlsx packages, and a tiny object/xref assembler emits a
 * valid two-page PDF that pdfjs-dist can open. Everything is pure Node Buffer
 * math — no new dependencies, no binary blobs in git.
 */

// ---- CRC32 ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ---- Minimal ZIP writer -----------------------------------------------------

export interface ZipEntry {
  name: string
  data: Buffer | string
}

/**
 * Build a ZIP archive with STORED (uncompressed) entries. Readers as strict
 * as jszip/fflate accept this layout: local headers, central directory,
 * end-of-central-directory, all little-endian per APPNOTE.TXT.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const chunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0

  const u16 = (value: number): Buffer => {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16LE(value, 0)
    return b
  }
  const u32 = (value: number): Buffer => {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32LE(value >>> 0, 0)
    return b
  }

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data
    const checksum = crc32(data)

    const localOffset = offset
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0), // mod time
      u16(0x21), // mod date (1980-01-01)
      u32(checksum),
      u32(data.length), // compressed size
      u32(data.length), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
      data,
    ])
    chunks.push(local)

    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0),
      u16(0),
      u16(0),
      u16(0x21),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(localOffset),
      nameBytes,
    ])
    centralChunks.push(central)

    offset += local.length
  }

  const centralDirectory = Buffer.concat(centralChunks)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // cd disk
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset), // cd offset
    u16(0), // comment length
  ])
  return Buffer.concat([...chunks, centralDirectory, eocd])
}

// ---- DOCX fixture -----------------------------------------------------------

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Smallest package mammoth accepts: content types, the root relationship,
 * and word/document.xml with one `<w:p><w:r><w:t>` paragraph per input line.
 */
export function makeDocx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs
    .map(p => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`)
    .join('')
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
  ])
}

// ---- XLSX fixture -----------------------------------------------------------

export type XlsxCell = string | number | boolean | null
export interface XlsxSheetSpec {
  name: string
  rows: ReadonlyArray<ReadonlyArray<XlsxCell>>
}

/**
 * Minimal workbook: workbook.xml + one worksheet XML per sheet, wired through
 * the workbook relationship part. Strings are emitted as `inlineStr` cells
 * (verified supported by read-excel-file 5.8.7 parseCellValue).
 */
export function makeXlsx(sheets: readonly XlsxSheetSpec[]): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '</Types>'
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  const workbookRelsEntries = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('')
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelsEntries}</Relationships>`
  const sheetTags = sheets
    .map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetTags}</sheets></workbook>`

  const cellXml = (cell: XlsxCell, columnIndex: number, rowIndex: number): string => {
    const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`
    if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
    if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`
    if (cell === null) return ''
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`
  }

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
  ]
  sheets.forEach((sheet, i) => {
    const rowsXml = sheet.rows
      .map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((c, col) => cellXml(c, col, rowIndex)).join('')}</row>`)
      .join('')
    entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${rowsXml}</sheetData></worksheet>`,
    })
  })
  return buildZip(entries)
}

// ---- PDF fixture ------------------------------------------------------------

/**
 * Hand-assembled two-page PDF: catalog → pages → [page ×N with content
 * streams] → font, followed by a correct xref table so pdfjs parses it
 * without reconstruction.
 */
export function makePdf(pages: readonly string[]): Buffer {
  const objects: string[] = []
  const pageObjectNumbers = pages.map((_, i) => 3 + i * 2)

  const add = (content: string): void => {
    objects.push(content)
  }
  const kids = pageObjectNumbers.map(n => `${n} 0 R`).join(' ')
  add('<< /Type /Catalog /Pages 2 0 R >>') // object 1
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`) // object 2
  pages.forEach((text, i) => {
    const pageNumber = pageObjectNumbers[i]!
    const contentsNumber = pageNumber + 1
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentsNumber} 0 R ` +
        `/Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`,
    )
    const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
    add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  })
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') // last object

  const header = '%PDF-1.4\n'
  const parts: Buffer[] = [Buffer.from(header, 'latin1')]
  const offsets: number[] = []
  let position = Buffer.byteLength(header, 'latin1')
  objects.forEach((content, i) => {
    const chunk = `${i + 1} 0 obj\n${content}\nendobj\n`
    offsets.push(position)
    parts.push(Buffer.from(chunk, 'latin1'))
    position += Buffer.byteLength(chunk, 'latin1')
  })

  const xrefStart = position
  const count = objects.length + 1
  let xref = `xref\n0 ${count}\n`
  xref += '0000000000 65535 f \r\n'
  for (const objOffset of offsets) {
    xref += `${String(objOffset).padStart(10, '0')} 00000 n \r\n`
  }
  xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}
