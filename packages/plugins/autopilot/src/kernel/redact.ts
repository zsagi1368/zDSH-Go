/**
 * Structure-aware redaction pipeline.
 *
 * Everything that crosses a model boundary (classifier payloads, reviewer
 * prompts) passes through here first. Two profiles:
 *  - `standard`: same-provider targets. Token-shaped secrets and secret-named
 *    keys are replaced; bulk content keys collapse to length placeholders.
 *  - `strict`: cross-provider targets. Additionally strips credential blocks,
 *    connection strings, and cloud key ids from free text.
 *
 * Caps: recursion depth 3, arrays 25 items, objects 50 keys, scalar strings
 * truncated to 1000 chars AFTER text-form redaction.
 */

export type RedactProfile = 'standard' | 'strict'

export const REDACT_CAPS = {
  depth: 3,
  arrayItems: 25,
  objectKeys: 50,
  scalarChars: 1000,
} as const

/** Key substrings (lowercased) whose presence marks the whole field a secret. */
export const SECRET_KEY_MARKERS: readonly string[] = [
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'credential',
  'private_key',
  'cookie',
]

/** Keys whose VALUES are bulk content: replaced by a length placeholder only. */
export const BULK_KEY_NAMES: readonly string[] = [
  'body',
  'content',
  'data',
  'diff',
  'patch',
  'payload',
  'str',
  'string',
  'text',
  'snippet',
  'source_code',
  'file_text',
  'old_str',
  'new_str',
]

interface TextPattern {
  name: string
  re: RegExp
}

const TOKEN_PATTERNS: readonly TextPattern[] = [
  { name: 'openai-style', re: /sk-[A-Za-z0-9_-]{8,}/g },
  { name: 'github-pat-classic', re: /ghp_[A-Za-z0-9]{8,}/g },
  { name: 'github-pat-fine', re: /github_pat_[A-Za-z0-9_]{8,}/g },
  { name: 'slack', re: /xox[barps]-[A-Za-z0-9-]{8,}/g },
  { name: 'bearer', re: /\bBearer\s+[a-z0-9._~+/\=-]{8,}/gi },
  { name: 'key-value', re: /\b(key|secret|password|token)\s*[:=]\s*["']?[^\s"';,}]{6,}/gi },
]

const STRICT_TEXT_PATTERNS: readonly TextPattern[] = [
  ...TOKEN_PATTERNS,
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'connection-string', re: /\b[a-z][a-z0-9+.-]{2,30}:\/\/[^\s:@/"']+:[^\s@/"']+@[^\s"']+/g },
]

export const REDACTED_SECRET = '[redacted-secret]'
export function redactedBulkPlaceholder(key: string, length: number): string {
  return `[redacted-${key}:${length}-chars]`
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.]/g, '')
}

const NORMALIZED_SECRET_MARKERS: readonly string[] = SECRET_KEY_MARKERS.map(normalizeKey)
const NORMALIZED_BULK_NAMES: readonly string[] = BULK_KEY_NAMES.map(normalizeKey)

function isSecretKey(key: string): boolean {
  const norm = normalizeKey(key)
  return NORMALIZED_SECRET_MARKERS.some(marker => norm.includes(marker))
}

function isBulkKey(key: string): boolean {
  return NORMALIZED_BULK_NAMES.includes(normalizeKey(key))
}

export function redactString(text: string, profile: RedactProfile): string {
  let out = text
  const patterns = profile === 'strict' ? STRICT_TEXT_PATTERNS : TOKEN_PATTERNS
  for (const { re } of patterns) {
    out = out.replace(re, REDACTED_SECRET)
  }
  if (out.length > REDACT_CAPS.scalarChars) out = `${out.slice(0, REDACT_CAPS.scalarChars)}…`
  return out
}

export function redact(value: unknown, profile: RedactProfile = 'standard'): unknown {
  function walk(node: unknown, depth: number): unknown {
    if (typeof node === 'string') return redactString(node, profile)
    if (typeof node === 'number' || typeof node === 'boolean' || node === null) return node
    if (node === undefined) return null
    if (depth >= REDACT_CAPS.depth) return '[truncated-depth]'
    if (Array.isArray(node)) {
      const sliced = node.slice(0, REDACT_CAPS.arrayItems).map(item => walk(item, depth + 1))
      if (node.length > REDACT_CAPS.arrayItems) {
        sliced.push(`[truncated:${node.length - REDACT_CAPS.arrayItems}-more]`)
      }
      return sliced
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
      const out: Record<string, unknown> = {}
      let kept = 0
      for (const [key, child] of entries) {
        if (kept >= REDACT_CAPS.objectKeys) {
          out[key] = '[truncated-keys]'
          break
        }
        kept += 1
        if (isSecretKey(key)) {
          out[key] = key.length > 60 ? '[redacted-key]' : REDACTED_SECRET
        } else if (
          isBulkKey(key) &&
          typeof child === 'string'
        ) {
          out[key] = redactedBulkPlaceholder(normalizeKey(key), child.length)
        } else {
          out[key] = walk(child, depth + 1)
        }
      }
      return out
    }
    // Functions/symbols/etc. have no business crossing a model boundary.
    return Object.prototype.toString.call(node)
  }

  return walk(value, 0)
}
