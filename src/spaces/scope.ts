// Pure space-scoping + view-selection helpers (no React, no stores) — shared
// by the Spaces store, SpacesTab, and the notes remote-open receiver.

import type { SpaceSummary } from '@/store/spaces'

// Pseudo-spaces — client-side constructs (the hub's listSpaces knows nothing
// of them). "Vault" = the WHOLE tree, no board/agents: everything that lives
// outside projects/ (scratch/, log/, notes/, people/…) stays reachable, which
// is what lets the Notes tab retire. "Unassigned" = sessions with no
// project/areas binding (chat forks, one-off creates) — also a prompt to
// stamp them.
export const VAULT_SLUG = '~vault'
export const UNASSIGNED_SLUG = '~unassigned'
/** The vault-wide writing companion (^tame-hare): one shared session bound to
 *  every area, hoisted to its own row above the Areas section instead of
 *  replicating (and badging) across all of them. */
export const CURATOR_AGENT_KEY = 'curator'

export const VAULT_SPACE: SpaceSummary = {
  kind: 'project', slug: VAULT_SLUG, title: 'Vault', notePath: null, boardPath: null, status: null, fileCount: 0,
}
export const UNASSIGNED_SPACE: SpaceSummary = {
  kind: 'project', slug: UNASSIGNED_SLUG, title: 'Unassigned', notePath: null, boardPath: null, status: null, fileCount: 0,
}

export function spaceScopePrefixes(space: SpaceSummary): string[] {
  // Projects own projects/<slug>/** plus the flat projects/<slug>.md — AND
  // their writing, which lives OUTSIDE the folder: drafts are named
  // the project's log/drafts/ dir (in-folder, covered by the project prefix),
  // legacy scratch/blog-drafts/<slug>-… files, and published
  // posts sit in log/<ts>.md (matched per-path via useSpaceScope below).
  // The Vault pseudo-space scopes to nothing = everything.
  if (space.slug === VAULT_SLUG) return ['']
  if (space.slug === UNASSIGNED_SLUG) return []
  if (space.kind === 'project') {
    return [`projects/${space.slug}/`, `projects/${space.slug}.md`, `scratch/blog-drafts/${space.slug}-`]  // legacy prefix kept
  }
  // Areas: writing IS the content (AreaDevlog fills the rail), so the writing
  // dirs are the scope — without this, a draft opened from the rail rendered
  // the "No file open" placeholder and the old code bounced to the Notes pane.
  // Project-homed posts tagged with the area are appended per-path by
  // ScopedNotesEditor (they live under projects/<slug>/log/).
  return ['log/', 'scratch/blog-drafts/']  // log/ covers log/drafts/ too; scratch = legacy
}

/** Same predicate the Docs editor uses: prefix match, plus `projects/x/`
 *  also claiming the flat `projects/x.md`. */
export function pathInScope(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => path.startsWith(p) || path === p.replace(/\/$/, '.md'))
}

/** Which centre view to land on when jumping to a space (^dry-fawn):
 *  board-only content → board; docs-only → docs; both → whatever the user
 *  was on last time they were here (remembered per slug), defaulting board. */
export function pickSpaceView(opts: {
  hasBoard: boolean
  hasOpenDoc: boolean
  remembered: 'board' | 'docs' | null
}): 'board' | 'docs' {
  if (!opts.hasBoard) return 'docs'
  if (!opts.hasOpenDoc) return 'board'
  return opts.remembered ?? 'board'
}
