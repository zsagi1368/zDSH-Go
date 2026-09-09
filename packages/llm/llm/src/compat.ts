/**
 * Version-adaptive guard for the D-005 truncatedToolCalls enhancement.
 *
 * The official (upstream) `BlockAssembler` has no `truncatedToolCalls` method
 * and its `step()` ends cleanly on max-tokens, so the zDSH enhancement
 * (fail-loud on unclosed/bad tool-call parameters) cannot be expressed on the
 * official assembler: probing failure disables the zDSH checks entirely and
 * the official behaviour already covers the primary semantics. We do not
 * fall back to the old version (signature incompatible).
 *
 * @module @deepseek-ai/dsh-llm
 */

import { guardFeature, consoleCompatLogger } from '@deepseek-ai/dsh-compat'
import { BlockAssembler } from './assembler.ts'
import { TRUNCATED_TOOL_CALL_CODE } from './error.ts'

/**
 * Probe whether the loaded `@deepseek-ai/dsh-llm` exposes the
 * `truncatedToolCalls` enhancement (D-005). Returns `true` only when both
 * the `BlockAssembler.truncatedToolCalls` method and the
 * `TRUNCATED_TOOL_CALL_CODE` constant are present; otherwise logs a warning
 * and returns `false` so callers skip the zDSH checks. Never throws.
 *
 * The probes are static local imports, not a dynamic self-import: the module
 * ships inside this package, so a dynamic `import('@deepseek-ai/dsh-llm')`
 * would make tsdown split the assembler into a side chunk the webworker
 * packer's `files` whitelist cannot ship. On an official build this module
 * does not exist at all, so the guard simply never runs there.
 *
 * @param logger - Optional logger for the disable diagnostic; defaults to `console`.
 * @returns Whether the D-005 enhancement is available and may be used.
 */
export async function guardTruncatedToolCalls(logger = consoleCompatLogger()): Promise<boolean> {
  const verdict = await guardFeature('dsh-truncated-tool-calls', {
    deps: [
      {
        name: 'llm:BlockAssembler',
        run: () => {
          const hasMethod = typeof BlockAssembler === 'function'
            && typeof BlockAssembler.prototype.truncatedToolCalls === 'function'
          return hasMethod ? null : 'BlockAssembler.truncatedToolCalls not found'
        },
      },
      {
        name: 'llm:TRUNCATED_TOOL_CALL_CODE',
        run: () => {
          return typeof TRUNCATED_TOOL_CALL_CODE === 'string'
            ? null
            : 'TRUNCATED_TOOL_CALL_CODE not a string'
        },
      },
    ],
    logger,
  })
  return verdict.enabled
}
