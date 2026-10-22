/**
 * The runtime-context prefix a user message may carry.
 *
 * The harness delivers its per-turn operational facts — working directory,
 * file policy, approval posture — as a delta folded into the PREFIX of the
 * next real user message. The fold is deliberate: the model must see the
 * snapshot ahead of the person's words, and the provider's prompt cache only
 * stays warm while the prefix grows monotonically.
 *
 * But the durable message is the person's own, and the transcript renders it
 * verbatim — so the reader saw the harness's bookkeeping where their words
 * should have been. The prefix is stripped for DISPLAY, and the message on
 * the wire keeps it.
 *
 * The strip is anchored on the KNOWN snapshot header, not on a "last blank
 * line" rule: the delta always begins with that header, and a person's own
 * text may contain blank lines of its own. A rule that guessed at the
 * boundary would cut the wrong line out of a message that merely looks like
 * a folded one.
 */

/**
 * The header every runtime-context delta opens with. The Host writes it in
 * `joinContextSections` (packages/core/system-prompt).
 */
const SNAPSHOT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'

/** The marker the Host writes when every context section is gone. */
const CLEARED_HEADER = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/**
 * Whether a text carries a runtime-context prefix at its head.
 * @param text - the message text.
 * @returns whether the text opens with a known snapshot header.
 */
function startsWithHeader(text: string): boolean {
  return text.startsWith(SNAPSHOT_HEADER) || text.startsWith(CLEARED_HEADER)
}

/**
 * Strip the runtime-context prefix from a user message's text.
 *
 * The prefix is a delta followed by a blank line, then the person's own
 * words. Both known headers are recognised, and only a header at the very
 * head counts — a message whose own text merely mentions the header keeps
 * every word.
 *
 * @param text - the message text as the log carries it.
 * @returns the text without the runtime-context prefix; the same text when
 *   it carries none.
 */
export function stripRuntimeContextPrefix(text: string): string {
  if (!startsWithHeader(text)) return text
  // The delta is a list of section texts joined by blank lines, so the FIRST
  // blank line is inside it. The boundary is the LAST blank line before the
  // person's words — the same boundary the Host uses to read the prefix back
  // out of a folded message (runtime-context.ts `restoreBaseline`).
  const separator = text.lastIndexOf('\n\n')
  if (separator < 0) return text
  return text.slice(separator + 2)
}

/**
 * Strip the runtime-context prefix from a message's blocks.
 *
 * Only the FIRST text block can carry the prefix — the fold prepends one
 * block — so the rest of the message is left exactly as it was.
 *
 * @param content - the message's blocks as the log carries them.
 * @returns the blocks without the runtime-context prefix.
 */
export function stripRuntimeContextBlocks<T extends { readonly type: string }>(
  content: readonly T[],
): readonly T[] {
  const first = content[0]
  if (first === undefined || first.type !== 'text') return content
  const text = (first as { readonly text?: unknown }).text
  if (typeof text !== 'string') return content
  const stripped = stripRuntimeContextPrefix(text)
  if (stripped === text) return content
  return [{ ...first, text: stripped }, ...content.slice(1)]
}
