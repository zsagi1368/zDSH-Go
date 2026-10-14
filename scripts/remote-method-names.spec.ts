/**
 * A Remote method is reached in the browser as `ctx.remote.<namespace>.<method>`,
 * a member of the namespace service the client gateway mounts. That service
 * refuses a method named after one of its own members — the names in
 * `REMOTE_NAMESPACE_FIELDS`, plus everything its prototype carries (its own
 * members, everything inherited from cordis `Service`, and `Object.prototype`)
 * — and it refuses at **mount** time, i.e. after every unit suite has passed
 * and only once a browser loads the page. This spec reads the reserved names
 * off the gateway's own source and the real prototype chain, then checks every
 * `@Remote('<name>')` in the workspace against them, so the collision fails
 * here instead.
 *
 * Upstream carried this sweep inside `packages/api/remotes/tests` when it
 * renamed `plugins/install` to `add` and later dropped it; zDSH reinstates it
 * at the workspace level because `packages/zdsh/**` is exactly where a name can
 * pass every unit suite and still fail the web boot. The 2026-10-14 defect:
 * `pluginGovernance/install` collided with the service's private `install`
 * helper, the whole `dsh-api-remotes` apply failed, 26 Remote namespaces rolled
 * back, and 60 client entries stayed inactive (issue: zDSH-Go fresh install
 * shows "Failed to load plugins").
 */

import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Service } from '@deepseek-ai/cordis'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The names the client namespace service keeps for itself. */
function reservedMethodNames(): Set<string> {
  const source = readFileSync(join(ROOT, 'packages/api/gateway/src/client/index.ts'), 'utf8')
  const fields = source.match(/const REMOTE_NAMESPACE_FIELDS = new Set\(\[([^\]]*)\]\)/)?.[1]
  const classBody = source.match(/class RemoteNamespaceService extends Service \{([\s\S]*?)\n\}/)?.[1]
  if (fields === undefined || classBody === undefined) {
    throw new Error('the client gateway no longer spells its namespace service the way this spec reads it')
  }
  const reserved = new Set<string>()
  // The mount guard tests `method in RemoteNamespaceService.prototype`, so the
  // inherited chain counts: cordis Service first, then Object.prototype.
  for (const name of Object.getOwnPropertyNames(Service.prototype)) reserved.add(name)
  for (const name of Object.getOwnPropertyNames(Object.prototype)) reserved.add(name)
  for (const match of fields.matchAll(/'([^']+)'/g)) reserved.add(match[1] as string)
  for (const match of classBody.matchAll(/^ {2}(?:private |static |readonly |get |async )*([A-Za-z_$][\w$]*)\s*[(:=]/gm)) {
    reserved.add(match[1] as string)
  }
  return reserved
}

describe('Remote method names', () => {
  it('never name a member of the client namespace service', () => {
    const reserved = reservedMethodNames()
    // Extraction self-check: if the gateway is refactored, fail loudly here
    // rather than silently widening the sweep's blind spot.
    expect(reserved.has('install')).toBe(true)
    expect(reserved.has('remove')).toBe(true)
    const offenders: string[] = []
    for (const pattern of ['packages/**/src/**/*.ts', 'apps/**/src/**/*.ts']) {
      for (const file of globSync(pattern, { cwd: ROOT })) {
        const source = readFileSync(join(ROOT, file), 'utf8')
        for (const match of source.matchAll(/@Remote\(\s*'([^']+)'/g)) {
          const method = match[1] as string
          if (reserved.has(method)) offenders.push(`${file}: @Remote('${method}')`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
