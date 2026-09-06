// Property-listing review state as seen from the SPA. The hub owns the state
// (PropertySearch.interestedIds / dismissedIds); what reaches us is the pin
// layer it draws: dismissed listings are simply absent, interested ones carry
// `review: 'interested'`. "Unreviewed" = every remaining pin — that is the
// Map tab's unread count. Opening a listing never changes it; only a verdict.

const PROPERTY_LAYER_PREFIX = 'property/'

type FeatureLike = { properties?: Record<string, unknown> | null }

export function isPropertyLayer(slug: string): boolean {
  return slug.startsWith(PROPERTY_LAYER_PREFIX)
}

/** Count pins across every property layer that Yousef hasn't given a verdict on. */
export function countUnreviewedListings(layerData: Record<string, unknown>): number {
  let n = 0
  for (const [slug, gj] of Object.entries(layerData)) {
    if (!isPropertyLayer(slug)) continue
    const features = (gj as { features?: FeatureLike[] } | null)?.features
    if (!Array.isArray(features)) continue
    for (const f of features) {
      const p = f?.properties
      if (!p || p.listingId == null) continue
      if (p.review !== 'interested') n++
    }
  }
  return n
}
