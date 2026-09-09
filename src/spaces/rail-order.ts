import type { SpaceSummary } from '@/store/spaces'

/** A space earns the top of its rail section when something in it waits on
 *  Yousef: an alert row (unread/attention agent, dirty buffer, draft…) OR a
 *  card sitting in Under Review. The second is separate because a card-owned
 *  fork's hand-back produces NO alert row (the kanban badge tint is its
 *  affordance) — without it a project with work to approve sorted
 *  alphabetically, below idle ones. */
export function spaceNeedsAttention(space: SpaceSummary, alertedSlugs: ReadonlySet<string>): boolean {
  return alertedSlugs.has(space.slug) || (space.reviewCount ?? 0) > 0
}

/** Rail order: spaces needing attention first, then title. */
export function compareSpacesForRail(alertedSlugs: ReadonlySet<string>) {
  return (a: SpaceSummary, b: SpaceSummary) => {
    const ad = spaceNeedsAttention(a, alertedSlugs) ? 0 : 1
    const bd = spaceNeedsAttention(b, alertedSlugs) ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.title.localeCompare(b.title)
  }
}
