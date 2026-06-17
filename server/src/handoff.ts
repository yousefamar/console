// ============================================================================
// `@handoff(<agentKey>)` detection — pure helper, unit-tested in __tests__/.
//
// Convention: when Al (or any agent) emits `@handoff(some-key)` in its assistant
// output, it's asking Console to put Yousef in direct contact with that agent.
// The SPA renders an opt-in "Talk to X →" affordance and a "↩ Back to Al" return.
// Mirrors attention.ts (`@amar`). Scanned on FINALIZED assistant text only.
// ============================================================================

/** `@handoff(<agentKey>)` — agentKey is a lowercase slug (letters/digits/hyphen).
 *  `\B` before `@` keeps it from matching inside an email-ish token. */
export const HANDOFF_RE = /\B@handoff\(\s*([a-z0-9][a-z0-9-]*)\s*\)/i

/** The target agentKey of the first `@handoff(...)` in `text`, or null. */
export function parseHandoff(text: string | undefined | null): string | null {
  if (!text) return null
  const m = text.match(HANDOFF_RE)
  return m ? m[1]!.toLowerCase() : null
}
