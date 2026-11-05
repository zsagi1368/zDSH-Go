// Snapshot governance for the zDSH-plugins/ContextManagement mirror (D7, CTX-OPT-20261104 REPORT-OPT.md §7).
//
// AUTHORITY DECLARATION (2026-11-04)
//   The zDSH-go tree (this repository) is the SOLE AUTHORITY for the context-cache
//   management modules — the L5 guardian (`packages/llm/llm-pi-ai/src/cache-guardian.ts`),
//   the L3 pruning vocabulary (`packages/core/tools/src/l3.ts`), L0 cache-metrics
//   (`packages/llm/token-meter/src/cache-metrics.ts`), the L1 budget
//   (`packages/llm/model-slots/src/budget.ts`), the L4 return cap
//   (`packages/subagent/subagent/src/return-cap.ts`), and every other file mirrored
//   into the plugin repository's `plugin/` and `packages/` tracks.
//   The copies in the sibling plugin repository (zDSH-plugins/ContextManagement) are
//   READ-ONLY, ONE-WAY GENERATED snapshots of this tree from this declaration on.
//   Dual-head sync is forbidden: edit this tree, never the snapshot; the snapshot is
//   regenerated / drift-checked FROM this tree (this script). The former
//   "kept byte-identical" hand-sync wording in the plugin repository's README is
//   superseded by this declaration.
//
// This wave ships the `--check` mode only. Coverage is reported in BOTH directions:
//   snapshot -> authority  per-file SHA-256 comparison (MATCH / DRIFT), plus
//                          MISSING-AUTHORITY (snapshot has no counterpart here) and
//                          PLUGIN-TRACK-UNMAPPED (snapshot plugin-track file absent
//                          from PLUGIN_TRACK_MAP);
//   authority -> snapshot  AUTHORITY-ONLY (authority file in a mirror-covered
//                          directory with no snapshot counterpart — content this
//                          tree owns that the mirror does not carry yet;
//                          informational: extending the mirror is a maintainer
//                          decision, so these never fail --strict, and
//                          package-local metadata is excluded symmetrically with
//                          the forward EXCLUDED-CONFIG class).
// Snapshot drift is REPORTED, not written back; writeback generation from this tree
// is a later, separately-gated piece of work.
//
// The cache/ledger dual `declare module` same-shape assertion (agent.ts and
// token-meter/cache-metrics.ts must declare the same event vocabulary — interface
// merging makes a shape split a silent type hole) is FAIL-LOUD: if either file
// yields no parseable event vocabulary (module name or interface renamed away,
// unbalanced braces), the run aborts with exit 1 instead of comparing empty maps
// to empty maps and calling them equal (REV-A-1). Both single- and double-quoted
// module specifiers parse; the assertion never silently skips.
//
// Usage:
//   node scripts/generate-plugin-snapshots.mjs --check [--strict]
//        [--plugins-root <path>] [--authority-root <path>]
//
// Path resolution: the default plugin root is `<repo>/../../zDSH-plugins/ContextManagement`
// and the default authority root is this repository, both resolved against the
// REPOSITORY ROOT (the parent of scripts/). An explicit `--plugins-root` /
// `--authority-root` value is ALSO resolved against the repository root when
// relative — not against the process cwd (REV-A-7); pass an absolute path to
// escape the repository entirely.
//
// Exit codes:
//   0  check ran; drift/missing/coverage gaps may be reported (see output) unless --strict
//   1  hard failure: same-shape assertion violated or unparseable declare block,
//      plugin repository not found, or --strict and any reported gap
//
// Snapshot-side layout (zDSH-plugins/ContextManagement):
//   packages/**  path-for-path mirror (same relative path in this repository)
//   plugin/src   plugin-track modules, mapped to their authority files via PLUGIN_TRACK_MAP
//   plugin/tests plugin-track specs, mapped likewise
// Only TypeScript sources are compared; the mirror's package.json / tsconfig.json are
// fork-scoped patch context and are listed as EXCLUDED-CONFIG, not compared.
// Automated coverage for the assertion semantics lives in
// scripts/generate-plugin-snapshots.spec.ts (REV-A-5).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PLUGIN_TRACK_MAP = [
  ['plugin/src/budget.ts', 'packages/llm/model-slots/src/budget.ts'],
  ['plugin/src/cache-guardian.ts', 'packages/llm/llm-pi-ai/src/cache-guardian.ts'],
  ['plugin/src/cache-metrics.ts', 'packages/llm/token-meter/src/cache-metrics.ts'],
  ['plugin/src/l3.ts', 'packages/core/tools/src/l3.ts'],
  ['plugin/src/return-cap.ts', 'packages/subagent/subagent/src/return-cap.ts'],
  ['plugin/tests/budget.spec.ts', 'packages/llm/model-slots/tests/budget.spec.ts'],
  ['plugin/tests/cache-guardian.spec.ts', 'packages/llm/llm-pi-ai/tests/cache-guardian.spec.ts'],
  ['plugin/tests/cache-metrics.spec.ts', 'packages/llm/token-meter/tests/cache-metrics.spec.ts'],
  ['plugin/tests/cache-metrics-ledger.spec.ts', 'packages/llm/token-meter/tests/cache-metrics-ledger.spec.ts'],
  ['plugin/tests/l3.spec.ts', 'packages/core/tools/tests/l3.spec.ts'],
  ['plugin/tests/return-cap.spec.ts', 'packages/subagent/subagent/tests/return-cap.spec.ts'],
  // plugin/src/index.ts is intentionally absent (KNOWN_UNMAPPED_SNAPSHOT_FILES below):
  // it is plugin-bundle glue with no authority counterpart in this tree, so the
  // plugin repository stays its owner.
]

