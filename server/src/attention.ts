// ============================================================================
// `@amar` attention detection — pure helpers, unit-tested in __tests__/.
//
// Convention (see ~/CLAUDE.md "Pinging Yousef with @amar"): any agent session
// that emits the literal `@amar` in its assistant output wants Yousef's eyes.
// The hub flags the session (sticky red marker) + fires one push.
// ============================================================================

/**
 * Matches a standalone `@amar` but NOT an email like `name@amar.io`.
 *
 * `\B@`: `\B` is a non-word-boundary. Between a word char and `@` there IS a
 * boundary (`\b`), so `\B` fails — `name@amar` won't match. Between whitespace
 * (or string start) and `@`, both sides are non-word → `\B` holds → matches.
 * `\bamar\b` then anchors the word so `@amaranth` doesn't match.
 */
export const AMAR_RE = /\B@amar\b/i

export function mentionsAmar(text: string | undefined | null): boolean {
  return !!text && AMAR_RE.test(text)
}

/**
 * ~140-char excerpt centred on the first `@amar` mention, whitespace collapsed,
 * for the push body + sidebar tooltip. Ellipsizes when truncated.
 */
export function extractAttentionSnippet(content: string): string {
  const clean = content.replace(/\s+/g, ' ').trim()
  const idx = clean.search(AMAR_RE)
  if (idx < 0) return clean.slice(0, 140)
  const start = Math.max(0, idx - 60)
  const end = Math.min(clean.length, idx + 80)
  return (start > 0 ? '…' : '') + clean.slice(start, end).trim() + (end < clean.length ? '…' : '')
}
