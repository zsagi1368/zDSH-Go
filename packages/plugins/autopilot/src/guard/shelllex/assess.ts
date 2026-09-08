/**
 * Semantic assessment of decomposed shell commands and non-shell tools.
 *
 * Philosophy (frozen): the OS sandbox answers "where may I write"; static
 * analysis only recognizes a small set of HIGH-CONFIDENCE semantic effects.
 * Unknown syntax inside the workspace sandbox is allowed by design — parsing
 * failure is not a danger verdict, and prompting on every unrecognized
 * command trains users to click through prompts.
 */
import { isProtectedProjectMeta, isWithin, normalizePath } from '../pathhard.js'
import type { PathRoots } from '../pathhard.js'
import type { SessionArtifacts } from '../artifacts.js'
import { decompose } from './lexer.js'
import type { Assessment, Decision, Segment, ShellKind } from './lexer.js'

const ROUTINE_PREFIXES: readonly string[] = [
  'npm ci', 'npm install', 'npm run build', 'npm test', 'npm run test',
  'pnpm install', 'pnpm ci', 'pnpm build', 'pnpm test', 'pnpm lint',
  'yarn install', 'git commit', 'git status', 'git add', 'git log', 'git diff',
]

/** Download-and-execute package runners always go to the classifier. */
const TEMP_PACKAGE_RUNNERS = ['npx ', 'bunx ', 'pnpm dlx ', 'yarn dlx ', 'npm exec ']

const NETWORK_MUTATION_MARKERS = /\b(curl|wget)\b.*(\s-d\s|--data|-F |--form|-T |--upload-file|--json|-X\s*(POST|PUT|DELETE|PATCH))/i
const NETWORK_TRANSFER_TOOLS = /^(ssh|scp|rsync|sftp)(\s|$)/i

const INFRASTRUCTURE_TOOLS = /^(psql|mysql|mongosh|kubectl|terraform|helm|systemctl|aws|gcloud|az)(\s|$)/i

const SENSITIVE_READ_MARKERS = /(\.env\b|id_rsa|id_ed25519|\.pem\b|\btoken\b|\bpassword\b|\bsecret\b)/i

