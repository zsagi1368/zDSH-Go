/**
 * Shared HTTP plumbing for the FileHub node half. Handlers own the full
 * response lifecycle (dsh-host-webserver WebRoute contract).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Safety valve for body draining so a hostile peer cannot hold sockets open. */
const DRAIN_TIMEOUT_MS = 10_000

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

/**
 * Consume and discard the remaining request body BEFORE responding, then
 * answer with a JSON error. Without the drain, an unread body wedges the
 * keep-alive connection (the client hangs waiting for the next response) —
 * mandatory on every early-rejection path (spec §6-A: 413 must drain).
 */
export async function drainAndSendError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
): Promise<void> {
  await drainBody(req)
  if (!res.writableEnded) sendError(res, status, message)
}

/** Resolve once the request stream is fully consumed (or the socket closes). */
export function drainBody(req: IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('end', finish)
      req.removeListener('close', finish)
      req.removeListener('error', finish)
      resolve()
    }
    const timer = setTimeout(finish, DRAIN_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', finish)
    req.resume()
  })
}

/** First value of a header field, or undefined. */
export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/** decodeURIComponent that fails closed (malformed % sequences → 400 path). */
export function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
