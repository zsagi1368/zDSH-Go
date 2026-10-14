import { consoleCompatLogger, guardFeature } from '@deepseek-ai/dsh-compat'

/**
 * Compatibility preflight for the S-45 settings UI slot block (ui-settings-models).
 *
 * Verifies the plugin's own peer symbols import cleanly before the slot UI
 * registers itself, so a partially-loaded or upstream-drifted host degrades
 * gracefully instead of throwing during registration — the same posture as the
 * workbench guard (COMPAT-DESIGN §4.3: symbol presence only, never internals).
 *
 * History: this guard originally probed the *absence* of an official
 * `@deepseek-ai/dsh-client-store` (defineStore) to avoid dual-write conflicts
 * between the official store UI and this fork's slot UI. The 0.1.3 tree now
 * ships that package itself as the fork's shared snapshot-store engine, and
 * this plugin imports it directly (`createSnapshotStore`) — the old conflict
 * premise no longer exists, and probing it always resolved "official store
 * detected", permanently disabling the slot UI. The guard therefore now checks
 * the peers this plugin actually depends on at registration time.
 * Never throws — a throwing probe yields a disabled verdict.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models
 */

/**
 * Whether the failure is the browser's own specifier refusal.
 *
 * In a client bundle a native `import('@deepseek-ai/…')` is a URL fetch, so a
 * bare specifier can never resolve there — the browser answers
 * `Failed to resolve module specifier "…"` (the client module table, not the
 * native resolver, is what resolves packages in that environment). That is an
 * environment fact, never the host drift this guard exists for.
 *
 * @param error - whatever the dynamic import threw.
 * @returns `true` when the environment simply cannot run this probe.
 */
function isBrowserSpecifierRefusal(error: unknown): boolean {
  // Loaders and module runners routinely re-wrap an import failure, so the
  // refusal can sit anywhere on the cause chain rather than on the outer error.
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const message = current instanceof Error ? current.message : String(current)
    if (message.includes('Failed to resolve module specifier')) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/**
 * Run the slot-UI compatibility preflight.
 *
 * @param logger - Optional logger (see {@link import('@deepseek-ai/dsh-compat').CompatLogger});
 *   defaults to a `console`-backed logger.
 * @returns A promise resolving to `true` when the zDSH slot UI may register.
 */
export async function guardSlotUI(
  logger = consoleCompatLogger(),
): Promise<boolean> {
  const verdict = await guardFeature('dsh-slot-ui', {
    deps: [
      {
        name: 'cordis:Service',
        run: async () => {
          try {
            const { Service } = await import('@deepseek-ai/cordis')
            return typeof Service === 'function' ? null : 'Service not a function'
          } catch (error) {
            // Disabling on the browser's refusal is how the whole Models
            // surface disappeared from every Web boot (2026-10-14: guard
            // verdict false, `Failed to resolve module specifier
            // "@deepseek-ai/cordis"`); real drift still disables below.
            if (isBrowserSpecifierRefusal(error)) return null
            return 'cannot import cordis Service'
          }
        },
      },
      {
        name: 'store:createSnapshotStore',
        run: async () => {
          try {
            const { createSnapshotStore } = await import('@deepseek-ai/dsh-client-store')
            return typeof createSnapshotStore === 'function'
              ? null
              : 'createSnapshotStore not a function'
          } catch (error) {
            if (isBrowserSpecifierRefusal(error)) return null
            return 'cannot import the dsh-client-store engine'
          }
        },
      },
    ],
    logger,
  })
  return verdict.enabled
}