const DELETION_HEADS = /^(rm|rmdir|del|rd|remove-item|ri)\b/i
const INLINE_INTERPRETERS = /^(node|python3?|ruby|perl|php)(\s|$)/i
const NESTED_DELETE_IN_SOURCE = /\b(rm\s+-rf|rmdir|shutil\.rmtree|fs\.rmSync?\(.*recursive)/i

function firstToken(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function assessWordSegment(
  segment: Segment,
  ctx: { artifacts?: SessionArtifacts | undefined; roots: PathRoots },
): Assessment {
  const text = segment.text
  const lower = text.toLowerCase()

  // Deletion family with five tiers.
  if (DELETION_HEADS.test(lower)) {
    const targets = text.slice(firstToken(text).length).trim()
    const targetTokens = targets.match(/"[^"]*"|'[^']*'|[^\s;|&]+/g) ?? []
    const hasWildcards = /[*?]|\$\{?\w/.test(targets)
    // Hidden executable-ish names, variables, globs, or MULTIPLE literal
    // targets all require splitting into one visible literal per call.
    if (hasWildcards || targetTokens.length > 1) {
      return {
        decision: 'deny',
        reason: 'deletion with non-literal or multiple targets — split into one visible literal target per call',
      }
    }
    const rawTarget = targetTokens[0] ?? ''
    const target = rawTarget.replace(/^["']|["']$/g, '')
    if (target.length > 0) {
      if (ctx.artifacts?.has(target) || ctx.artifacts?.hasTree(target)) {
        return { decision: 'allow', reason: 'deleting an exact session-created artifact' }
      }
      const norm = normalizePath(target)
      if (!norm.isAbsolute || !isWithin(ctx.roots.workspaceRoot, norm.normalized)) {
        return {
          decision: 'classify',
          reason: 'deleting pre-existing data outside the observed session set needs specific user authorization',
        }
      }
      return {
        decision: 'classify',
        reason: 'deleting pre-existing workspace data needs specific user authorization',
      }
    }
    return { decision: 'classify', reason: 'deletion without a visible target' }
  }

  // Inline interpreters: source text gets screened for nested deletion and
  // otherwise SENT TO THE CLASSIFIER — reads and outbound network from
  // `node -e` style code are exactly the hole a free pass would leave.
  if (INLINE_INTERPRETERS.test(lower)) {
    if (NESTED_DELETE_IN_SOURCE.test(text)) {
      return { decision: 'deny', reason: 'nested recursive deletion inside inline interpreter source — perform it as a visible literal command instead' }
    }
    return { decision: 'classify', reason: 'inline interpreter source can read files and reach the network — reviewed semantically' }
  }

  if (TEMP_PACKAGE_RUNNERS.some(runner => lower.startsWith(runner))) {
    return { decision: 'classify', reason: 'download-and-execute of an ad-hoc package' }
  }

  if (NETWORK_MUTATION_MARKERS.test(text) || NETWORK_TRANSFER_TOOLS.test(lower)) {
    return { decision: 'classify', reason: 'outbound network mutation or transfer' }
  }
  if (INFRASTRUCTURE_TOOLS.test(lower)) {
    return { decision: 'classify', reason: 'infrastructure/database tool invocation' }
  }

  if (SENSITIVE_READ_MARKERS.test(text)) {
    return { decision: 'classify', reason: 'potential sensitive credential read' }
  }

  // Write redirection into protected metadata or outside the workspace.
  if (/>\s*\S+/.test(text)) {
    const redirect = text.split('>').pop()?.trim() ?? ''
    const norm = normalizePath(redirect.replace(/^["']|["']$/g, ''))
    if (norm.isAbsolute && !isWithin(ctx.roots.workspaceRoot, norm.normalized)) {
      return { decision: 'classify', reason: 'redirect writes outside the workspace boundary' }
    }
    if (isProtectedProjectMeta(ctx.roots.workspaceRoot, norm.normalized)) {
      return { decision: 'classify', reason: 'writing protected project metadata' }
    }
  }

  for (const prefix of ROUTINE_PREFIXES) {
    if (lower.startsWith(prefix)) return { decision: 'allow', reason: 'routine build/test/vcs work inside the sandbox' }
  }

  // Unknown-but-ordinary command: the workspace-write sandbox confines it.
  return { decision: 'allow', reason: 'unrecognized command confined by the workspace-write sandbox' }
}

export function assessCommandLine(
  shell: ShellKind,
  line: string,
  artifacts: SessionArtifacts | undefined,
  roots: PathRoots,
): Assessment {
  const decomposition = decompose(shell, line)

  if (decomposition.opaqueReason !== undefined && decomposition.segments.length === 0) {
    return opaqueAssessment(line, roots)
  }

  let worst: Assessment = { decision: 'allow', reason: 'sandbox-confined' }
  const rank: Record<Decision, number> = { allow: 0, classify: 1, deny: 2 }
  for (const segment of decomposition.segments) {
    const assessment =
      segment.kind === 'opaque'
        ? opaqueAssessment(segment.text, roots)
        : assessWordSegment(segment, { artifacts, roots })
    if (rank[assessment.decision] > rank[worst.decision]) worst = assessment
    if (worst.decision === 'deny') break
  }
  return worst
}

/**
 * Whole-line opaque fallback: only the small set of high-confidence semantic
 * markers escalates; everything else stays inside the OS sandbox.
 */
export function opaqueAssessment(text: string, roots: PathRoots): Assessment {
  if (NESTED_DELETE_IN_SOURCE.test(text)) {
    return { decision: 'deny', reason: 'nested recursive deletion in statically unreadable source' }
  }
  if (
    NETWORK_MUTATION_MARKERS.test(text) ||
    NETWORK_TRANSFER_TOOLS.test(text.trim()) ||
    INFRASTRUCTURE_TOOLS.test(text.trim()) ||
    TEMP_PACKAGE_RUNNERS.some(r => text.toLowerCase().startsWith(r))
  ) {
    return { decision: 'classify', reason: 'recognized semantic effect inside opaque command' }
  }
  // Inline interpreters stay reviewed even inside unreadable syntax: their
  // source can read files and reach the network.
  if (INLINE_INTERPRETERS.test(text.trim())) {
    return { decision: 'classify', reason: 'inline interpreter source is reviewed semantically' }
  }
  void roots
  return { decision: 'allow', reason: 'opaque syntax remains confined by the workspace-write sandbox' }
}
