// Portal-agnostic property-search types.
//
// The three portals (Rightmove / immobiliare.it / ImmoScout24) are documented in
// ~/sync/brain/root/projects/home/{rightmove,immobiliare,immoscout24}-api.md.
// Each speaks a different dialect; `Criteria` is the one declarative shape WE
// own, and each client compiles it into its own query.

export type Portal = 'rightmove' | 'immobiliare' | 'immoscout24'

export type Channel = 'buy' | 'rent'

/**
 * A search's criteria, portal-independent. Every field is optional; a client
 * silently drops what its portal can't express (and reports it in
 * `Listing.unfiltered` terms via the search's `notes`).
 */
export interface Criteria {
  channel?: Channel
  /** House vs flat vs any. Portals have far richer taxonomies; this is the axis we care about. */
  propertyType?: 'house' | 'flat' | 'any'
  minPrice?: number
  maxPrice?: number
  /** Local currency of the portal — GBP for Rightmove, EUR for the other two. */
  minBedrooms?: number
  maxBedrooms?: number
  /** Interior floor area, m². */
  minFloorArea?: number
  /** Plot / land area, m². Only ImmoScout24 filters this server-side. */
  minPlotArea?: number
  /** Free-text terms. Real filters on immobiliare + IS24; sort-only on Rightmove. */
  keywords?: string[]
  /** Minimum broadband speed, Mbit. Only ImmoScout24 filters this. */
  minInternetMbit?: number
  /** Exclude auctions / repossessions where the portal supports it. */
  excludeAuctions?: boolean
}

/** A normalised listing. Fields absent from a portal stay undefined. */
export interface Listing {
  portal: Portal
  /** Portal-local id. Unique only within a portal. */
  id: string
  url: string
  title?: string
  address?: string
  /** Major units in the portal's currency. */
  price?: number
  currency: string
  bedrooms?: number
  bathrooms?: number
  /** m² */
  floorArea?: number
  /** m² — plot/land. */
  plotArea?: number
  propertyType?: string
  lat?: number
  lon?: number
  /** ISO timestamp the portal first listed it, where exposed. */
  listedAt?: string
  /** Portal's own "this is new" flag, where exposed. */
  isNew?: boolean
  summary?: string
  agent?: string
  image?: string
}

export interface SearchResult {
  portal: Portal
  /** Portal's own reported total for the query (may exceed `listings.length`). */
  total: number
  listings: Listing[]
  /** True when the portal admits it truncated the result set. */
  truncated: boolean
  /** Criteria the portal could NOT apply — the caller must post-filter these. */
  unsupported: string[]
}

/** Everything a portal client must implement. */
export interface PortalClient {
  readonly portal: Portal
  readonly currency: string
  /** Cheap total-only probe. Not all portals have one; falls back to a page-1 search. */
  count(rings: import('./geo.js').Ring[], criteria: Criteria): Promise<number>
  /**
   * Newest-first listings. `limit` caps how many we pull — the poller only
   * needs the freshest page or two, not the whole result set.
   */
  newest(rings: import('./geo.js').Ring[], criteria: Criteria, limit: number): Promise<SearchResult>
}
