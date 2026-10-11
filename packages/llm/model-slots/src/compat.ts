/**
 * Compatibility guard for the model-slots feature (S-45).
 *
 * Probes the core dependency symbols before the feature registers itself, so
 * a partially-loaded or upstream-drifted host degrades gracefully instead of
 * throwing during registration. Low-conflict design per COMPAT-DESIGN §4.6:
 * only the presence of core symbols is checked, never their internals.
 *
 * @module @deepseek-ai/dsh-model-slots
 */

import { consoleCompatLogger, guardFeature } from '@deepseek-ai/dsh-compat'

/**
 * Run the model-slots compatibility guard.
 *
 * Verifies that the feature's peer symbols are importable and callable; when
 * any probe fails the verdict is `false` and the feature must skip
 * registration. Never throws — every probe failure (including a throwing
 * import) is turned into a disabled verdict by the underlying guard.
 *
 * @param logger - Optional logger (see {@link import('@deepseek-ai/dsh-compat').CompatLogger});
 *   defaults to a `console`-backed logger.
 * @returns A promise resolving to `true` when the feature may register.
 */
export async function guardModelSlots(
  logger = consoleCompatLogger(),
): Promise<boolean> {
  const verdict = await guardFeature('dsh-model-slots', {
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
        name: 'settings:register',
        run: async () => {
          try {
            // zDSH (SYNC-P2): probe through a string index — the official 0.1.7
            // settings rewrite removed the SettingsProvider export, and a static
            // destructure would fail the compile surface instead of failing soft.
            const mod = await import('@deepseek-ai/dsh-settings') as Record<string, unknown>
            const provider: unknown = mod['SettingsProvider']
            // SYNC-P4 plan B (registered degradation): the reason wording is
            // the roster audit's attribution face — keep the raw probe signal
            // as the prefix (P2/P3 audit continuity) plus the removable-surface
            // attribution and the debt pointer; tests/compat.spec.ts locks it.
            return typeof provider === 'function'
              && typeof (provider as { prototype?: { register?: unknown } }).prototype?.register === 'function'
              ? null
              : 'register not a function (official 0.1.7 settings rewrite retired the SettingsProvider registration surface; user-layer slot overrides fail-soft disabled by design, service core unaffected — see DEBT-MODEL-SLOTS)'
          } catch {
            return 'cannot import SettingsProvider'
          }
        },
      },
    ],
    logger,
  })
  return verdict.enabled
}
