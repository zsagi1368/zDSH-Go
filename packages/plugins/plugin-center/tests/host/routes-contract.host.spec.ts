/**
 * Route-contract regression for the P1b fix: `apply` must leave every exact
 * route REGISTERED after activation.
 *
 * The vendored cordis `ctx.effect` contract runs the body immediately and
 * calls the RETURNED teardown on unload. The regression ran the disposers
 * inside the body itself, so all twelve `/api2/zdsh-plugin-center/*` exact
 * routes were registered and unregistered in the same synchronous pass —
 * the fiber stayed ACTIVE, nothing logged, and every route 404'd behind the
 * webserver fallback while workbench/filehub (plugin-level inject) worked.
 *
 * The fake harness mirrors that contract faithfully: the body executes now,
 * its returned disposer is deferred until unload. Against the buggy shape the
 * route table is empty the moment `apply` returns, so these assertions fail.
 */
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../../src/host/api.js'
import { apply } from '../../src/host/plugin.js'

interface Harness {
  routes: string[]
  unload(): void
}

/** Contract-faithful host: body runs immediately; returned teardown deferred. */
function activate(config: Record<string, unknown> = {}): Harness {
  const routes: string[] = []
  let teardowns: (() => void)[] = []
  const fakeCtx = {
    inject(deps: readonly string[], ready: (webCtx: unknown) => void): void {
      expect(deps).toEqual(['webServer'])
      ready({
        webServer: {
          register(route: { kind: string; path: string }): () => void {
            routes.push(`${route.kind}:${route.path}`)
            return () => {
              const index = routes.indexOf(`${route.kind}:${route.path}`)
              if (index >= 0) routes.splice(index, 1)
            }
          },
        },
        // Mirrors cordis Fiber.effect: execute() runs NOW, disposer collected.
        effect(execute: () => unknown): void {
          if (typeof execute === 'function') {
            const disposer = execute()
            if (typeof disposer === 'function') teardowns.push(disposer as () => void)
          }
        },
        logger: { info() {} },
      })
    },
  }
  apply(fakeCtx as never, config)
  return {
    routes,
    unload() {
      for (const disposer of teardowns.reverse()) disposer()
      teardowns = []
    },
  }
}

describe('plugin-center route registration contract', () => {
  it('registers every ROUTES entry as an exact route that survives apply', () => {
    const harness = activate()
    const expected = Object.values(ROUTES).map(path => `exact:${path}`)
    expect(harness.routes).toEqual(expected)
    // The regression signature: routes present AFTER the synchronous apply,
    // not just during it.
    expect(harness.routes.length).toBeGreaterThan(0)
    for (const path of Object.values(ROUTES)) {
      expect(path.startsWith('/') && !path.endsWith('/'), path).toBe(true)
    }
  })

  it('routes survive a microtask drain (async activation timing)', async () => {
    const harness = activate()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(harness.routes).toEqual(Object.values(ROUTES).map(path => `exact:${path}`))
  })

  it('unloads every route through the returned teardown on dispose', () => {
    const harness = activate()
    expect(harness.routes.length).toBe(Object.keys(ROUTES).length)
    harness.unload()
    expect(harness.routes).toEqual([])
  })
})
