/**
 * Plugin dependency-face lint (A2, upgrade process v2.0 §6): scans plugin
 * true-source repositories for host imports that leave the contract face —
 * the guard that keeps the ContextManagement lesson (372 host imports / 15
 * deep-path reaches) from recurring in the eight factory-seeded artifacts.
 *
 * Violation classes (only these fail; contract-face imports are legal):
 * - `deep-path`: a host-org specifier reaching into `/src/`, `/internal/`, or
 *   build-output (`/dist/`, `/lib/`) segments, or naming a source/artifact
 *   file directly (`.ts`, `.js`, …).
 * - `internal-face`: a host-org package explicitly listed as host-internal
 *   wiring in the manifest (zDSH base pieces, boot, test support).
 * - `non-contract-face`: any other host-org package — not on the published
 *   plugin-facing surface, so an import is coupling debt by definition.
 *
 * Configuration lives in `scripts/plugin-dependency-face.manifest.json`
 * (contract face, internal face, default scan targets, exemptions).
 *
 * Run: `tsx scripts/lint-plugin-dependency-face.ts [--target <name|path>]…
 * [--plugins-root <dir>] [--manifest <file>] [--json]`. With no `--target`,
 * the manifest default targets are scanned. Exit is non-zero when any
 * non-exempt violation exists.
 * @module scripts/lint-plugin-dependency-face
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'

const GATE = 'lint-plugin-dependency-face'
const DEFAULT_MANIFEST = resolve(import.meta.dirname, 'plugin-dependency-face.manifest.json')
/** Repository root; anchor for a relative manifest `pluginsRoot` (cwd-independent). */
const REPO_ROOT = resolve(import.meta.dirname, '..')

/** Directories never worth walking in a plugin repository. `del` is the zDSH
 * safe-change backup area: it mirrors historical src trees and must never be
 * scanned (reading it would pollute the baseline with pre-fix snapshots). */
const PRUNED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'lib', 'coverage', '.turbo', 'build', 'del'])

/** Source file extensions scanned for import statements. */
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

/**
 * Path segments that mark a direct reach into source or build output.
 * `dist`/`lib` close the non-JS asset gap (REVIEW-T5 建议4): `dist/theme.css`
 * slips past the extension criterion below, but no contract-face package
 * exports a dist/lib subpath (verified against all 20 contract-face exports
 * maps), so a build-output segment hit is a violation by definition.
 * Evolution direction: match subpaths against each target package's exports
 * map instead of a segment list — deferred because that needs the host
 * manifests resolved inside the scanned external repositories (presence and
 * version drift), disproportionate for the current zero-violation face.
 */
const DEEP_PATH_SEGMENTS = new Set(['src', 'internal', 'dist', 'lib'])

/** File extensions that mark a direct source/artifact file reference. */
const DEEP_PATH_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

/** Violation classes; see the module header. */
export type HostImportViolationKind = 'deep-path' | 'internal-face' | 'non-contract-face'

/** Lint configuration, normally loaded from the manifest file. */
export interface DependencyFaceConfig {
  readonly hostOrgPrefix: string
  readonly pluginsRoot: string
  readonly defaultTargets: readonly { readonly name: string; readonly dir: string }[]
  readonly contractFace: readonly string[]
  readonly internalFace: readonly string[]
  readonly exemptions: readonly { readonly repo: string; readonly specifierPrefix: string; readonly reason: string }[]
}

/** One classified host import site. */
export interface HostImportViolation {
  readonly repo: string
  readonly file: string
  readonly line: number
  readonly specifier: string
  readonly kind: HostImportViolationKind
  readonly reason: string
}

/** One import site found in a scanned file (before classification). */
export interface ImportSite {
  readonly specifier: string
  readonly line: number
}

/** Per-repository scan outcome, including exempted and contract-face counts. */
export interface RepoScanReport {
  readonly repo: string
  readonly root: string
  readonly scannedFiles: number
  readonly hostImportSites: number
  readonly violations: readonly HostImportViolation[]
  readonly exempted: readonly { readonly violation: HostImportViolation; readonly reason: string }[]
}

