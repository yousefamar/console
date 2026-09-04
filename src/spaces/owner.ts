// Project owner — the session an unassigned card auto-assigns to when dragged
// into In Progress. Client mirror of the hub's resolution (index.ts
// `resolveOwner` → kanban/dispatch.ts `resolveDefaultOwner`), so the rail can
// mark BOTH kinds of owner: explicit (board frontmatter `default_owner:`,
// shipped as SpaceSummary.defaultOwner) and by convention (no frontmatter —
// single bound root session → it; several → the `-general` one; else first by
// key). Keep in sync with the server when the picking order changes.

export interface OwnerCandidate {
  agentKey?: string | null
  name?: string | null
  project?: string | null
  status?: string
  parentClaudeSessionId?: string | null
}

/** The convention pick over a project's live, keyed, non-fork sessions. */
export function conventionOwnerKey(slug: string, sessions: readonly OwnerCandidate[]): string | null {
  const bound = sessions.filter((s) => s.project === slug && s.status !== 'ended' && s.agentKey && !s.parentClaudeSessionId)
  if (bound.length === 0) return null
  if (bound.length === 1) return bound[0]!.agentKey!
  const general = bound.find((s) => s.agentKey!.endsWith('general') || /\bgeneral$/i.test(s.name ?? ''))
  if (general) return general.agentKey!
  return [...bound].sort((a, b) => a.agentKey!.localeCompare(b.agentKey!))[0]!.agentKey!
}

/** Frontmatter owner wins outright (even if that key has no live session —
 *  the hub honours it the same way); otherwise the convention pick. */
export function effectiveOwnerKey(slug: string, defaultOwner: string | null | undefined, sessions: readonly OwnerCandidate[]): string | null {
  return defaultOwner ?? conventionOwnerKey(slug, sessions)
}
