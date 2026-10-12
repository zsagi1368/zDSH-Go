/**
 * Quote-aware command tokenizer shared by the plugin sandboxes.
 *
 * The sandboxes never reach a shell — `execFile` hands the argv straight to the
 * binary — so the property this splitter owns is not metacharacter handling: it
 * is that one quoted region stays exactly one argv entry. A naive
 * `split(/\s+/)` splices quoted data into extra tokens, which lets a caller slip
 * an option-shaped argument (`"payload --upload-pack=..."` becomes the real
 * option `--upload-pack=...`) into the argv of an allow-listed binary, and it
 * leaks the quote characters themselves into the arguments. Both sandboxes and
 * `extractCommandBase` tokenize through here, so the token the allow list checks
 * is the token that is executed.
 *
 * Quotes are removed; single and double quotes both group whitespace and an
 * empty quoted token survives (`cmd ""` passes one empty argument, as in a
 * shell). A backslash is an ordinary character, never an escape — Windows paths
 * have to survive verbatim. An unterminated quote extends to the end of the
 * string.
 *
 * @param command - raw command string from an untrusted caller.
 * @returns the argv tokens, empty when nothing survives.
 */
export function splitCommandArgs(command: string): string[] {
  const tokens: string[] = []
  let token = ''
  let opened = false
  let quote: "'" | '"' | undefined

  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      opened = true
      continue
    }
    if (/\s/u.test(character)) {
      if (token.length > 0 || opened) tokens.push(token)
      token = ''
      opened = false
      continue
    }
    token += character
  }

  if (token.length > 0 || opened) tokens.push(token)
  return tokens
}