/** Load and shape-check the lint manifest, failing loudly on drift. */
export function loadDependencyFaceConfig(manifestPath: string): DependencyFaceConfig {
  const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error(`${GATE}: manifest must be an object`)
  const manifest = raw as Record<string, unknown>
  const config: DependencyFaceConfig = {
    hostOrgPrefix: requireString(manifest, 'hostOrgPrefix'),
    pluginsRoot: requireString(manifest, 'pluginsRoot'),
    defaultTargets: requireArray(manifest, 'defaultTargets').map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`${GATE}: defaultTargets[${String(index)}] must be an object`)
      }
      const target = entry as Record<string, unknown>
      return { name: requireString(target, 'name'), dir: requireString(target, 'dir') }
    }),
    contractFace: requireStringArray(manifest, 'contractFace'),
    internalFace: requireStringArray(manifest, 'internalFace'),
    exemptions: requireArray(manifest, 'exemptions').map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`${GATE}: exemptions[${String(index)}] must be an object`)
      }
      const exemption = entry as Record<string, unknown>
      return {
        repo: requireString(exemption, 'repo'),
        specifierPrefix: requireString(exemption, 'specifierPrefix'),
        reason: requireString(exemption, 'reason'),
      }
    }),
  }
  const overlap = config.contractFace.filter(name => config.internalFace.includes(name))
  if (overlap.length > 0) {
    throw new Error(`${GATE}: contractFace and internalFace overlap: ${overlap.join(', ')}`)
  }
  return config
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${GATE}: manifest key ${JSON.stringify(key)} must be a non-empty string`)
  }
  return value
}

function requireArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${GATE}: manifest key ${JSON.stringify(key)} must be an array`)
  return value
}

function requireStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  return requireArray(record, key).map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`${GATE}: ${key}[${String(index)}] must be a non-empty string`)
    }
    return entry
  })
}

/** Split a module specifier into its package name and remaining subpath. */
export function splitPackageSpecifier(specifier: string): { readonly packageName: string; readonly subpath: string } {
  const segments = specifier.split('/')
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier)
  return { packageName, subpath: specifier.slice(packageName.length) }
}

/**
 * Classify one host-org specifier. Returns null when the import is legal
 * (contract face, no deep reach); otherwise the violation kind and reason.
 */
export function classifyHostSpecifier(
  specifier: string,
  config: Pick<DependencyFaceConfig, 'hostOrgPrefix' | 'contractFace' | 'internalFace'>,
): { readonly kind: HostImportViolationKind; readonly reason: string } | null {
  if (!specifier.startsWith(config.hostOrgPrefix)) return null
  const { packageName, subpath } = splitPackageSpecifier(specifier)
  const subpathSegments = subpath.split('/').filter(segment => segment.length > 0)
  const lastSegment = subpathSegments[subpathSegments.length - 1] ?? ''
  const extension = lastSegment.includes('.') ? lastSegment.slice(lastSegment.lastIndexOf('.')) : ''
  if (subpathSegments.some(segment => DEEP_PATH_SEGMENTS.has(segment)) || DEEP_PATH_EXTENSIONS.has(extension)) {
    return {
      kind: 'deep-path',
      reason: `reaches past the published export surface (subpath ${JSON.stringify(subpath)})`,
    }
  }
  if (config.internalFace.includes(packageName)) {
    return { kind: 'internal-face', reason: `${packageName} is host-internal wiring, not plugin-facing` }
  }
  if (!config.contractFace.includes(packageName)) {
    return { kind: 'non-contract-face', reason: `${packageName} is not on the contract face` }
  }
  return null
}

/** Collect every static/dynamic import specifier from TypeScript source text. */
export function collectImportSites(sourceText: string, fileName: string): readonly ImportSite[] {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
  const sites: ImportSite[] = []
  const visit = (node: ts.Node): void => {
    let specifierNode: ts.Expression | undefined
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      specifierNode = node.moduleSpecifier
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) specifierNode = node.arguments[0]
    }
    if (specifierNode !== undefined && ts.isStringLiteralLike(specifierNode)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(specifierNode.getStart(sourceFile))
      sites.push({ specifier: specifierNode.text, line: line + 1 })
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return sites
}

/** True when a repo-relative path lives inside a `src` directory. */
export function isSrcPath(relativePath: string): boolean {
  const segments = relativePath.split('/')
  return segments.slice(0, -1).includes('src')
}

