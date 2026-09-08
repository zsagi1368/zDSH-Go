/**
 * POST /api/filehub/upload — raw-body direct upload service (P01 §6-A).
 *
 * Guard rails, in evaluation order:
 *   1. same-origin fence — an Origin header must match the Host hostname AND
 *      come from a loopback remote (IPv4-mapped unwrapped first); absent
 *      Origin passes (non-browser clients);
 *   2. session resolution — unknown session (or session without a cwd) → 403;
 *   3. path policy — relative-path sanitization, hostile names defused;
 *   4. dangerous-extension deny list → 415;
 *   5. Content-Length pre-check → 413;
 *   6. per-session quota pre-check (KV bookkeeping) → 507;
 *   7. concurrency semaphore (default 4) → 429;
 *   8. streaming accumulation re-enforces maxBytes AND quota against the real
 *      byte count (a lying Content-Length cannot bypass either).
 *
 * Every rejection path DRAINS the request body before responding so the
 * keep-alive connection stays reusable (spec §9-F).
 *
 * Storage layout inside the workspace root:
 *   <root>/<relpath dirs>/<sha256_16>-<sanitized-name>
 * Writes go to a unique temp file then hard-link atomically onto the final
 * name; EEXIST means a concurrent identical upload won — reuse it and return
 * the same real path (dedupe race recovery, spec §6-A FR-A4).
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { sniff } from '../detect.js'
import { UploadResultSchema } from '../contract.js'
import type { MetaStore } from './meta.js'
import type { WorkspaceResolver } from './workspace.js'
import { drainAndSendError, drainBody, header, safeDecode, sendError, sendJson } from './httpUtil.js'
import { isValidSessionId, PathPolicyError, sanitizeFileName, sanitizeRelativePath } from './pathPolicy.js'

/** Handler shape demanded by dsh-host-webserver WebRoute. */
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export interface UploadGuards {
  /** Per-file byte ceiling. */
  maxBytes: number
  /** Simultaneous uploads admitted across all sessions. */
  maxConcurrent: number
  /** Per-session stored-bytes ceiling (KV-accounted). */
  perSessionQuotaBytes: number
  /** Extension deny list (lowercase, no dots), e.g. ['exe','dll','bat']. */
  dangerousExtensions: readonly string[]
}

export interface UploadServiceDeps {
  guards: UploadGuards
  meta: MetaStore
  workspaces: WorkspaceResolver
  logWarn: (message: string) => void
}

// ---- Same-origin fence ------------------------------------------------------

/**
 * True when the remote address is a loopback. Handles the IPv4-mapped form
 * (`::ffff:127.0.0.1`) by unwrapping the prefix BEFORE matching — the mapped
 * spelling must not sneak past an `addr === '::1'`-only check.
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  let candidate = address.toLowerCase()
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice('::ffff:'.length)
  if (candidate === '::1') return true
  return /^127(\.\d{1,3}){3}$/.test(candidate)
}

/**
 * Origin→Host consistency. Absent Origin passes (non-browser clients);
 * present-but-unparseable fails closed. Only the hostnames are compared —
 * ports may legitimately differ behind proxies.
 */
export function originMatchesHost(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (originHeader === undefined) return true
  if (originHeader === '' || hostHeader === undefined || hostHeader === '') return false
  let originHost: string
  try {
    originHost = new URL(originHeader).hostname.toLowerCase()
  } catch {
    return false
  }
  // WHATWG URL keeps brackets on IPv6 hostnames; normalize both sides.
  if (originHost.startsWith('[') && originHost.endsWith(']')) {
    originHost = originHost.slice(1, -1)
  }
  let requestHost = hostHeader.toLowerCase()
  if (requestHost.startsWith('[')) {
    const close = requestHost.indexOf(']')
    if (close === -1) return false
    requestHost = requestHost.slice(1, close)
  } else {
    const colon = requestHost.indexOf(':')
    if (colon !== -1) requestHost = requestHost.slice(0, colon)
  }
  return originHost === requestHost
}

// ---- Concurrency gate -------------------------------------------------------

/** Counting semaphore; admission is try-acquire, overflow answers 429. */
class Semaphore {
  private available: number

  constructor(size: number) {
    this.available = Math.max(1, size)
  }

  tryAcquire(): boolean {
    if (this.available <= 0) return false
    this.available -= 1
    return true
  }

  release(): void {
    this.available += 1
  }
}

// ---- Helpers ----------------------------------------------------------------

export function fileExtensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

function forwardSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