// Snapshot plugin-track files with no authority counterpart, by design. They are
// reported as UNMAPPED-EXPECTED rather than as a coverage gap; anything else that
// shows up unmapped is a real gap and fails --strict.
const KNOWN_UNMAPPED_SNAPSHOT_FILES = new Set(['plugin/src/index.ts'])

// agent.ts authors the `cache/ledger` event; cache-metrics.ts re-declares it because
// project-references builds compile token-meter without agent-loop in its program.
const DUAL_DECLARE_FILES = [
  'packages/core/agent-loop/src/agent.ts',
  'packages/llm/token-meter/src/cache-metrics.ts',
]
const DUAL_DECLARE_MODULE = '@deepseek-ai/dsh-session/types'
const DUAL_DECLARE_INTERFACE = 'SessionEventMap'

function usage(fail) {
  const lines = [
    'Usage: node scripts/generate-plugin-snapshots.mjs --check [--strict] [--plugins-root <path>] [--authority-root <path>]',
    '  --check               compare this tree (authority) against the plugin-repository snapshot, both directions',
    '  --strict              fail when reported drift/missing/plugin-track gaps exist (AUTHORITY-ONLY is informational)',
    '  --plugins-root <p>    plugin repository root; relative values resolve against the REPOSITORY ROOT, not cwd',
    '  --authority-root <p>  authority tree root; relative values resolve against the REPOSITORY ROOT, not cwd (default: this repository)',
    '  -h, --help            print this usage and exit',
  ]
  for (const line of lines) console.log(line)
  if (fail) process.exit(1)
  process.exit(0)
}

function parseArgs(args) {
  if (args.includes('-h') || args.includes('--help')) usage(false)
  if (!args.includes('--check')) usage(true)
  const valueAfter = (flag) => {
    const index = args.indexOf(flag)
    return index >= 0 ? args[index + 1] : undefined
  }
  // Both overrides resolve against the repository root, matching the default paths
  // (REV-A-7: relative --plugins-root must not silently depend on the caller's cwd).
  const pluginsRoot = resolve(repoRoot, valueAfter('--plugins-root') ?? join(repoRoot, '..', '..', 'zDSH-plugins', 'ContextManagement'))
  const authorityRoot = resolve(repoRoot, valueAfter('--authority-root') ?? repoRoot)
  if (!existsSync(pluginsRoot)) {
    console.error(`generate-plugin-snapshots: plugin repository not found at ${pluginsRoot}`)
    console.error('Pass --plugins-root <path> (relative values resolve against the repository root) to point at zDSH-plugins/ContextManagement.')
    process.exit(1)
  }
  if (!existsSync(authorityRoot)) {
    console.error(`generate-plugin-snapshots: authority root not found at ${authorityRoot}`)
    process.exit(1)
  }
  return { pluginsRoot, authorityRoot, strict: args.includes('--strict') }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function listFiles(root, base) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'lib') continue
        walk(full)
      } else if (entry.isFile()) {
        out.push(relative(base, full).split(sep).join('/'))
      }
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Extract every `declare module '<name>' { interface <iface> { ... } }` event
 * vocabulary. FAIL-LOUD (REV-A-1): a missing module block, a missing interface,
 * or zero parsed events throws instead of returning an empty map — two empty
 * maps must never compare equal. Single- and double-quoted module specifiers
 * both parse.
 */