/** Walk one plugin repository and classify every host import inside src. */
export function scanRepository(repo: string, root: string, config: DependencyFaceConfig): RepoScanReport {
  const violations: HostImportViolation[] = []
  const exempted: { readonly violation: HostImportViolation; readonly reason: string }[] = []
  let scannedFiles = 0
  let hostImportSites = 0

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNED_DIRECTORIES.has(entry.name)) continue
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const extension = entry.name.slice(entry.name.lastIndexOf('.'))
      if (!SCANNED_EXTENSIONS.has(extension) || entry.name.endsWith('.d.ts')) continue
      const relative = absolute.slice(root.length + 1).split(sep).join('/')
      if (!isSrcPath(relative)) continue
      scannedFiles += 1
      for (const site of collectImportSites(readFileSync(absolute, 'utf8'), relative)) {
        if (!site.specifier.startsWith(config.hostOrgPrefix)) continue
        hostImportSites += 1
        const classification = classifyHostSpecifier(site.specifier, config)
        if (classification === null) continue
        const violation: HostImportViolation = {
          repo,
          file: relative,
          line: site.line,
          specifier: site.specifier,
          kind: classification.kind,
          reason: classification.reason,
        }
        const exemption = config.exemptions.find(candidate =>
          candidate.repo === repo && site.specifier.startsWith(candidate.specifierPrefix))
        if (exemption !== undefined) exempted.push({ violation, reason: exemption.reason })
        else violations.push(violation)
      }
    }
  }

  if (!statSync(root).isDirectory()) throw new Error(`${GATE}: scan target ${root} is not a directory`)
  walk(root)
  return { repo, root, scannedFiles, hostImportSites, violations, exempted }
}

interface CliOptions {
  readonly manifestPath: string
  readonly pluginsRoot: string | null
  readonly targets: readonly string[]
  readonly json: boolean
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let manifestPath = DEFAULT_MANIFEST
  let pluginsRoot: string | null = null
  let json = false
  const targets: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--manifest' || arg === '--plugins-root' || arg === '--target') {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${GATE}: ${arg} requires a value`)
      index += 1
      if (arg === '--manifest') manifestPath = value
      else if (arg === '--plugins-root') pluginsRoot = value
      else targets.push(value)
      continue
    }
    throw new Error(`${GATE}: unknown argument ${JSON.stringify(arg)}`)
  }
  return { manifestPath, pluginsRoot, targets, json }
}

/** Resolve CLI/manifest inputs into the concrete list of repositories to scan. */
export function resolveScanTargets(options: {
  readonly config: DependencyFaceConfig
  readonly cliTargets: readonly string[]
  readonly pluginsRoot: string | null
}): readonly { readonly name: string; readonly root: string }[] {
  // The manifest pluginsRoot may be relative (portable default, REVIEW-T5
  // 建议3): it anchors at the repository root, independent of the process
  // cwd. Absolute manifest values pass through resolve() unchanged, and the
  // --plugins-root CLI override keeps its cwd-relative CLI semantics.
  const root = options.pluginsRoot ?? resolve(REPO_ROOT, options.config.pluginsRoot)
  if (options.cliTargets.length > 0) {
    return options.cliTargets.map((target) => {
      const named = options.config.defaultTargets.find(entry => entry.name === target)
      const absolute = named !== undefined ? resolve(root, named.dir) : resolve(target)
      return { name: named?.name ?? target, root: absolute }
    })
  }
  return options.config.defaultTargets.map(entry => ({ name: entry.name, root: resolve(root, entry.dir) }))
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const options = parseCliOptions(process.argv.slice(2))
  const config = loadDependencyFaceConfig(options.manifestPath)
  const targets = resolveScanTargets({ config, cliTargets: options.targets, pluginsRoot: options.pluginsRoot })
  const reports = targets.map(target => scanRepository(target.name, target.root, config))

  const totalViolations = reports.reduce((sum, report) => sum + report.violations.length, 0)
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ gate: GATE, reports, totalViolations }, null, 2)}\n`)
  } else {
    for (const report of reports) {
      process.stdout.write(`${GATE}: ${report.repo}: ${String(report.scannedFiles)} src file(s),`
        + ` ${String(report.hostImportSites)} host import site(s),`
        + ` ${String(report.violations.length)} violation(s),`
        + ` ${String(report.exempted.length)} exempted\n`)
      for (const violation of report.violations) {
        process.stdout.write(`  [${violation.kind}] ${violation.file}:${String(violation.line)}`
          + ` ${violation.specifier} — ${violation.reason}\n`)
      }
      for (const entry of report.exempted) {
        process.stdout.write(`  [exempt:${entry.violation.kind}] ${entry.violation.file}:${String(entry.violation.line)}`
          + ` ${entry.violation.specifier} — ${entry.reason}\n`)
      }
    }
  }
  if (totalViolations > 0) {
    process.stderr.write(`${GATE}: ${String(totalViolations)} dependency-face violation(s) across`
      + ` ${String(reports.length)} repository(ies).\n`)
    process.exit(1)
  }
  if (!options.json) process.stdout.write(`${GATE}: dependency face clean.\n`)
}
