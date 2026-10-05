// Stale published posts: local file saved AFTER the site's last build.
//
// One number — the site's build clock — decides staleness for all posts at
// once: no per-post HEAD, no extra hub state. The candidate set comes from the
// vault file list the notes store already holds; frontmatter is fetched only
// for the (few) stale hits.
//
// The clock comes from the blog server's own `/rebuild/status`, NOT from a
// page's Last-Modified. Eleventy honours the vault's .gitignore, so a template
// can drop out of the build while Caddy keeps serving its last-written file:
// `root/*/` landed in .gitignore on 3 Oct 2026 and froze /memo/ (the page this
// used to probe) at 3 Oct 14:38, which marked everything published afterwards
// stale forever.

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

export interface SiteBuild {
  ok?: boolean
  startedAt?: string
  finishedAt?: string
  /** `[11ty]` problem lines from a failed build. */
  error?: string
}

export interface SiteStatus {
  rebuilding?: boolean
  /** null when the blog server has run no build since its last restart. */
  lastBuild?: SiteBuild | null
}

export interface BuildClock {
  /** Files saved before this are reflected in the live site. */
  builtAt: number | null
  /** Why the site is frozen, when the last build failed. */
  error: string | null
  rebuilding: boolean
}

/** Read the build clock off `/rebuild/status`.
 *
 *  The boundary is the last SUCCESSFUL build's START: that is when Eleventy
 *  read the vault, so a file saved after it is not in the output even though
 *  the build finished later. A FAILED build leaves the site frozen at the
 *  previous one — the clock keeps its old value and `error` says why, so
 *  "stale" can name its cause instead of looking like a forgotten publish. */
export function buildClock(status: SiteStatus | null, prevBuiltAt: number | null): BuildClock {
  const rebuilding = !!status?.rebuilding
  const last = status?.lastBuild
  if (!last) return { builtAt: prevBuiltAt, error: null, rebuilding }
  if (last.ok === false) {
    return { builtAt: prevBuiltAt, error: last.error?.trim() || 'The last site build failed', rebuilding }
  }
  const ms = last.startedAt ? Date.parse(last.startedAt) : NaN
  return { builtAt: Number.isNaN(ms) ? prevBuiltAt : ms, error: null, rebuilding }
}

/** Project slug implied by a project-homed post path, else null. */
export function projectForPostPath(path: string): string | null {
  return path.match(/^projects\/([^/]+)\/log\/[^/]+\.md$/)?.[1] ?? null
}