export function extractDeclaredEvents(source, moduleName, interfaceName, origin) {
  const moduleRe = new RegExp(`declare\\s+module\\s+['"]${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\{`)
  const moduleMatch = moduleRe.exec(source)
  if (moduleMatch === null) {
    throw new Error(`generate-plugin-snapshots: no 'declare module ${moduleName}' block found in ${origin}; the dual-declare same-shape gate cannot run on an unparseable file (fail-loud, REV-A-1)`)
  }
  const moduleBody = balancedBlock(source, source.indexOf('{', moduleMatch.index), origin, 'declare module')
  const ifaceIndex = moduleBody.indexOf(`interface ${interfaceName}`)
  if (ifaceIndex === -1) {
    throw new Error(`generate-plugin-snapshots: 'interface ${interfaceName}' not found inside the 'declare module ${moduleName}' block of ${origin}; the dual-declare same-shape gate cannot run (fail-loud, REV-A-1)`)
  }
  const ifaceBody = balancedBlock(moduleBody, moduleBody.indexOf('{', ifaceIndex), origin, `interface ${interfaceName}`)
  const events = new Map()
  const entryRe = /['"]([a-z0-9/-]+)['"]\s*:\s*\{/g
  let entry
  while ((entry = entryRe.exec(ifaceBody)) !== null) {
    const payload = balancedBlock(ifaceBody, ifaceBody.indexOf('{', entry.index), origin, `event ${entry[1]}`)
    events.set(entry[1], parsePayloadKeys(payload, origin, entry[1]))
  }
  if (events.size === 0) {
    throw new Error(`generate-plugin-snapshots: zero event entries parsed from 'interface ${interfaceName}' in ${origin}; refusing to compare an empty vocabulary (fail-loud, REV-A-1)`)
  }
  return events
}

/** Return the text of the `{ ... }` block opening at `openIndex` (inclusive). */
function balancedBlock(text, openIndex, origin, what) {
  if (text[openIndex] !== '{') {
    throw new Error(`generate-plugin-snapshots: cannot locate '{' for ${what} in ${origin}`)
  }
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(openIndex, i + 1)
    }
  }
  throw new Error(`generate-plugin-snapshots: unbalanced braces for ${what} in ${origin}`)
}

/** Top-level `key: type` pairs of a payload block, comments stripped, whitespace collapsed.
 * Interface members are `key: type` lines (commas optional in TS), so keys are matched
 * per line and values stay on their own line — a greedy multi-line value would swallow
 * the following member and under-report the vocabulary (Z10). */
function parsePayloadKeys(payload, origin, eventName) {
  const body = payload.slice(1, -1)
  const clean = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const keys = new Map()
  const keyRe = /^[ \t]*([A-Za-z_$][\w$]*)[ \t]*:[ \t]*([^,\n{}]+?)[ \t]*$/gm
  let key
  while ((key = keyRe.exec(clean)) !== null) {
    keys.set(key[1], key[2].replace(/\s+/g, ' ').trim())
  }
  if (keys.size === 0) {
    throw new Error(`generate-plugin-snapshots: no payload keys parsed for ${eventName} in ${origin}`)
  }
  return keys
}

