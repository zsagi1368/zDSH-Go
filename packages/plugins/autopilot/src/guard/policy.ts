/**
 * Layer 1 (fuse) + deterministic tool assessment for non-shell tools.
 *
 * The fuse is synchronous and monotonic: whatever it denies, no later layer —
 * classifier, human, or anything else — can override. It only recognizes
 * high-confidence destructive facts; everything else flows down the stack.
 */
import { isCredentialTree, isCriticalPath, isWithin, normalizePath } from './pathhard.js'
import type { PathRoots } from './pathhard.js'

const DESTRUCTIVE_TOOL_HEADS = /^(rm|rmdir|del|rd|remove-item)$/i
const EXECUTION_POLICY = /set-executionpolicy/i

export interface FuseVerdict {
  denied: true
  reason: string
}

/**
 * Synchronous hard-deny fuse for tool calls. Returns undefined when the call
 * may proceed to the lower layers.
 */
export function hardDeny(toolName: string, argsJson: string, roots: PathRoots): FuseVerdict | undefined {
  const lower = `${toolName} ${argsJson}`.toLowerCase()
  const argText = argsJson.toLowerCase()

  if (/\b(sudo|doas|su)\b\s*/.test(argText) || /^\s*(sudo|doas|su)\b/.test(lower)) {
    return { denied: true, reason: 'privilege escalation (sudo/doas/su) is never automatic' }
  }
  if (EXECUTION_POLICY.test(lower)) {
    return { denied: true, reason: 'changing script execution policy is a system security change' }
  }

  // Credential shapes: transfer anywhere, or deletion of credential trees
  // (the destructive intent may arrive as the args head, not the tool name).
  const headToken = (argsJson.trim().split(/\s+/)[0] ?? '').replace(/^["']+|["']+$/g, '').toLowerCase()
  const destructiveHead = DESTRUCTIVE_TOOL_HEADS.test(toolName) ||
    DESTRUCTIVE_TOOL_HEADS.test(headToken)
  const argPaths = extractPathLikeArgs(argsJson)
  for (const p of argPaths) {
    if (isCredentialTree(p) && /\b(scp|rsync|upload|send|post|curl)\b/i.test(lower)) {
      return { denied: true, reason: 'credential material transfer attempt' }
    }
    if (isCredentialTree(p) && destructiveHead) {
      return { denied: true, reason: 'deleting credential trees is never automatic' }
    }
  }

  // Destruction aimed at critical paths.
  if (destructiveHead || /\b(rm|del|remove)\b/i.test(argsJson)) {
    for (const p of argPaths) {
      if (normalizePath(p).reservedDeviceName) {
        return { denied: true, reason: 'reserved device name target' }
      }
      if (
        normalizePath(p).driveRelativeAmbiguity &&
        DESTRUCTIVE_TOOL_HEADS.test(toolName)
      ) {
        return { denied: true, reason: 'drive-relative ambiguous deletion target' }
      }
      if (isCriticalPath(roots, p)) {
        return { denied: true, reason: 'destructive operation on a critical path' }
      }
    }
  }
  return undefined
}

function extractPathLikeArgs(argsJson: string): string[] {
  const out: string[] = []
  let scanEmbedded = false
  const pushIfPathy = (s: string): void => {
    if (/^[A-Za-z]:[\\/]|^\/|^\.{1,2}[\\/]|^~/.test(s)) out.push(s)
  }
  try {
    const parsed: unknown = JSON.parse(argsJson)
    walk(parsed)
    function walk(node: unknown): void {
      if (typeof node === 'string') {
        pushIfPathy(node)
      } else if (Array.isArray(node)) {
        node.forEach(walk)
      } else if (typeof node === 'object' && node !== null) {
        Object.values(node).forEach(walk)
      }
    }
  } catch {
    scanEmbedded = true
  }
  if (scanEmbedded || out.length === 0) {
    // Raw shell lines (or string payloads): scan for embedded path-like
    // substrings, drive-letter and POSIX-style homes, either slash.
    for (const m of argsJson.matchAll(/[A-Za-z]:[\\/][^\s"']*/g)) out.push(m[0])
    for (const m of argsJson.matchAll(/(?:\/|~\/)[\w.-]+(?:\/[\w.-]+)+/g)) {
      if (!out.includes(m[0])) out.push(m[0])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Deterministic assessment of non-shell tools
// ---------------------------------------------------------------------------

export type ToolDecision = 'allow' | 'classify' | 'deny'

export interface ToolAssessment {
  decision: ToolDecision
  reason: string
}

/** Read-only and session-state tools are safe by name — exact set, not regex. */
const READONLY_TOOLS = new Set([
  'read', 'glob', 'grep', 'ls', 'list', 'search', 'find',
  'todo_write', 'todo-read', 'plan', 'plan_write',
])

const STATEFUL_TERMINAL_TOOLS = new Set(['terminal_open', 'terminal_send'])

export function assessTool(
  toolName: string,
  argsJson: string,
  roots: PathRoots,
  hasArtifact?: (path: string) => boolean,
): ToolAssessment {
  const name = toolName.toLowerCase()

  if (READONLY_TOOLS.has(name)) {
    return { decision: 'allow', reason: 'read-only or session-state tool' }
  }
  if (STATEFUL_TERMINAL_TOOLS.has(name)) {
    return { decision: 'classify', reason: 'stateful terminal session — prior shell state is not visible to static review' }
  }

  // Editor/write family: judge by target path.
  const targets = extractPathLikeArgs(argsJson)
  if ((name === 'write' || name === 'edit' || name === 'multiedit') && targets.length > 0) {
    const target = targets[0] ?? ''
    const norm = normalizePath(target)
    if (!norm.isAbsolute || !isWithin(roots.workspaceRoot, norm.normalized)) {
      return { decision: 'classify', reason: 'write outside the workspace boundary' }
    }
    if (hasArtifact?.(target)) {
      return { decision: 'allow', reason: 'overwriting an exact session-created artifact' }
    }
    return { decision: 'classify', reason: 'modifying pre-existing workspace data' }
  }

  // Network fetch with mutation verbs.
  if (/^(web_?fetch|http_?request)$/.test(name) && /"method"\s*:\s*"(POST|PUT|DELETE|PATCH)"/i.test(argsJson)) {
    return { decision: 'classify', reason: 'outbound mutating HTTP request' }
  }

  // Third-party plugin tools run inside the sandbox like any other command.
  return { decision: 'allow', reason: 'ordinary registered plugin tool confined by the sandbox' }
}
