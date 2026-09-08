/**
 * GET /api/filehub/list?sessionId=<id> — bounded workspace traversal
 * (contract ListResultSchema). Unknown session → 403. The walk stops at
 * MAX_LIST_ENTRIES and reports `truncated: true` so the console can offer a
 * deeper view instead of pretending the tree ended.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { ListResultSchema } from '../contract.js'
import type { FileEntry } from '../contract.js'
import type { MetaStore } from './meta.js'
import type { WorkspaceResolver } from './workspace.js'
import { sendError, sendJson } from './httpUtil.js'
import type { HttpHandler } from './upload.js'

/** Hard ceiling of one listing page (the bounded in MAX_LIST_ENTRIES). */
export const MAX_LIST_ENTRIES = 500

const MAX_WALK_DEPTH = 24

export interface ListServiceDeps {
  meta: MetaStore
  workspaces: WorkspaceResolver
}

function forwardSlashes(value: string): string {
  return value.replace(/\\/g, '/')
}

export function createListHandler(deps: ListServiceDeps): HttpHandler {
  const { meta, workspaces } = deps

  return async function handleList(req, res) {
    let sessionId: string | null = null
    try {
      const url = new URL(req.url ?? '/', 'http://filehub.invalid')
      sessionId = url.searchParams.get('sessionId')
    } catch {
      sessionId = null
    }
    const workspace =
      sessionId !== null && sessionId !== '' ? workspaces.resolve(sessionId) : undefined
    if (!workspace || sessionId === null) {
      sendError(res, 403, 'unknown session')
      return
    }

    const record = await meta.get(workspace.sessionId).catch(() => undefined)

    interface PendingEntry {
      absolutePath: string
      relativePathFromRoot: string
      isDirectory: boolean
    }
    const collected: PendingEntry[] = []
    let truncated = false

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (truncated || depth > MAX_WALK_DEPTH) {
        truncated = truncated || depth > MAX_WALK_DEPTH
        return
      }
      let entries
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (collected.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          collected.push({
            absolutePath: absolute,
            relativePathFromRoot: forwardSlashes(path.relative(workspace.root, absolute)),
            isDirectory: true,
          })
          await visit(absolute, depth + 1)
        } else if (entry.isFile()) {
          collected.push({
            absolutePath: absolute,
            relativePathFromRoot: forwardSlashes(path.relative(workspace.root, absolute)),
            isDirectory: false,
          })
        }
        if (collected.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
      }
    }

    try {
      await visit(workspace.root, 0)
    } catch {
      // Missing workspace root → an empty listing, not an error.
    }

    const listed = collected
      .slice(0, MAX_LIST_ENTRIES)
      .sort((a, b) => (a.relativePathFromRoot < b.relativePathFromRoot ? -1 : 1))

    const fileEntries: FileEntry[] = []
    for (const entry of listed) {
      const recorded = record?.files[entry.relativePathFromRoot]
      const recordedAt = recorded?.uploadedAtMs
      let sizeBytes = 0
      if (!entry.isDirectory) {
        try {
          sizeBytes = (await fsp.stat(entry.absolutePath)).size
        } catch {
          sizeBytes = 0 // vanished between readdir and stat
        }
      }
      fileEntries.push({
        path: entry.absolutePath,
        relativePath: forwardSlashes(path.relative(workspace.cwd, entry.absolutePath)),
        sizeBytes,
        kind: entry.isDirectory ? 'directory' : 'file',
        ...(recordedAt !== undefined ? { uploadedAtMs: recordedAt } : {}),
        // M6 caption passthrough (P01 §6-D): surface the persisted vision
        // caption from the upload metadata row when one exists.
        ...(typeof recorded?.imageCaption === 'string' && recorded.imageCaption !== ''
          ? { imageCaption: recorded.imageCaption }
          : {}),
      })
    }

    const result = ListResultSchema.parse({
      sessionId: workspace.sessionId,
      entries: fileEntries,
      truncated,
    })
    sendJson(res, 200, result)
  }
}