export function assertDualDeclareSameShape(sources) {
  const declarations = sources.map(({ rel, source }) => ({
    rel,
    events: extractDeclaredEvents(source, DUAL_DECLARE_MODULE, DUAL_DECLARE_INTERFACE, rel),
  }))
  let ok = true
  const [first, ...rest] = declarations
  for (const other of rest) {
    const namesA = [...first.events.keys()].sort()
    const namesB = [...other.events.keys()].sort()
    if (namesA.join(',') !== namesB.join(',')) {
      ok = false
      console.log(`SAME-SHAPE FAIL: event vocabulary diverges between ${first.rel} and ${other.rel}`)
      console.log(`  ${first.rel}: ${namesA.join(', ') || '(none)'}`)
      console.log(`  ${other.rel}: ${namesB.join(', ') || '(none)'}`)
      continue
    }
    for (const name of namesA) {
      const keysA = first.events.get(name)
      const keysB = other.events.get(name)
      const sigA = [...keysA].map(([k, t]) => `${k}: ${t}`).sort().join('; ')
      const sigB = [...keysB].map(([k, t]) => `${k}: ${t}`).sort().join('; ')
      if (sigA !== sigB) {
        ok = false
        console.log(`SAME-SHAPE FAIL: payload of '${name}' diverges between ${first.rel} and ${other.rel}`)
        console.log(`  ${first.rel}: ${sigA}`)
        console.log(`  ${other.rel}: ${sigB}`)
      }
    }
  }
  if (ok) {
    console.log(`SAME-SHAPE OK: ${DUAL_DECLARE_MODULE} ${DUAL_DECLARE_INTERFACE} vocabulary identical in ${DUAL_DECLARE_FILES.join(' and ')}`)
    for (const name of [...first.events.keys()].sort()) {
      console.log(`  '${name}': ${[...first.events.get(name).keys()].join(', ')}`)
    }
  }
  return ok
}

function readDualDeclareSources(authorityRoot) {
  return DUAL_DECLARE_FILES.map((rel) => ({ rel, source: readFileSync(join(authorityRoot, rel), 'utf8') }))
}

/**
 * Reverse coverage (REV-A-4): authority files living in a mirror-covered directory
 * without a snapshot counterpart. Scope = direct children of each directory that
 * contains at least one mirrored/mapped authority file (recursive nesting below a
 * covered directory is out of scope and would only add fixture noise), restricted
 * to the comparable file class: package-local metadata (.json manifests, .md docs,
 * .i18n.yaml pairing records) is excluded symmetrically with the forward
 * EXCLUDED-CONFIG category. AUTHORITY-ONLY entries are informational — extending
 * PLUGIN_TRACK_MAP / the mirror is a maintainer decision, so they do not fail
 * --strict (harness-local files such as agent-loop/src/inbox.ts legitimately stay
 * unmirrored); everything else still does.
 */
export function authorityOnlyEntries(authorityRoot, coveredDirs, knownAuthorityPaths) {
  const out = []
  for (const dir of [...coveredDirs].sort()) {
    const full = join(authorityRoot, dir)
    if (!existsSync(full)) continue
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (/\.(json|md|i18n\.yaml)$/.test(entry.name)) continue
      const rel = `${dir}/${entry.name}`
      if (knownAuthorityPaths.has(rel)) continue
      out.push(rel)
    }
  }
  return out.sort()
}

