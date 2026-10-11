/**
 * Strict in-memory extractor for npm publish tarballs (ustar/POSIX tar).
 * Plugin installation is an admission boundary: every structural surprise is
 * rejected instead of tolerated, so the extractor understands only what
 * `npm pack` emits — regular files and directories under a single root,
 * optional pax headers for oversized paths — and refuses links, devices,
 * GNU extensions, and any entry that would escape the destination directory.
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One rejected tarball, carrying a correction-oriented reason. */
export class TarExtractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarExtractionError'
  }
}

/** Resource caps applied while extracting one tarball. */
export interface TarballLimits {
  /** Maximum number of file entries written. */
  readonly maxEntries: number
  /** Maximum decompressed bytes across all file entries combined. */
  readonly maxTotalBytes: number
  /** Maximum size of one extracted file. */
  readonly maxFileBytes: number
}

/** Caps sized for plugin packages; npm itself allows far larger publishes. */
export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxEntries: 4096,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
}

const BLOCK = 512

/** Read one NUL-terminated ASCII field from a header block. */
function field(block: Buffer, offset: number, length: number): string {
  const end = block.subarray(offset, offset + length).indexOf(0)
  return block.subarray(offset, end === -1 ? offset + length : offset + end).toString('latin1')
}

/** Parse one octal tar field (spaces/NULs allowed as padding). */
function octal(block: Buffer, offset: number, length: number): number {
  const text = block.subarray(offset, offset + length).toString('latin1').trim().replace(/[\0 ]+$/u, '')
  if (text.length === 0) return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) throw new TarExtractionError(`malformed numeric tar field ${JSON.stringify(text)}`)
  return value
}

/** Split one stored entry path into sanitized segments; `null` when unsafe. */
function safeSegments(storedPath: string): string[] | null {
  if (storedPath.includes('\\')) return null
  if (storedPath.startsWith('/') || /^[A-Za-z]:/u.test(storedPath)) return null
  const segments = storedPath.split('/').filter(segment => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some(segment => segment === '..')) return null
  // Trailing slash marks a directory; it contributes no segment.
  return segments
}

/** Apply one pax override record set to the raw header values of the next entry. */
function applyPaxOverrides(
  overrides: Map<string, string>,
  header: { path: string; size: number },
): void {
  const paxPath = overrides.get('path')
  if (paxPath !== undefined) header.path = paxPath
  const paxSize = overrides.get('size')
  if (paxSize !== undefined && /^\d+$/u.test(paxSize)) header.size = Number.parseInt(paxSize, 10)
}

/** Parse "<length> key=value\n" records out of one pax header payload. */
function parsePaxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let cursor = 0
  while (cursor < payload.length) {
    const space = payload.indexOf(0x20, cursor)
    if (space === -1) break
    const lengthText = payload.subarray(cursor, space).toString('latin1')
    const length = Number.parseInt(lengthText, 10)
    if (!Number.isFinite(length) || length <= 0 || cursor + length > payload.length) break
    const record = payload.subarray(cursor + space + 1, cursor + length).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    cursor += length
  }
  return records
}

/** Summary of one successfully extracted tarball. */
export interface ExtractedPackage {
  /** Number of regular files written under `destinationDir`. */
  readonly fileCount: number
}

/**
 * Extract an npm package tarball into `destinationDir`, creating it on
 * demand. Throws {@link TarExtractionError} on any structure outside the
 * npm-publish profile or any entry that would land outside the destination.
 * @param tarball - the raw tarball bytes to extract.
 * @param destinationDir - the directory to write files into, created if missing.
 * @param limits - resource caps applied during extraction; defaults to
 * {@link DEFAULT_TARBALL_LIMITS}.
 * @returns a summary of the extracted archive contents.
 */
