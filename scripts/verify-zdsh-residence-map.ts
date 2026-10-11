/**
 * zDSH residence map gate (A6, upgrade process v2.0 §6): maintains the
 * official-path ↔ zDSH-artifact residence mapping and compares an upstream
 * ref tree against it, so an L2 pre-check (P1) is a scripted comparison
 * instead of a manual path walk.
 *
 * Findings:
 * - `add-add-path`: the upstream tree grew content at a zDSH residence path
 *   (`packages/zdsh/*` or the root `zdsh-factory/` seed directory), which a
 *   merge would surface as an add/add conflict.
 * - `add-add-name`: upstream published a workspace package under a name a
 *   zDSH artifact already carries (TD-1 name-squatting trigger; pnpm would
 *   fail the install loudly with a duplicate workspace name).
 * - `resurrected-former-path`: upstream recreated the pre-migration path a
 *   zDSH artifact used to occupy; not a git conflict after T2 (the artifact
 *   moved), but a semantic double-residence that P1 must adjudicate.
 * - `broken-link`: upstream deleted a workspace-supplied package that a zDSH
 *   artifact depends on (dependency edge would dangle after the merge). Edges to
 *   a {@link RETAINED_UPSTREAM_REMOVALS} package are known exceptions, not findings.
 *
 * Run: `tsx scripts/verify-zdsh-residence-map.ts [--ref <git-ref>] [--json]`.
 * The default ref is `upstream/master`; fetching that ref is a P0/P1 step
 * owned by the operator, this gate never touches the network.
 * @module scripts/verify-zdsh-residence-map
 */

import { spawnSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const GATE = 'verify-zdsh-residence-map'
const DEFAULT_REF = 'upstream/master'
const HOST_ORG_PREFIX = '@deepseek-ai/'

/**
 * Packages upstream removed that zDSH deliberately retains: a zDSH artifact may
 * keep depending on them without a merge action, so their edges are not broken
 * links. Each entry states the retention decision.
 */
const RETAINED_UPSTREAM_REMOVALS: ReadonlyMap<string, string> = new Map([
  ['@deepseek-ai/dsh-invariants',
    'zDSH retains the package-owned invariant registry (and the /invariant companion '
    + 'subpath aliases) for the type chain after the official 0.2.1-alpha.2 '
    + 'runtime-invariants removal; the service is not mounted, so no runtime '
    + 'behavior depends on the official decision'],
])

/** Workspace manifest globs that define the host-supplied package index. */
const WORKSPACE_MANIFEST_GLOBS = ['packages/*/*/package.json', 'vendor/*/package.json'] as const

/** Git tree areas compared against the residence map. */
const COMPARED_TREE_AREAS = ['packages', 'vendor', 'zdsh-factory'] as const

/** One self-authored zDSH artifact and its official-path counterpart status. */
export interface ZdshResidenceEntry {
  /** Repo-relative residence directory after the T2 migration. */
  readonly dir: string
  /** Workspace package name, or null for non-package artifacts (seed dir). */
  readonly packageName: string | null
  /** Pre-T2 path in the official layout, or null when there never was one. */
  readonly formerPath: string | null
  /** Official-path counterpart status, one line, kept current by hand. */
  readonly officialCounterpart: string
}

/**
 * The mapping table. Baseline = T1 migration design §3 (five packages under
 * `packages/zdsh/*`) plus the root-level `zdsh-factory/` seed directory
 * (TD-3); the SYNC-P1 ruling (2026-09-28) added the governance UI tab as a
 * sixth migrated package. Update this table whenever a zDSH artifact moves
 * or is added.
 */
export const ZDSH_RESIDENCE_MAP: readonly ZdshResidenceEntry[] = [
  {
    dir: 'packages/zdsh/dsh-compat',
    packageName: '@deepseek-ai/dsh-compat',
    formerPath: 'packages/compat/dsh-compat',
    officialCounterpart: 'no official counterpart; the former packages/compat group was zDSH-created and removed by T2',
  },
  {
    dir: 'packages/zdsh/plugin-governance',
    packageName: '@deepseek-ai/dsh-plugin-governance',
    formerPath: 'packages/plugins/plugin-governance',
    officialCounterpart: 'no official counterpart; the former packages/plugins group was zDSH-created and removed by T2',
  },
  {
    dir: 'packages/zdsh/plugin-governance-host',
    packageName: '@deepseek-ai/dsh-plugin-governance-host',
    formerPath: 'packages/host/plugin-governance-host',
    officialCounterpart: 'packages/host is an official group; the former subdirectory was zDSH-created inside it',
  },
  {
    // SYNC-P1 ruling (2026-09-28): formerPath is deliberately null. The former
    // residence packages/client/ui-plugin-manager became official territory in
    // 0.1.7-rc.2 (sidebar Plugins panel), so a non-null formerPath would make
    // the resurrected-former-path check fire permanently against legitimate
    // official content. The former-path history is carried by the
    // officialCounterpart status column instead (TD-3 semantics).
    dir: 'packages/zdsh/plugin-governance-ui',
    packageName: '@deepseek-ai/dsh-client-ui-plugin-governance',
    formerPath: null,
    officialCounterpart: 'former packages/client/ui-plugin-manager is officially owned since 0.1.7-rc.2 (sidebar Plugins panel); the zDSH governance tab relocated out of the collision path',
  },
  {
    dir: 'packages/zdsh/plugin-project-root',
    packageName: '@deepseek-ai/dsh-plugin-project-root',
    formerPath: 'packages/plugins/plugin-project-root',
    officialCounterpart: 'no official counterpart; the former packages/plugins group was zDSH-created and removed by T2',
  },
  {
    dir: 'packages/zdsh/factory-bundle',
    packageName: '@deepseek-ai/zdsh-factory-bundle',
    formerPath: 'packages/factory/zdsh-factory-bundle',
    officialCounterpart: 'no official counterpart; the former packages/factory group was zDSH-created and removed by T2',
  },
  {
    dir: 'zdsh-factory',
    packageName: null,
    formerPath: null,
    officialCounterpart: 'root-level seed directory (zdsh-factory/seed.json), zDSH-created, outside packages/',
  },
]

/** Upstream tree facts the gate compares against; built from git or fixtures. */
export interface UpstreamTreeFacts {
  /** Git ref the facts were read from. */
  readonly ref: string
  /** Every tracked file path inside the compared tree areas. */
  readonly paths: readonly string[]
  /** Workspace package name → manifest path, over packages/ and vendor/. */
  readonly packageNames: ReadonlyMap<string, string>
}

/** Finding classes; see the module header for their merge semantics. */
export type ResidenceFindingKind = 'add-add-path' | 'add-add-name' | 'resurrected-former-path' | 'broken-link'

/** One conflict pre-warning emitted by the gate. */
export interface ResidenceFinding {
  readonly kind: ResidenceFindingKind
  readonly artifact: string
  readonly detail: string
}

/** zDSH package name → host-org dependency names declared by its manifest. */
export type ZdshDependencyIndex = ReadonlyMap<string, readonly string[]>

/** Input for the pure comparison; CLI mode builds it from git and the worktree. */
export interface ResidenceCheckInput {
  readonly map?: readonly ZdshResidenceEntry[]
  readonly upstream: UpstreamTreeFacts
  /** Package names supplied by the local (zDSH) workspace index. */
  readonly localPackageNames: ReadonlyMap<string, string>
  readonly dependencies: ZdshDependencyIndex
}

/** Compare the residence map against upstream tree facts and report findings. */
export function checkResidenceMap(input: ResidenceCheckInput): readonly ResidenceFinding[] {
  const map = input.map ?? ZDSH_RESIDENCE_MAP
  const findings: ResidenceFinding[] = []
  const ownNames = new Set(map.flatMap(entry => entry.packageName === null ? [] : [entry.packageName]))

  for (const entry of map) {
    if (containsTreeDirectory(input.upstream.paths, entry.dir)) {
      findings.push({
        kind: 'add-add-path',
        artifact: entry.dir,
        detail: `upstream ${input.upstream.ref} grew content under the zDSH residence path ${entry.dir}/`,
      })
    }
    if (entry.formerPath !== null && containsTreeDirectory(input.upstream.paths, entry.formerPath)) {
      findings.push({
        kind: 'resurrected-former-path',
        artifact: entry.dir,
        detail: `upstream ${input.upstream.ref} recreated the former zDSH path ${entry.formerPath}/`
          + ` while the artifact now lives at ${entry.dir}`,
      })
    }
    if (entry.packageName === null) continue
    const upstreamPath = input.upstream.packageNames.get(entry.packageName)
    if (upstreamPath !== undefined) {
      findings.push({
        kind: 'add-add-name',
        artifact: entry.packageName,
        detail: `upstream ${input.upstream.ref} declares ${entry.packageName} at ${upstreamPath}`
          + ` while zDSH carries it at ${entry.dir} (TD-1 name-squatting trigger)`,
      })
    }
  }

  for (const [packageName, dependencies] of input.dependencies) {
    for (const dependency of dependencies) {
      if (ownNames.has(dependency)) continue
      // Only workspace-supplied edges can break through an upstream deletion;
      // registry/git-pinned dependencies are outside this gate's model.
      if (!input.localPackageNames.has(dependency)) continue
      if (input.upstream.packageNames.has(dependency)) continue
      if (RETAINED_UPSTREAM_REMOVALS.has(dependency)) continue
      findings.push({
        kind: 'broken-link',
        artifact: packageName,
        detail: `${packageName} depends on ${dependency}, which the local workspace supplies`
          + ` but upstream ${input.upstream.ref} no longer declares`,
      })
    }
  }
  return findings
}

/** True when any tracked file path lives inside the given tree directory. */
export function containsTreeDirectory(paths: readonly string[], dir: string): boolean {
  const prefix = `${dir}/`
  return paths.some(path => path.startsWith(prefix))
}

/**
 * Parse `git cat-file --batch` output into a package-name → manifest-path
 * index. The batch protocol echoes the resolved object SHA (not the input
 * spec) on blob headers and reports content sizes in bytes, so the output is
 * consumed as a byte buffer and entries pair positionally with
 * `manifestPaths`, which must be the input list in request order. Missing
 * objects and manifests without a top-level string name are skipped.
 */
export function parseCatFileBatchNameIndex(
  batchOutput: Buffer,
  manifestPaths: readonly string[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  const LF = 0x0a
  let position = 0
  let inputIndex = 0
  const header = /^\S+ (blob|missing)(?: (\d+))?\r?$/
  while (position < batchOutput.byteLength && inputIndex < manifestPaths.length) {
    const headerEnd = batchOutput.indexOf(LF, position)
    if (headerEnd === -1) break
    const match = header.exec(batchOutput.toString('ascii', position, headerEnd))
    const manifestPath = manifestPaths[inputIndex]
    inputIndex += 1
    position = headerEnd + 1
    if (match === null) {
      throw new Error(`${GATE}: git cat-file --batch protocol desync at input ${String(inputIndex)}`)
    }
    // A `missing` header carries no content body; the next line is already the
    // next header.
    if (match[1] === 'missing' || match[2] === undefined) continue
    const size = Number.parseInt(match[2], 10)
    // Byte-exact slice: manifests may contain multibyte UTF-8 (e.g. section
    // signs in descriptions), so character offsets would drift.
    const content = batchOutput.toString('utf8', position, position + size)
    position += size
    // Batch content is followed by a single LF.
    if (batchOutput[position] === LF) position += 1
    const name = parseManifestName(content)
    if (name === null || manifestPath === undefined) continue
    names.set(name, manifestPath)
  }
  return names
}

/** Read the top-level `name` string out of a package manifest's JSON text. */
export function parseManifestName(manifestText: string): string | null {
  try {
    const manifest: unknown = JSON.parse(manifestText)
    if (typeof manifest === 'object' && manifest !== null && 'name' in manifest) {
      const name = (manifest as { name?: unknown }).name
      if (typeof name === 'string' && name.length > 0) return name
    }
  } catch {
    // Unparseable manifests contribute no name; the gate stays read-only.
  }
  return null
}

/** Read workspace package names from the local working tree. */
export function collectLocalPackageNameIndex(root: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const glob of WORKSPACE_MANIFEST_GLOBS) {
    for (const manifestPath of globSync(glob, { cwd: root })) {
      const normalized = manifestPath.split('\\').join('/')
      const name = parseManifestName(readFileSync(resolve(root, normalized), 'utf8'))
      if (name !== null) names.set(name, normalized)
    }
  }
  return names
}

/**
 * Collect host-org dependency names declared by the mapped zDSH packages.
 * devDependencies are scanned too (REVIEW-T5 建议1): the zDSH specs consume
 * host packages through dev edges (for example plugin-project-root's specs
 * import @deepseek-ai/dsh-tools), and a dev-only edge dangles exactly like a
 * runtime one when upstream deletes the supplying package.
 */
export function collectZdshDependencies(
  root: string,
  map: readonly ZdshResidenceEntry[] = ZDSH_RESIDENCE_MAP,
): ZdshDependencyIndex {
  const dependencies = new Map<string, readonly string[]>()
  for (const entry of map) {
    if (entry.packageName === null) continue
    const manifestText = readFileSync(resolve(root, entry.dir, 'package.json'), 'utf8')
    const manifest: unknown = JSON.parse(manifestText)
    if (typeof manifest !== 'object' || manifest === null) continue
    const declared = new Set<string>()
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const) {
      const entries: unknown = (manifest as Record<string, unknown>)[section]
      if (typeof entries !== 'object' || entries === null) continue
      for (const name of Object.keys(entries)) {
        if (name.startsWith(HOST_ORG_PREFIX)) declared.add(name)
      }
    }
    dependencies.set(entry.packageName, [...declared].sort())
  }
  return dependencies
}