function main() {
  const { pluginsRoot, authorityRoot, strict } = parseArgs(process.argv.slice(2))
  const mirrorRoot = join(pluginsRoot, 'packages')

  console.log('generate-plugin-snapshots --check')
  console.log(`  authority : ${authorityRoot}`)
  console.log(`  snapshot  : ${pluginsRoot}`)
  console.log('')

  const pairs = []
  const coveredDirs = new Set()
  for (const rel of listFiles(mirrorRoot, mirrorRoot)) {
    if (rel.endsWith('.json')) {
      pairs.push({ snapshot: `packages/${rel}`, authority: `packages/${rel}`, category: 'EXCLUDED-CONFIG' })
      continue
    }
    pairs.push({ snapshot: `packages/${rel}`, authority: `packages/${rel}`, category: 'MIRROR' })
  }
  for (const [snapshot, authority] of PLUGIN_TRACK_MAP) {
    pairs.push({ snapshot, authority, category: 'PLUGIN-TRACK' })
  }
  pairs.sort((a, b) => a.snapshot.localeCompare(b.snapshot))

  const counts = {
    MATCH: 0,
    DRIFT: 0,
    'MISSING-AUTHORITY': 0,
    'MISSING-SNAPSHOT': 0,
    'EXCLUDED-CONFIG': 0,
    'AUTHORITY-ONLY': 0,
    'PLUGIN-TRACK-UNMAPPED': 0,
    'UNMAPPED-EXPECTED': 0,
  }
  const knownAuthorityPaths = new Set(pairs.map((pair) => pair.authority))
  for (const pair of pairs) {
    coveredDirs.add(dirname(pair.authority).split(sep).join('/'))
    const snapshotPath = join(pluginsRoot, pair.snapshot)
    const authorityPath = join(authorityRoot, pair.authority)
    if (pair.category === 'EXCLUDED-CONFIG') {
      counts[pair.category]++
      console.log(`EXCLUDED-CONFIG ${pair.snapshot} (fork-scoped patch context; not compared)`)
      continue
    }
    if (!existsSync(snapshotPath)) {
      counts['MISSING-SNAPSHOT']++
      console.log(`MISSING-SNAPSHOT ${pair.snapshot} (map entry stale; snapshot file absent)`)
      continue
    }
    if (!existsSync(authorityPath)) {
      counts['MISSING-AUTHORITY']++
      console.log(`MISSING-AUTHORITY ${pair.snapshot} has no counterpart at ${pair.authority} (snapshot content not yet absorbed by this tree)`)
      continue
    }
    const snapshotHash = sha256(readFileSync(snapshotPath))
    const authorityHash = sha256(readFileSync(authorityPath))
    if (snapshotHash === authorityHash) {
      counts.MATCH++
      console.log(`MATCH           ${pair.authority} <- ${pair.snapshot} (${snapshotHash.slice(0, 12)})`)
    } else {
      counts.DRIFT++
      console.log(`DRIFT           ${pair.authority}`)
      console.log(`                authority sha256 ${authorityHash}`)
      console.log(`                snapshot sha256 ${snapshotHash}`)
    }
  }

  // Authority -> snapshot direction (REV-A-4): files this tree owns inside
  // mirror-covered directories that the snapshot does not carry.
  for (const rel of authorityOnlyEntries(authorityRoot, coveredDirs, knownAuthorityPaths)) {
    counts['AUTHORITY-ONLY']++
    console.log(`AUTHORITY-ONLY  ${rel} (authority file not present in the snapshot mirror)`)
  }

  // Snapshot plugin-track files outside PLUGIN_TRACK_MAP.
  for (const trackDir of ['plugin/src', 'plugin/tests']) {
    const full = join(pluginsRoot, trackDir)
    if (!existsSync(full)) continue
    const mapped = new Set(PLUGIN_TRACK_MAP.map(([snapshot]) => snapshot))
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const rel = `${trackDir}/${entry.name}`
      if (mapped.has(rel)) continue
      if (KNOWN_UNMAPPED_SNAPSHOT_FILES.has(rel)) {
        counts['UNMAPPED-EXPECTED']++
        console.log(`UNMAPPED-EXPECTED ${rel} (intentionally outside PLUGIN_TRACK_MAP; see its comment)`)
      } else {
        counts['PLUGIN-TRACK-UNMAPPED']++
        console.log(`PLUGIN-TRACK-UNMAPPED ${rel} (snapshot plugin-track file absent from PLUGIN_TRACK_MAP)`)
      }
    }
  }

  console.log('')
  console.log(`Summary: ${counts.MATCH} match, ${counts.DRIFT} drift, ${counts['MISSING-AUTHORITY']} missing-authority, ${counts['MISSING-SNAPSHOT']} missing-snapshot, ${counts['EXCLUDED-CONFIG']} excluded-config, ${counts['AUTHORITY-ONLY']} authority-only, ${counts['PLUGIN-TRACK-UNMAPPED']} plugin-track-unmapped (${counts['UNMAPPED-EXPECTED']} unmapped-expected)`)
  console.log('Drift is reported only this wave; writeback generation is separately gated work (D7).')

  const shapeOk = assertDualDeclareSameShape(readDualDeclareSources(authorityRoot))
  // --strict gates the parity of the mapped/listed mirror set; AUTHORITY-ONLY is
  // informational (see authorityOnlyEntries) and never fails the run.
  const gaps = counts.DRIFT + counts['MISSING-AUTHORITY'] + counts['MISSING-SNAPSHOT'] + counts['PLUGIN-TRACK-UNMAPPED']
  if (!shapeOk) process.exit(1)
  if (strict && gaps > 0) process.exit(1)
  process.exit(0)
}

/* Run only when invoked as the entry script, so the spec can import the pure
 * helpers (extractDeclaredEvents / assertDualDeclareSameShape) without triggering
 * a check run or process.exit. */
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
