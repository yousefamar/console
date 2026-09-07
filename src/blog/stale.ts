// Stale published posts: local file saved AFTER the site's last build.
//
// A rebuild regenerates every page, so one number — the site's last build
// time (any page's Last-Modified) — decides staleness for all posts at once:
// no per-post HEAD, no extra hub state. The candidate set comes from the vault
// file list the notes store already holds; frontmatter is fetched only for the
// (few) stale hits.

import { isPublishedPath } from '@/utils/frontmatter'

export interface StaleCandidate {
  path: string
  mtime: number
}

/** Published posts whose file mtime is newer than the site's last build.
 *  `siteBuiltAt === null` (site unreachable / not probed yet) → none: we don't
 *  know, and a wrong "stale" is noisier than a missed one. */
export function stalePostCandidates(
  files: ReadonlyArray<{ path: string; mtime: number }>,
  siteBuiltAt: number | null,
): StaleCandidate[] {
  if (siteBuiltAt === null) return []
  const out: StaleCandidate[] = []
  for (const f of files) {
    if (!isPublishedPath(f.path)) continue
    if (f.mtime > siteBuiltAt) out.push({ path: f.path, mtime: f.mtime })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Project slug implied by a project-homed post path, else null. */
export function projectForPostPath(path: string): string | null {
  return path.match(/^projects\/([^/]+)\/log\/[^/]+\.md$/)?.[1] ?? null
}
