// Pure ranking for the Console-wide command bar. Keeps the UI component free
// of anything that needs a unit test: fuzzy scoring, empty-query launcher
// composition and per-kind flooding caps.

export type CommandKind =
  | 'pane'
  | 'action'
  | 'area'
  | 'project'
  | 'session'
  | 'file'
  | 'room'
  | 'thread'
  | 'feed'
  | 'bookmark'
  | 'event'
  | 'create'

export interface Rankable {
  key: string
  title: string
  hint?: string
  kind: CommandKind
  /** Activity timestamp (ms). 0 = never / not applicable. */
  recency: number
}

/** Kinds that read as "structure" (a place to go) rather than "content":
 *  on an equal fuzzy score they beat content so `mail` lands on the Mail
 *  pane before a thread whose subject starts with "mail". */
const STRUCTURE: ReadonlySet<CommandKind> = new Set(['pane', 'action', 'area', 'project'])

/** Kinds shown in the empty-query "Recent" band, in tie-break order. */
export const RECENT_KINDS: readonly CommandKind[] = ['session', 'file', 'room', 'thread']

/** Subsequence fuzzy match → score (lower is better), or -1 for no match.
 *  A contiguous substring beats any scattered subsequence; an earlier hit
 *  beats a later one. */
export function fuzzyScore(text: string, q: string): number {
  const idx = text.indexOf(q)
  if (idx >= 0) return idx
  let ti = 0, qi = 0, first = -1
  while (ti < text.length && qi < q.length) {
    if (text[ti] === q[qi]) { if (first < 0) first = ti; qi++ }
    ti++
  }
  return qi === q.length ? 1000 + first : -1
}

export interface RankOpts {
  /** Max rows returned for a non-empty query. */
  limit?: number
  /** Empty-query "Recent" band size and its per-kind cap. */
  recentLimit?: number
  recentPerKind?: number
  /** Empty-query "Upcoming" band size (events, soonest first). */
  upcomingLimit?: number
}

/** Rank `entries` for `query`.
 *
 *  Empty query = launcher: the most recent things across sessions/files/
 *  rooms/threads (per-kind capped so mail can't flood it), the next few
 *  calendar events, then every pane and action. Non-empty = one flat fuzzy
 *  list over everything, best match first, structure before content on a tie,
 *  then most recent first. */
export function rankEntries<T extends Rankable>(entries: readonly T[], query: string, opts: RankOpts = {}): T[] {
  const q = query.trim().toLowerCase()
  const limit = opts.limit ?? 50
  if (!q) {
    const recentLimit = opts.recentLimit ?? 10
    const perKind = opts.recentPerKind ?? 3
    const upcomingLimit = opts.upcomingLimit ?? 3
    const recent = entries
      .filter((e) => RECENT_KINDS.includes(e.kind) && e.recency > 0)
      .sort((a, b) => b.recency - a.recency)
    const seen = new Map<CommandKind, number>()
    const recentOut: T[] = []
    for (const e of recent) {
      if (recentOut.length >= recentLimit) break
      const n = seen.get(e.kind) ?? 0
      if (n >= perKind) continue
      seen.set(e.kind, n + 1)
      recentOut.push(e)
    }
    // Upcoming events carry recency = start time; soonest first.
    const upcoming = entries
      .filter((e) => e.kind === 'event')
      .sort((a, b) => a.recency - b.recency)
      .slice(0, upcomingLimit)
    const structure = entries.filter((e) => e.kind === 'pane' || e.kind === 'action')
    return [...recentOut, ...upcoming, ...structure]
  }
  return entries
    .map((e) => ({ e, score: fuzzyScore(`${e.title} ${e.hint ?? ''}`.toLowerCase(), q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      const sa = STRUCTURE.has(a.e.kind) ? 0 : 1
      const sb = STRUCTURE.has(b.e.kind) ? 0 : 1
      if (sa !== sb) return sa - sb
      return b.e.recency - a.e.recency
    })
    .slice(0, limit)
    .map((x) => x.e)
}

/** Section label for a row in the empty-query launcher, or null when the
 *  row continues the previous section. */
export function launcherSection(kind: CommandKind): 'Recent' | 'Upcoming' | 'Go to' {
  if (kind === 'event') return 'Upcoming'
  if (kind === 'pane' || kind === 'action') return 'Go to'
  return 'Recent'
}
