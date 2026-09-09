/**
 * Compatibility guard for the ACP session resume/load feature (S-08).
 *
 * Probes the installed `@agentclientprotocol/sdk` to determine the resume
 * strategy: use the official SDK's native `AcpSession` (when the `agent`
 * symbol is present), fall back to the zDSH `AgentSideConnection`, or
 * disable the feature entirely when neither is found.  Also checks that
 * the `@deepseek-ai/dsh-user-approval` `APPROVAL_POLICIES` constant is
 * importable, so the permission overlay can be offered.
 *
 * The decision surface follows COMPAT-DESIGN SS4.4 and API-DELTA SS6:
 * the official new SDK replaces zDSH resume with its own
 * session-management layer, and only the permission-overlay option
 * is retained as a zDSH overlay.
 *
 * @module @deepseek-ai/dsh-acp
 */

import { consoleCompatLogger, guardFeature, memberOf } from '@deepseek-ai/dsh-compat'
import type { CompatLogger } from '@deepseek-ai/dsh-compat'

/**
 * Run the ACP compatibility guard.
 *
 * @param logger - Optional logger; defaults to a `console`-backed logger.
 * @returns A verdict with the overall enabled flag, the chosen resume
 *   strategy, and whether the permission overlay is available.
 */
export async function guardACP(
  logger: CompatLogger = consoleCompatLogger(),
): Promise<{
  enabled: boolean
  resumeStrategy: 'use-official' | 'use-zdsh' | 'disabled'
  permissionOverlay: boolean
}> {
  const officialSessionCheck = {
    name: 'acp:official-session',
    run: async () => {
      // Literal dynamic import: resolves the SDK from this package's own
      // dependency, in vitest and in production alike (a variable specifier
      // would resolve relative to the compat helper's package instead).
      let sdk: Record<string, unknown>
      try {
        sdk = await import('@agentclientprotocol/sdk')
      } catch {
        return 'cannot import @agentclientprotocol/sdk'
      }
      const official = memberOf(sdk, 'agent')
      if (typeof official === 'function') return null // official SDK present -> use official resume
      const zdsh = memberOf(sdk, 'AgentSideConnection')
      if (zdsh === undefined) return 'neither official nor zDSH ACP SDK found'
      return null // zDSH SDK -> use zDSH resume
    },
  }

  const verdict = await guardFeature('dsh-acp', { deps: [officialSessionCheck], logger })
  if (!verdict.enabled) {
    return { enabled: false, resumeStrategy: 'disabled', permissionOverlay: false }
  }

  // Re-check which SDK is present to determine the strategy.
  let official: unknown
  try {
    const sdk = (await import('@agentclientprotocol/sdk')) as Record<string, unknown>
    official = memberOf(sdk, 'agent')
  } catch {
    official = undefined
  }

  // The permission overlay is independent of the resume path: its absence
  // only drops the overlay, never the official/zDSH base resume (API-DELTA §6).
  let approvalOk = false
  try {
    const { APPROVAL_POLICIES } = await import('@deepseek-ai/dsh-user-approval')
    approvalOk = typeof APPROVAL_POLICIES === 'object'
  } catch {
    approvalOk = false
  }

  return {
    enabled: true,
    resumeStrategy: typeof official === 'function' ? 'use-official' : 'use-zdsh',
    permissionOverlay: approvalOk,
  }
}
