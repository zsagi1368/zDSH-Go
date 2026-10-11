/**
 * Compatibility guard for the project-root plugin (S-43).
 *
 * Probes the core dependency symbols before the plugin registers itself, so
 * a partially-loaded or upstream-drifted host degrades gracefully instead of
 * throwing during registration. Low-conflict design per COMPAT-DESIGN §4.5:
 * only the presence of core symbols is checked, never their internals.
 *
 * @module @deepseek-ai/dsh-plugin-project-root
 */

import { consoleCompatLogger, guardFeature } from '@deepseek-ai/dsh-compat'

/**
 * Run the project-root compatibility guard.
 *
 * Verifies that the plugin's peer symbols are importable and callable; when
 * any probe fails the verdict is `false` and the plugin must skip
 * registration. Never throws — every probe failure (including a throwing
 * import) is turned into a disabled verdict by the underlying guard.
 *
 * @param logger - Optional logger (see {@link import('@deepseek-ai/dsh-compat').CompatLogger});
 *   defaults to a `console`-backed logger.
 * @returns A promise resolving to `true` when the feature may register.
 */
export async function guardProjectRoot(
  logger = consoleCompatLogger(),
): Promise<boolean> {
  const verdict = await guardFeature('dsh-project-root', {
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
      {
        name: 'tools:defineTool',
        run: async () => {
          try {
            const { defineTool } = await import('@deepseek-ai/dsh-tools')
            return typeof defineTool === 'function' ? null : 'defineTool not a function'
          } catch {
            return 'cannot import defineTool'
          }
        },
      },
    ],
    logger,
  })
  return verdict.enabled
}
