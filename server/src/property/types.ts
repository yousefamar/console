// Portal-agnostic property-search types.
//
// The three portals (Rightmove / immobiliare.it / ImmoScout24) are documented in
// ~/sync/brain/root/projects/home/{rightmove,immobiliare,immoscout24}-api.md.
// Each speaks a different dialect; `Criteria` is the one declarative shape WE
// own, and each client compiles it into its own query.

// Primary portals (one per country) plus the extra sources surveyed 2026-09-07
// (^spry-tern; protocol notes: ~/sync/brain/root/projects/home/<portal>-api.md).
// A name here does not mean a client exists yet — PropertySync errors clearly
// when a search names a portal with no client wired in index.ts.
export type Portal =
  | 'rightmove'
  | 'immobiliare'
  | 'immoscout24'
  | 'onthemarket'
  | 'smallholdings'
  | 'sparkasse'
  | 'kleinanzeigen'
  | 'immowelt'
  | 'wikicasa'
  | 'subito'
  | 'casa'

export type Channel = 'buy' | 'rent'

/**
 * A search's criteria, portal-independent. Every field is optional; a client
 * silently drops what its portal can't express (and reports it in
 * `Listing.unfiltered` terms via the search's `notes`).
 */
export interface Criteria {
  channel?: Channel
  /**
   * House vs flat vs any. Portals have far richer taxonomies; this is the axis
   * we care about. `land` = bare plots (Rightmove `propertyTypes=land`; the
   * other clients have no land type and ignore it).
   */
  propertyType?: 'house' | 'flat' | 'land' | 'any'
  /**
   * Narrows `propertyType: 'house'` to specific house types. Portal-agnostic
   * subset: `detached | semi-detached | terraced | bungalow | villa | farmhouse | land`.
   * Omitted → the client's existing fixed default (detached/semi/terraced/bungalow on
   * Rightmove, `SINGLE_FAMILY_HOUSE` on IS24, detached/semi-terraced/villa on immobiliare).
   */
  houseSubtypes?: string[]
  /**
   * House subtypes that are out regardless of what the portal returns —
   * enforced LOCALLY on every portal via the listing's own type text
   * (`normaliseHouseType`), because portal type filters are coarse: Rightmove's
   * `propertyTypes` omits "terraced" yet still returns "Town House" and
   * "Terraced Bungalow". Unclassifiable text is kept (fail-open, like every
   * other local post-filter).
   */
  excludeHouseSubtypes?: string[]
  /** Local currency of the portal — GBP for Rightmove, EUR for the other two. */
  minPrice?: number
  maxPrice?: number
  /**
   * Bedrooms, UK/IT convention. IS24 counts *Zimmer* (all habitable rooms), so
   * the German client adds one — a 3-bed house is a 4-Zimmer-Haus.
   */
  minBedrooms?: number
  maxBedrooms?: number
  minBathrooms?: number
  /** Interior floor area, m². */
  minFloorArea?: number
  maxFloorArea?: number
  /** Plot / land area, m². Only ImmoScout24 filters this server-side. */
  minPlotArea?: number
  maxPlotArea?: number
  /** Year of construction. Only ImmoScout24 filters this. */
  minYearBuilt?: number
  maxYearBuilt?: number
  /**
   * Outright ownership only — `FREEHOLD`/`SHARE_OF_FREEHOLD` on Rightmove,
   * `tipoProprieta=1` on immobiliare. Germany's Erbbaurecht equivalent has no
   * IS24 filter, so DE searches can't express this.
   */
  freeholdOnly?: boolean
  /**
   * Narrows `freeholdOnly` to sole freehold — drop `SHARE_OF_FREEHOLD` (you'd
   * own a slice of the freehold company, not the whole thing) as well as the
   * near-empty `COMMONHOLD` tenure. Rightmove only; no effect without
   * `freeholdOnly` also set.
   */
  excludeCommonhold?: boolean
  /** Must list a (private) garden. Redundant on IS24, where `minPlotArea` is exact. */
  mustHaveGarden?: boolean
  mustHaveParking?: boolean
  /** Free-text terms. Real filters on immobiliare + IS24; sort-only on Rightmove. */
  keywords?: string[]
  /** Minimum broadband speed, Mbit. Only ImmoScout24 filters this. */
  minInternetMbit?: number
  /**
   * Drop retirement housing and shared-ownership/shared-equity schemes —
   * "just a normal house for sale", separate from auctions (see
   * `excludeAuctions`). Each portal applies as much of it as it can express.
   */
  excludeSchemes?: boolean
  /**
   * Drop auctions and forced sales specifically. Split from `excludeSchemes`
   * because auctions aren't a red flag on their own — just a different, faster
   * completion process (typically ~28 days, cash-ready or bridging finance,
   * no survey contingency) — so they're worth including or excluding as their
   * own decision rather than bundled with retirement/shared-ownership stock.
   * Rightmove's own `dontShow=auction` flag is feature-switched off, so this is
   * always enforced by matching listing text, on all three portals.
   */
  excludeAuctions?: boolean
  /**
   * Drop new-builds. Server-side on Rightmove (`dontShow=newHome`) and
   * OnTheMarket; everywhere else enforced locally from developer/new-build
   * wording (`place.ts newBuildLike`) when the portal reports it unsupported.
   */
  excludeNewBuild?: boolean
  /**
   * Straight-line metres from the listing to the nearest high-street cell
   * (`place.ts`, data from the vault's OSM shop pipeline). ~400 = five minutes
   * on foot. Always local, at draw time; no portal can express it. Listings
   * without coordinates pass (can't be measured); no index loaded = pass.
   */
  maxHighStreetM?: number
  /** No buyer-side agent commission (IS24 `onlyWithoutCourtage`). Germany only. */
  noBuyerFee?: boolean
  /** Only listings added within N days. Rightmove only, and only 1 | 3 | 7 | 14. */
  maxDaysSinceAdded?: number
  /**
   * Drop "price on request" listings — IS24 sends `price.value: 0` for these
   * (verified live: the listing's own page shows "Auf Anfrage", not a data
   * error), and the same convention holds on the other two portals. No
   * portal filters this server-side, so it's always post-filtered on
   * `Listing.price` being absent.
   */
  excludePriceOnRequest?: boolean
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
  /**
   * Normalised tenure where the portal states it: `freehold`,
   * `share-of-freehold`, `leasehold`, `commonhold`, or the raw text. Leasehold
   * is an automatic disqualification for Yousef; enforced in postFilter
   * whenever `freeholdOnly` is set, for every portal.
   */
  tenure?: string
  lat?: number
  lon?: number
  /**
   * How much to trust lat/lon. `exact` (default) = the property itself.
   * `area` = a comune/PLZ/place centroid (Subito, Kleinanzeigen, geocoded
   * feeds) — the zone clip allows a buffer for these, and dedupe ignores them.
   */
  coordsPrecision?: 'exact' | 'area'
  /** ISO timestamp the portal first listed it, where exposed. */
  listedAt?: string
  /** Portal's own "this is new" flag, where exposed. */
  isNew?: boolean
  summary?: string
  /** Bullet features from the detail page, where a client's `detail()` has run. */
  keyFeatures?: string[]
  /** Full description from the detail page, where a client's `detail()` has run. */
  description?: string
  /** When `detail()` last enriched this row (epoch ms). */
  detailAt?: number
  agent?: string
  image?: string
  /**
   * Nearest airport + real drive/transit time, computed once per genuinely-
   * new listing (not the whole result set — see property/airport-distance.ts
   * and PropertySync.notify). Absent until computed, or if Google Maps isn't
   * configured / the lookup failed.
   */
  nearestAirport?: {
    iata: string
    name: string
    driveMinutes: number
    /** null when Google has no transit schedule data for this route. */
    transitMinutes: number | null
  }
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
  /**
   * Is this listing still on the portal? `false` = the portal removed it
   * (delisted/deactivated/404), `true` = still there, `null` = couldn't tell
   * (WAF/network) — callers must treat null as "keep". Optional: a portal
   * without a cheap probe simply never prunes.
   */
  isLive?(listing: Listing, criteria: Criteria): Promise<boolean | null>
  /**
   * Optional: fetch the listing's own page and return the fields the search
   * results don't carry — `keyFeatures`, `description`, a parsed `plotArea`,
   * exact coordinates, a real `listedAt`. One request per listing, so the
   * caller paces it (PropertySync.enrich). Return null when the page is gone
   * or unreadable; throw only for "stop calling me" conditions (WAF, ban).
   */
  detail?(listing: Listing): Promise<Partial<Listing> | null>
  /**
   * Optional cadence hints for sources that must be crawled slowly
   * (Kleinanzeigen: one request per 3 min, one skim a day). PropertySync uses
   * them in place of its defaults: how often to skim (`skimIntervalMs`, default
   * every tick), how often to run the exhaustive pull (`Infinity` = never), and
   * how many detail pages to fetch per hourly tick (0 = none).
   */
  readonly pacing?: { skimIntervalMs?: number; fullSyncIntervalMs?: number; enrichPerTick?: number }
}