type ConsumeVerdict =
  | { status: 'ok'; bytes: Buffer }
  | { status: 'too-large' }
  | { status: 'quota-exceeded' }

/**
 * Stream the body through a running size counter with BOTH ceilings applied
 * live (Content-Length pre-checks only trust a header). Once a ceiling trips,
 * buffering stops but consumption continues to the end of the stream so the
 * keep-alive connection survives.
 */
function consumeWithLimits(
  req: IncomingMessage,
  maxBytes: number,
  quotaRemainingBytes: number,
): Promise<ConsumeVerdict> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let received = 0
    let settled = false
    const finish = (verdict: ConsumeVerdict): void => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      resolve(verdict)
    }
    const onData = (chunk: Buffer): void => {
      received += chunk.length
      if (received > maxBytes) {
        finish({ status: 'too-large' })
        return
      }
      if (received > quotaRemainingBytes) {
        finish({ status: 'quota-exceeded' })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void =>{  finish({ status: 'ok', bytes: Buffer.concat(chunks) }) }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('error', onError)
      reject(error)
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
  })
}

/**
 * M6 adversarial fix (round 1): lexical sanitization cannot see through a
 * directory symlink/junction that already exists INSIDE the workspace
 * (planted out-of-band). After materializing the destination directory, both
 * sides resolve to their REAL paths and containment is re-asserted. The
 * directory itself may EQUAL the root (flat uploads) — the strict-inside rule
 * is reserved for the final FILE path, which the sanitized `finalName` join
 * guarantees sits below the directory.
 */
async function atomicDedupeWrite(
  root: string,
  directory: string,
  finalName: string,
  bytes: Buffer,
): Promise<string> {
  await fsp.mkdir(directory, { recursive: true })
  let realRoot: string
  try {
    realRoot = await fsp.realpath(root)
  } catch {
    return Promise.reject(new PathPolicyError('target path escapes the session workspace'))
  }
  const realDirectory = await fsp.realpath(directory).catch(() => undefined)
  if (realDirectory === undefined) {
    throw new PathPolicyError('target path escapes the session workspace')
  }
  const rel = path.relative(realRoot, realDirectory)
  const escapes =
    path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)
  if (escapes) {
    throw new PathPolicyError('target path escapes the session workspace')
  }
  const finalPath = path.join(directory, finalName)
  const unique = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const tempPath = path.join(directory, `.tmp-${unique}-${finalName}`)
  const handle = await fsp.open(tempPath, 'wx')
  try {
    await handle.writeFile(bytes)
  } finally {
    await handle.close()
  }
  try {
    await fsp.link(tempPath, finalPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Concurrent identical content won the name race — reuse its file.
      return finalPath
    }
    throw error
  } finally {
    await fsp.unlink(tempPath).catch(() => undefined)
  }
  return finalPath
}

async function totalRecordedBytes(meta: MetaStore, sessionId: string): Promise<number> {
  const record = await meta.get(sessionId)
  let total = 0
  for (const entry of Object.values(record.files)) total += entry.sizeBytes
  return total
}

// ---- The handler ------------------------------------------------------------

