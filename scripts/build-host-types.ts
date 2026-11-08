/** Emit deterministic lib/types artifacts for every member of the tsdown Host build face. */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * Mirror of the Host face `workspace` list in tsdown.config.ts
 * (`vendor/<pkg>`, `packages/<group>/<pkg>`, `apps/cli`, `apps/desktop-host`).
 * The Host
 * tsdown pass consumes `lib/types/{index,startup}.js` JavaScript emitted by
 * each member's TypeScript project, and only the Host aggregate check
 * (`tsc -b tsconfig.host.json`) runs with `noEmit: true`, so nothing in the
 * ordinary chain emits those artifacts on a fresh checkout. This script is the
 * deterministic producer: enumerate the same face members and run
 * `tsc -b <member>` per member, letting each member's project references
 * order its own dependency closure. Keep this list in sync with
 * tsdown.config.ts when the Host face changes.
 */
function hostFaceMembers(root: string): string[] {
  const members: string[] = []
  const directories = (directory: string): string[] => {
    try {
      return readdirSync(directory).filter(name => statSync(join(directory, name)).isDirectory())
    } catch {
      return []
    }
  }
  for (const vendor of directories(join(root, 'vendor'))) members.push(`vendor/${vendor}`)
  for (const group of directories(join(root, 'packages'))) {
    for (const member of directories(join(root, 'packages', group))) members.push(`packages/${group}/${member}`)
  }
  members.push('apps/cli', 'apps/desktop-host')
  return members.sort()
}

/**
 * Face members whose `tsc -b` cannot and must not produce `lib/types`. Every
 * entry needs a reason: unlisted failures are aggregated and fail the script,
 * so exceptions may only be skipped on purpose.
 */
const EMIT_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // Bundle package: tsconfig.json is check-only (`noEmit: true`, `include: []`,
  // no src); its bundle entry is produced by its own tsdown.config.ts.
  ['packages/zdsh/factory-bundle', 'check-only tsconfig; bundle emitted by its own tsdown.config.ts'],
])

/**
 * Resolve the Host emit entry of one member. Dual-face members split Host and
 * Client into sibling configs behind a `files: []` hub `tsconfig.json` (the
 * two faces merge cordis Context under the same keys, one program cannot see
 * both); their `tsconfig.host.json` variant is the Host slice that emits
 * `lib/types`, the same entry the Host aggregate references. Building the hub
 * would also compile the Client slice, which the repository only type-checks
 * after the Host tsdown pass has run Typert, so it must stay out of this
 * producer. Plain members emit from `tsconfig.json` directly.
 */
function hostEmitEntry(member: string): string {
  return join(member, 'tsconfig.host.json')
}

/**
 * Detect client-face members: their `tsconfig.json` extends
 * `tsconfig.base.client.json` and IS their Client slice, whose artifacts the
 * Client chain (`tsc -b tsconfig.client.json` after the Host tsdown pass)
 * emits. Compiling them here would demand Typert artifacts that do not exist
 * before that pass, so this producer must skip them.
 */
function isClientFaceMember(root: string, member: string): boolean {
  const loaded = ts.readConfigFile(join(root, member, 'tsconfig.json'), ts.sys.readFile)
  const extendsField = loaded.config?.extends
  return typeof extendsField === 'string' && extendsField.includes('tsconfig.base.client.json')
}

/** Compile one member's Host TypeScript entry with the repository compiler. */
function compileMember(root: string, compiler: string, entry: string): string | undefined {
  const result = spawnSync(process.execPath, ['--max-old-space-size=4096', compiler, '-b', entry], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error !== undefined) return `spawn failed: ${result.error.message}`
  if (result.status !== 0) return `tsc -b exited with ${String(result.status ?? result.signal)}`
  return undefined
}

function main(): void {
  const root = resolve(import.meta.dirname, '..')
  const compiler = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))
  const members = hostFaceMembers(root)
  const buildable: string[] = []
  const skipped: string[] = []
  for (const member of members) {
    const exception = EMIT_EXCEPTIONS.get(member)
    if (exception !== undefined) {
      skipped.push(`${member} (exception: ${exception})`)
      continue
    }
    if (!existsSync(join(root, member, 'tsconfig.json'))) {
      // Residual or placeholder directories carry no TypeScript project; on a
      // fresh checkout they do not exist at all because git tracks no content.
      skipped.push(`${member} (no tsconfig.json)`)
      continue
    }
    if (isClientFaceMember(root, member)) {
      skipped.push(`${member} (client-face member; emitted by the Client chain after the Host tsdown pass)`)
      continue
    }
    buildable.push(existsSync(join(root, hostEmitEntry(member))) ? hostEmitEntry(member) : member)
  }
  process.stdout.write(
    `build-host-types: ${members.length} face members, ${buildable.length} to compile, ${skipped.length} skipped\n`,
  )
  for (const line of skipped) process.stdout.write(`build-host-types: skipped ${line}\n`)

  const failures: Array<[member: string, reason: string]> = []
  let index = 0
  for (const member of buildable) {
    index += 1
    const failure = compileMember(root, compiler, member)
    if (failure === undefined) {
      process.stdout.write(`build-host-types: [${index}/${buildable.length}] ${member}\n`)
      continue
    }
    failures.push([member, failure])
    process.stdout.write(`build-host-types: [${index}/${buildable.length}] FAILED ${member}: ${failure}\n`)
  }
  if (failures.length > 0) {
    for (const [member, reason] of failures) {
      process.stderr.write(`build-host-types: FAILED ${member}: ${reason}\n`)
    }
    throw new Error(`build-host-types: ${failures.length} of ${buildable.length} members failed: ${failures.map(([member]) => member).join(', ')}`)
  }
  process.stdout.write(`build-host-types: all ${buildable.length} member lib/types builds succeeded\n`)
}

main()
