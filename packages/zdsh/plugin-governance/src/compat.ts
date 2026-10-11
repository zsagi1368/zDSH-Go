/**
 * Compatibility guard for the plugin-governance sandbox (T3).
 *
 * Probes peer dependency symbols before the sandbox registers itself, so a
 * partially-loaded or upstream-drifted host degrades gracefully instead of
 * throwing during registration. Low-conflict design per COMPAT-DESIGN §4.3:
 * only the presence of core symbols is checked, never their internals.
 *
 * @module @deepseek-ai/dsh-plugin-governance
 */

import { consoleCompatLogger, guardFeature } from '@deepseek-ai/dsh-compat'

/**
 * Run the governance compatibility guard.
 *
 * Verifies that the sandbox's peer symbols are importable and callable; when
 * any probe fails the verdict is `false` and the sandbox must skip
 * registration. Never throws — every probe failure (including a throwing
 * import) is turned into a disabled verdict by the underlying guard.
 *
 * @param logger - Optional logger (see {@link import('@deepseek-ai/dsh-compat').CompatLogger});
 *   defaults to a `console`-backed logger.
 * @returns A promise resolving to `true` when the feature may register.
 */
export async function guardGovernance(
  logger = consoleCompatLogger(),
): Promise<boolean> {
  const verdict = await guardFeature('dsh-governance-sandbox', {
    deps: [
      {
        name: 'cordis:Service',
        run: async () => {
          try {
            const { Service } = await import('@deepseek-ai/cordis')
            return typeof Service === 'function' ? null : 'Service not a function'
          } catch {
            return 'cannot import cordis Service'
          }
        },
      },
      {
        name: 'governance:LoadGuard',
        run: async () => {
          try {
            const { LoadGuard } = await import('@deepseek-ai/dsh-plugin-governance')
            return typeof LoadGuard === 'function' ? null : 'LoadGuard not a function'
          } catch {
            return 'cannot import LoadGuard'
          }
        },
      },
    ],
    logger,
  })
  return verdict.enabled
}
