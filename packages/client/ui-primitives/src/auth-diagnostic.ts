/**
 * A provider's authentication diagnostic, safe to show.
 *
 * A provider that answers 401 says WHY: "Incorrect API key provided",
 * "model not found", "this gateway needs the key in `Authorization`". Every
 * one of those is a different thing to do next, and every one of them used
 * to arrive in the browser as the same flat sentence — the raw diagnostic was
 * dropped at the projection, so the surface could not tell the reader which
 * cause they hit.
 *
 * The raw text is dropped for a reason: a provider's error body may echo the
 * credential it was given, masked or not. So the diagnostic is kept and the
 * key-shaped parts of it are removed, which leaves the part that says what
 * went wrong.
 *
 * This lives with the primitives because two surfaces project the same durable
 * failure — the Chat transcript and the Trajectory ledger — and the rule for
 * what may be shown has to be one rule, not two.
 */

/**
 * Key-shaped runs: a provider's usual key prefixes, and any long
 * uninterrupted token that could be a key. The prefixes are named because
 * they are what providers actually send back, and the long-token rule
 * catches the rest — a gateway that names a key it was given is echoing it
 * in a shape no prefix list would cover.
 */
const KEY_SHAPED = /(?:\b(?:sk|pk|rk|api|key|token|bearer)[-_][\w-]{8,}|\b[\w-]{24,}\b)/gi


/**
 * Remove key-shaped runs from a diagnostic.
 * @param message - the provider's own words about the refusal.
 * @returns the message with every key-shaped run replaced by a marker.
 */
export function sanitizeAuthDiagnostic(message: string): string {
  return message.replace(KEY_SHAPED, '[redacted]')
}

/**
 * The provider's authentication diagnostic, in the words the provider used.
 *
 * This is the whole point: the reader is told what the provider objected to,
 * so the next move is obvious. A provider that says nothing useful still
 * yields a generic sentence rather than a blank.
 * @param message - the raw failure message, which may echo a credential.
 * @returns the diagnostic with key-shaped runs removed.
 */
export function authDiagnostic(message: string): string {
  const sanitized = sanitizeAuthDiagnostic(message).trim()
  return sanitized.length === 0 ? 'The provider rejected the API key.' : sanitized
}
