/**
 * DOCX stage of the M3 waterfall: raw text extraction via mammoth
 * (P01 §6-C FR-C2). `extractRawText` returns paragraphs joined by `\n\n`
 * with no style markup — the right body for model reading.
 *
 * mammoth accepts no AbortSignal; the waterfall's abort race wraps this call.
 */

import type { DocumentOverview } from './types.js'

interface MammothModule {
  extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>
}

let cachedMammoth: MammothModule | undefined

async function loadMammoth(): Promise<MammothModule> {
  if (!cachedMammoth) {
    cachedMammoth = await import('mammoth')
  }
  return cachedMammoth
}

export async function extractDocx(bytes: Uint8Array): Promise<{
  text: string
  overview: DocumentOverview
  warnings: string[]
}> {
  const mammoth = await loadMammoth()
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  const text = result.value || ''
  // Paragraph count = non-empty blocks of the mammoth extraction.
  let paragraphCount = 0
  for (const block of text.split('\n\n')) {
    if (block.trim() !== '') paragraphCount += 1
  }
  const overview: DocumentOverview = { format: 'docx', paragraphCount }
  return { text, overview, warnings: [] }
}
