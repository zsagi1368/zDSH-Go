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
// This wave ships the `--check` mode only: per-file SHA-256 comparison of this tree
// (authority) against the plugin-repository snapshot, plus the cache/ledger dual
// `declare module` same-shape assertion (agent.ts and token-meter/cache-metrics.ts
// must declare the same event vocabulary — interface merging makes a shape split a
// silent type hole). Snapshot drift is REPORTED, not written back; writeback
// generation from this tree is a later, separately-gated piece of work.
//
// Usage:
//   node scripts/generate-plugin-snapshots.mjs --check [--strict] [--plugins-root <path>]
//
// Exit codes:
//   0  check ran; drift/missing counterparts may be reported (see output) unless --strict
//   1  hard failure: same-shape assertion violated, unparseable declare block,
//      plugin repository not found, or --strict and any drift/missing entry
//
// Snapshot-side layout (zDSH-plugins/ContextManagement):
//   packages/**  path-for-path mirror (same relative path in this repository)
//   plugin/src   plugin-track modules, mapped to their authority files via PLUGIN_TRACK_MAP
//   plugin/tests plugin-track specs, mapped likewise
// Only TypeScript sources are compared; the mirror's package.json / tsconfig.json are
// fork-scoped patch context and are listed as EXCLUDED-CONFIG, not compared.
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
  // plugin/src/index.ts is intentionally absent: it is plugin-bundle glue with no
  // authority counterpart in this tree, so the plugin repository stays its owner.
]

// agent.ts authors the `cache/ledger` event; cache-metrics.ts re-declares it because
// project-references builds compile token-meter without agent-loop in its program.
const DUAL_DECLARE_FILES = [
  'packages/core/agent-loop/src/agent.ts',
  'packages/llm/token-meter/src/cache-metrics.ts',
]
const DUAL_DECLARE_MODULE = '@deepseek-ai/dsh-session/types'
const DUAL_DECLARE_INTERFACE = 'SessionEventMap'

const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const check = argv.includes('--check')
const pluginsRootIndex = argv.indexOf('--plugins-root')
const pluginsRootOverride = pluginsRootIndex >= 0 ? argv[pluginsRootIndex + 1] : undefined

function usage(fail) {
  const lines = [
    'Usage: node scripts/generate-plugin-snapshots.mjs --check [--strict] [--plugins-root <path>]',
    '  --check              compare this tree (authority) against the plugin-repository snapshot',
    '  --strict             treat reported drift/missing counterparts as a failure (exit 1)',
    '  --plugins-root <p>   plugin repository root (default: <repo>/../../zDSH-plugins/ContextManagement)',
  ]
  for (const line of lines) console.log(line)
  if (fail) process.exit(1)
}

if (!check || argv.includes('-h') || argv.includes('--help')) usage(!check)

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

function parseArgs(args) {
  const pluginRepo = pluginsRootOverride
    ? resolve(process.cwd(), pluginsRootOverride)
    : resolve(repoRoot, '..', '..', 'zDSH-plugins', 'ContextManagement')
  if (!existsSync(pluginRepo)) {
    console.error(`generate-plugin-snapshots: plugin repository not found at ${pluginRepo}`)
    console.error('Pass --plugins-root <path> to point at zDSH-plugins/ContextManagement.')
    process.exit(1)
  }
  return { pluginRepo }
}

/** Extract every `declare module '<name>' { interface <iface> { ... } }` event vocabulary. */
function extractDeclaredEvents(source, moduleName, interfaceName, origin) {
  const events = new Map()
  const moduleRe = new RegExp(`declare\\s+module\\s+'${moduleName.replace(/[-/]/g, '\\$&')}'\\s*\\{`)
  const moduleMatch = moduleRe.exec(source)
  if (moduleMatch === null) return events
  const moduleBody = balancedBlock(source, source.indexOf('{', moduleMatch.index), origin, 'declare module')
  const ifaceIndex = moduleBody.indexOf(`interface ${interfaceName}`)
  if (ifaceIndex === -1) return events
  const ifaceBody = balancedBlock(moduleBody, moduleBody.indexOf('{', ifaceIndex), origin, `interface ${interfaceName}`)
  const entryRe = /'([a-z0-9/-]+)'\s*:\s*\{/g
  let entry
  while ((entry = entryRe.exec(ifaceBody)) !== null) {
    const payload = balancedBlock(ifaceBody, ifaceBody.indexOf('{', entry.index), origin, `event ${entry[1]}`)
    events.set(entry[1], parsePayloadKeys(payload, origin, entry[1]))
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
 * the following member and under-report the vocabulary. */
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

function assertDualDeclareSameShape() {
  const declarations = DUAL_DECLARE_FILES.map((rel) => {
    const source = readFileSync(join(repoRoot, rel), 'utf8')
    return { rel, events: extractDeclaredEvents(source, DUAL_DECLARE_MODULE, DUAL_DECLARE_INTERFACE, rel) }
  })
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

function main() {
  const { pluginRepo } = parseArgs(argv)
  const mirrorRoot = join(pluginRepo, 'packages')

  console.log('generate-plugin-snapshots --check')
  console.log(`  authority : ${repoRoot}`)
  console.log(`  snapshot  : ${pluginRepo}`)
  console.log('')

  const pairs = []
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

  const counts = { MATCH: 0, DRIFT: 0, 'MISSING-AUTHORITY': 0, 'EXCLUDED-CONFIG': 0, 'MISSING-SNAPSHOT': 0 }
  for (const pair of pairs) {
    const snapshotPath = join(pluginRepo, pair.snapshot)
    const authorityPath = join(repoRoot, pair.authority)
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

  console.log('')
  console.log(`Summary: ${counts.MATCH} match, ${counts.DRIFT} drift, ${counts['MISSING-AUTHORITY']} missing-authority, ${counts['MISSING-SNAPSHOT']} missing-snapshot, ${counts['EXCLUDED-CONFIG']} excluded-config`)
  console.log('Drift is reported only this wave; writeback generation is separately gated work (D7).')

  const shapeOk = assertDualDeclareSameShape()
  const driftFree = counts.DRIFT === 0 && counts['MISSING-AUTHORITY'] === 0 && counts['MISSING-SNAPSHOT'] === 0
  if (!shapeOk) process.exit(1)
  if (strict && !driftFree) process.exit(1)
  process.exit(0)
}

main()