export function createUploadHandler(deps: UploadServiceDeps): HttpHandler {
  const { guards, meta, workspaces, logWarn } = deps
  const gate = new Semaphore(guards.maxConcurrent)

  return async function handleUpload(req, res) {
    // ---- 1. same-origin fence ----
    const remote = req.socket.remoteAddress
    const originOk =
      originMatchesHost(header(req, 'origin'), header(req, 'host')) &&
      isLoopbackRemoteAddress(remote)
    if (!originOk) {
      await drainAndSendError(req, res, 403, 'cross-origin upload rejected')
      return
    }

    // ---- 2. session resolution ----
    const rawSession = header(req, 'x-session-id')
    if (rawSession === undefined) {
      await drainAndSendError(req, res, 403, 'missing x-session-id')
      return
    }
    const sessionId = safeDecode(rawSession)
    if (sessionId === undefined || !isValidSessionId(sessionId)) {
      await drainAndSendError(req, res, 403, 'unknown session')
      return
    }
    const workspace = workspaces.resolve(sessionId)
    if (!workspace) {
      await drainAndSendError(req, res, 403, 'unknown session')
      return
    }

    // ---- 3. wire headers → sanitized target ----
    const rawName = header(req, 'x-file-name') ?? ''
    const rawRelpath = header(req, 'x-file-relpath') ?? ''
    const decodedName = safeDecode(rawName)
    const decodedRelpath = safeDecode(rawRelpath)
    if (decodedName === undefined || decodedRelpath === undefined) {
      await drainAndSendError(req, res, 400, 'malformed percent-encoding in file headers')
      return
    }
    const relpath = sanitizeRelativePath(decodedRelpath)
    if (!relpath.ok) {
      await drainAndSendError(req, res, 400, relpath.reason)
      return
    }
    // Wire semantics (client queue): x-file-relpath carries the FULL path
    // INCLUDING the file name; x-file-name carries the display/base name and
    // is the only source when no relpath was sent.
    const displayName = sanitizeFileName(decodedName)
    let dirSegments: string[]
    let storedName: string
    if (relpath.segments.length > 0) {
      dirSegments = relpath.segments.slice(0, -1)
      storedName = relpath.segments[relpath.segments.length - 1] ?? ''
    } else {
      dirSegments = []
      storedName = displayName
    }
    const segments = [...dirSegments, storedName]

    // ---- 4. dangerous extension deny list (judged on the STORED name) ----
    if (guards.dangerousExtensions.includes(fileExtensionOf(storedName))) {
      await drainAndSendError(req, res, 415, 'file extension rejected by security policy')
      return
    }

    // ---- 5. Content-Length pre-check ----
    const rawLength = header(req, 'content-length')
    let declaredLength: number | undefined
    if (rawLength !== undefined) {
      const parsed = Number(rawLength)
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        await drainAndSendError(req, res, 400, 'invalid content-length')
        return
      }
      declaredLength = parsed
      if (parsed > guards.maxBytes) {
        await drainAndSendError(req, res, 413, 'upload exceeds the configured size limit')
        return
      }
    }

    // ---- 6. per-session quota pre-check ----
    const recordedBytes = await totalRecordedBytes(meta, sessionId)
    const quotaRemaining = guards.perSessionQuotaBytes - recordedBytes
    if (declaredLength !== undefined && declaredLength > quotaRemaining) {
      await drainAndSendError(req, res, 507, 'session storage quota exhausted')
      return
    }

    // ---- 7. concurrency gate ----
    if (!gate.tryAcquire()) {
      await drainAndSendError(req, res, 429, 'upload concurrency limit reached; retry shortly')
      return
    }

    // ---- 8. streaming accumulation with live ceilings ----
    let bytes: Buffer
    try {
      const outcome = await consumeWithLimits(req, guards.maxBytes, quotaRemaining)
      if (outcome.status === 'too-large') {
        await drainBody(req)
        sendError(res, 413, 'upload exceeds the configured size limit')
        return
      }
      if (outcome.status === 'quota-exceeded') {
        await drainBody(req)
        sendError(res, 507, 'session storage quota exhausted')
        return
      }
      bytes = outcome.bytes
    } catch (error) {
      logWarn(`[filehub] upload stream failed for session "${sessionId}": ${String(error)}`)
      if (!res.writableEnded && !res.destroyed) {
        sendError(res, 400, 'upload stream failed')
      }
      return
    } finally {
      gate.release()
    }

    // ---- persist: sha256_16 dedupe naming + atomic write ----
    const digest16 = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
    const finalName = `${digest16}-${storedName}`
    const directory = path.join(workspace.root, ...segments.slice(0, -1))
    const finalPath = path.join(directory, finalName)

    try {
      await atomicDedupeWrite(workspace.root, directory, finalName, bytes)
    } catch (error) {
      if (error instanceof PathPolicyError) {
        // A symlink/junction inside the workspace tried to carry the write
        // outside it. Answer the policy rejection without host layout detail.
        await drainBody(req).catch(() => undefined)
        sendError(res, 400, error.message)
        return
      }
      logWarn(`[filehub] failed to persist upload for session "${sessionId}": ${String(error)}`)
      sendError(res, 500, 'failed to persist upload')
      return
    }

    const storedRelPath = segments.slice(0, -1).concat(finalName).join('/')
    await meta
      .record(sessionId, storedRelPath, { sizeBytes: bytes.length, uploadedAtMs: Date.now() }, workspace.cwd)
      .catch((error: unknown) => {
        // Bookkeeping failure must not strand a 200-less client; the file is
        // on disk and dedupes by content anyway. Quota may lag one upload.
        logWarn(`[filehub] metadata record failed for session "${sessionId}": ${String(error)}`)
      })

    const result = UploadResultSchema.parse({
      path: finalPath,
      relativePath: forwardSlashes(path.relative(workspace.cwd, finalPath)),
      sniffedType: sniff(bytes, storedName).mime,
      label: displayName !== 'unnamed' ? displayName : storedName,
    })
    sendJson(res, 200, result)
  }
}