export function extractNpmPackageTarball(
  tarball: Buffer,
  destinationDir: string,
  limits: TarballLimits = DEFAULT_TARBALL_LIMITS,
): ExtractedPackage {
  let fileCount = 0
  let totalBytes = 0
  let paxOverrides: Map<string, string> | undefined
  let offset = 0
  while (offset + BLOCK <= tarball.length) {
    const header = tarball.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) break
    // Checksum: the recorded value compared against the header summed with its
    // checksum field read as spaces.
    const recordedChecksum = octal(header, 148, 8)
    let computed = 0
    for (let index = 0; index < BLOCK; index += 1) {
      computed += index >= 148 && index < 156 ? 0x20 : header.readUInt8(index)
    }
    if (computed !== recordedChecksum) throw new TarExtractionError('tar header checksum mismatch')
    const typeflag = String.fromCharCode(header[156] ?? 0x30)
    const rawSize = octal(header, 124, 12)
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + rawSize
    if (dataEnd > tarball.length) throw new TarExtractionError('tar entry extends past the archive end')
    if (typeflag === 'x' || typeflag === 'g') {
      // pax headers only contribute path/size overrides for the next entry;
      // global ('g') records are parsed but deliberately ignored.
      const records = parsePaxRecords(tarball.subarray(dataStart, dataEnd))
      if (typeflag === 'x') paxOverrides = records
    } else if (typeflag === 'L' || typeflag === 'K') {
      throw new TarExtractionError('GNU long-name extensions are not accepted')
    } else if (typeflag === '1' || typeflag === '2' || typeflag === '3' || typeflag === '4' || typeflag === '6') {
      throw new TarExtractionError(`link and device entries (${JSON.stringify(typeflag)}) are not accepted`)
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '5') {
      const header_ = { path: field(header, 0, 100), size: rawSize }
      const prefix = field(header, 345, 155)
      if (prefix.length > 0) header_.path = `${prefix}/${header_.path}`
      applyPaxOverrides(paxOverrides ?? new Map<string, string>(), header_)
      paxOverrides = undefined
      // A pax size override changes this entry's data extent: recompute the
      // slice bounds from the effective size before touching the payload.
      const dataStart = offset + BLOCK
      const dataEnd = dataStart + header_.size
      if (dataEnd > tarball.length) throw new TarExtractionError('tar entry extends past the archive end')
      const segments = safeSegments(header_.path)
      if (segments === null) throw new TarExtractionError(`unsafe entry path ${JSON.stringify(header_.path)}`)
      // npm publish tarballs wrap everything in a single root directory
      // (conventionally `package/`); strip that one root segment so files
      // land directly in the destination, matching `npm install` layout.
      if (segments[0] === 'package') {
        if (segments.length === 1) {
          offset = dataStart + Math.ceil(header_.size / BLOCK) * BLOCK
          continue
        }
        segments.shift()
      }
      if (typeflag === '5') {
        mkdirSync(join(destinationDir, ...segments), { recursive: true })
      } else {
        if (fileCount >= limits.maxEntries) throw new TarExtractionError('too many entries')
        if (header_.size > limits.maxFileBytes) throw new TarExtractionError('one file exceeds the size cap')
        totalBytes += header_.size
        if (totalBytes > limits.maxTotalBytes) throw new TarExtractionError('extracted content exceeds the total size cap')
        const target = join(destinationDir, ...segments)
        const contained = destinationDir.endsWith('\\') || destinationDir.endsWith('/')
          ? target.startsWith(destinationDir)
          : target.startsWith(destinationDir + '\\') || target.startsWith(destinationDir + '/')
        if (!contained) throw new TarExtractionError(`entry escapes the destination directory ${JSON.stringify(header_.path)}`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, tarball.subarray(dataStart, dataEnd))
        fileCount += 1
      }
      offset = dataStart + Math.ceil(header_.size / BLOCK) * BLOCK
      continue
    } else {
      throw new TarExtractionError(`unsupported tar entry type ${JSON.stringify(typeflag)}`)
    }
    offset = dataStart + Math.ceil(rawSize / BLOCK) * BLOCK
  }
  if (fileCount === 0) throw new TarExtractionError('the tarball contains no package files')
  return { fileCount }
}