/** Run one git command inside the repository and return stdout, failing loudly. */
function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error !== undefined) throw new Error(`${GATE}: git ${args.join(' ')} failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${GATE}: git ${args.join(' ')} exited ${String(result.status)}: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** Build the upstream tree facts by reading a git ref; never touches the network. */
export function readUpstreamTreeFacts(root: string, ref: string): UpstreamTreeFacts {
  const listing = git(root, ['ls-tree', '-r', '--name-only', ref, '--', ...COMPARED_TREE_AREAS])
  const paths = listing.split('\n').filter(line => line.length > 0)
  const manifestPaths = paths.filter(path =>
    /^packages\/[^/]+\/[^/]+\/package\.json$/.test(path) || /^vendor\/[^/]+\/package\.json$/.test(path))
  const specs = manifestPaths.map(path => `${ref}:${path}`)
  const packageNames = manifestPaths.length === 0
    ? new Map<string, string>()
    : parseCatFileBatchNameIndex(gitBatch(root, specs), manifestPaths)
  return { ref, paths, packageNames }
}

/** Feed object specs to `git cat-file --batch` and return the raw batch bytes. */
function gitBatch(root: string, specs: readonly string[]): Buffer {
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: root,
    encoding: 'buffer',
    input: Buffer.from(`${specs.join('\n')}\n`, 'utf8'),
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error !== undefined) throw new Error(`${GATE}: git cat-file --batch failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${GATE}: git cat-file --batch exited ${String(result.status)}: ${result.stderr.toString('utf8').trim()}`)
  }
  return result.stdout
}

interface CliOptions {
  readonly ref: string
  readonly json: boolean
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let ref = DEFAULT_REF
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--ref') {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${GATE}: --ref requires a value`)
      ref = value
      index += 1
    } else if (arg === '--json') {
      json = true
    } else {
      throw new Error(`${GATE}: unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return { ref, json }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const options = parseCliOptions(process.argv.slice(2))
  const upstream = readUpstreamTreeFacts(ROOT, options.ref)
  const localPackageNames = collectLocalPackageNameIndex(ROOT)
  const dependencies = collectZdshDependencies(ROOT)
  const findings = checkResidenceMap({ upstream, localPackageNames, dependencies })

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      gate: GATE,
      ref: options.ref,
      map: ZDSH_RESIDENCE_MAP,
      findings,
    }, null, 2)}\n`)
  } else {
    process.stdout.write(`${GATE}: residence map = ${String(ZDSH_RESIDENCE_MAP.length)} artifact(s),`
      + ` ref = ${options.ref} (${String(upstream.packageNames.size)} upstream workspace name(s)).\n`)
    for (const entry of ZDSH_RESIDENCE_MAP) {
      process.stdout.write(`  ${entry.dir} <- ${entry.formerPath ?? '(zDSH-created)'} [${entry.officialCounterpart}]\n`)
    }
  }

  if (findings.length > 0) {
    process.stderr.write(`${GATE}: ${String(findings.length)} conflict pre-warning(s):\n`)
    for (const finding of findings) {
      process.stderr.write(`  [${finding.kind}] ${finding.artifact}: ${finding.detail}\n`)
    }
    process.exit(1)
  }
  if (!options.json) {
    process.stdout.write(`${GATE}: no residence conflict against ${options.ref}.\n`)
  }
}
