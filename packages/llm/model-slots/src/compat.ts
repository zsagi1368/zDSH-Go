/**
 * Compatibility guard for the model-slots feature (S-45).
 *
 * Probes the core dependency symbols before the feature registers itself, so
 * a partially-loaded or upstream-drifted host degrades gracefully instead of
 * throwing during registration. Low-conflict design per COMPAT-DESIGN §4.6:
 * only the presence of core symbols is checked, never their internals.
 *
 * L2 rotation (2026-10-12, clears DEBT-MODEL-SLOTS): the official 0.1.7
 * settings rewrite retired the `SettingsProvider` registration surface this
 * feature used to probe. The user-layer override now rides on the
 * entry-derived face — this plugin's own volatile Config plus `SettingsForms`
 * describe/update/mutate — so the second probe reports THAT surface instead.
 * A failed verdict is a capability report, not a skipped registration: the
 * registry serves composition configuration on any host, and the roster
 * reason plus warning attribute exactly which settings write face is missing
 * instead of silently retaining a degradation.
 *
 * @module @deepseek-ai/dsh-model-slots
 */

import { consoleCompatLogger, guardFeature } from '@deepseek-ai/dsh-compat'

/**
 * Run the model-slots compatibility guard.
 *
 * Verifies that the feature's peer symbols are importable and callable; when
 * any probe fails the verdict is `false` and the roster records an
 * attributable reason (the user layer is not settings-writable on that host).
 * Never throws — every probe failure (including a throwing import) is turned
 * into a disabled verdict by the underlying guard.
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
        name: 'settings:forms',
        run: async () => {
          try {
            // zDSH (L2): probe through a string index — the 0.1.7 rewrite
            // removed the old type/Symbol exports, and a static destructure
            // would fail the compile surface instead of failing soft. The
            // default export is `SettingsForms`; its describe/update/mutate
            // prototype members are the user-layer write face the slot editor
            // (settings/mutate) and the legacy settings import go through.
            const mod = await import('@deepseek-ai/dsh-settings') as Record<string, unknown>
            const forms: unknown = mod['default']
            const prototype = typeof forms === 'function'
              ? (forms as { prototype?: { describe?: unknown; update?: unknown; mutate?: unknown } }).prototype
              : undefined
            return prototype !== undefined
              && typeof prototype.describe === 'function'
              && typeof prototype.update === 'function'
              && typeof prototype.mutate === 'function'
              ? null
              : 'forms describe/update/mutate not functions (the official 0.1.7 settings rewrite replaced the SettingsProvider registration surface with entry-derived SettingsForms; without that face the user-layer slot overrides are not settings-writable on this host, while the registry still serves composition configuration)'
          } catch {
            return 'cannot import the settings forms surface'
          }
        },
      },
    ],
    logger,
  })
  return verdict.enabled
}
