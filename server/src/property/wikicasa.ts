// wikicasa.it client (Italy — the FIAIP/FIMAA/ANAMA agency-network portal).
// Protocol notes: ~/sync/brain/root/projects/home/wikicasa-api.md
//
// Plain JSON POST, no auth, no cookies; ~20% of its stock is not on
// immobiliare. Geography: the note's recipe was "one getMapMarkers per REGION,
// point-in-polygon on our side, then rows by id" — superseded 2026-09-07 by the
// undocumented `polygonFromMap` bean field, which takes a WKT POLYGON (up to
// the 3,010 vertices / 57 KB we tried) and needs no region/province/comune id
// at all. That collapses the request budget to ceil(N/25) list pages per ring
// (plus nothing — the list row carries coordinates in `cityDto`, which the
// note also had wrong: it is the listing's own point, not the comune
// centroid). Every exact-coordinate row is still re-tested against the real
// ring here, since the server clips against our (possibly simplified) WKT.
//
// Coordinates are NOT uniformly exact: with `publishMap: false` (about 40% of
// rows — the agency hides the address) `cityDto` is a per-row zone-level
// point, and the marker endpoint shows the comune's shared pin instead. Those
// rows get `coordsPrecision: 'area'` so the hub buffers the zone clip and
// keeps them out of cross-portal dedupe.

import type { Ring } from './geo.js'
import { pointInGeometry, simplifyToLatLng } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const BASE = 'https://www.wikicasa.it/api-nuxt/realEstate'
/** `limit` silently clamps at 25; `maxPhotos` must be ≥1 (0 is a 400). */
const PAGE = 25
const LIST_QS = `format=INSERTION&lang=it&maxPhotos=1`
/** The note's rate advice — one request per 1.5 s, region pulls were ~1 MB. */
const REQUEST_GAP_MS = 1500
/**
 * Full-vertex rings work (3,010 vertices verified live); this only bites on a
 * pathological ring, and the local point-in-ring test covers the deviation.
 */
const MAX_VERTICES = 3000
/** A WKT POLYGON needs 3 distinct vertices; below that it is a union sliver. */
const MIN_VERTICES = 3
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** True for a ring too degenerate to send (skipped without a request). */
export function isTooSmall(ring: Ring): boolean {
  const distinct = new Set(simplifyToLatLng(ring, MAX_VERTICES, false).map(([lat, lng]) => `${lat},${lng}`))
  return distinct.size < MIN_VERTICES
}

export class WikicasaClient implements PortalClient {
  readonly portal = 'wikicasa' as const
  readonly currency = 'EUR'
  private lastRequestAt = 0

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const ring of rings) {
      if (isTooSmall(ring)) continue
      const d = await this.list({ ...compile(criteria), polygonFromMap: wkt(ring) }, 1, 0)
      total += d.count ?? 0
    }
    return total
  }

  /**
   * Newest-first (`filterOrder: MOST_RECENT`, verified to match id order),
   * paged by offset until the ring is exhausted or `limit` rows are in hand.
   * Offsets were fine to 10,000 and `count` is the true total, so a
   * `limit` of Infinity really does walk to the end and `truncated` stays
   * false — the portal has no result cap for us to hit.
   */
  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const seen = new Map<string, Listing>()
    let total = 0
    const isRent = criteria.channel === 'rent'

    for (const ring of rings) {
      if (isTooSmall(ring)) continue
      const bean = { ...compile(criteria), polygonFromMap: wkt(ring), filterOrder: 'MOST_RECENT' }
      const ringGeom = { type: 'Polygon', coordinates: [ring] }
      let taken = 0
      for (let offset = 0; taken < limit; offset += PAGE) {
        const d = await this.list(bean, PAGE, offset)
        if (offset === 0) total += d.count ?? 0
        const rows = d.results ?? []
        for (const r of rows) {
          const l = normalise(r, isRent)
          if (!l) continue
          // The server clipped to our WKT (exactly, for a full-vertex ring);
          // re-test exact rows against the real ring anyway. Fuzzy rows keep
          // whatever the server allowed — the hub applies its own buffer.
          if (l.coordsPrecision !== 'area' && l.lat != null && l.lon != null && !pointInGeometry([l.lon, l.lat], ringGeom)) continue
          seen.set(l.id, l)
        }
        taken += rows.length
        if (rows.length < PAGE || offset + PAGE >= (d.count ?? 0)) break
      }
    }

    return { portal: this.portal, total, listings: [...seen.values()], truncated: false, unsupported: unsupportedOf(criteria) }
  }

  /**
   * `realEstateIdList` returns exactly the ids still published — a missing id
   * is simply absent (the endpoint answers HTTP 404 "No real estate found"
   * when none are). One ~5 KB request per probe. Anything else → unknown.
   */
  async isLive(listing: Listing, criteria: Criteria): Promise<boolean | null> {
    const id = Number(listing.id)
    if (!Number.isFinite(id)) return null
    try {
      const d = await this.list({ ...channelBean(criteria.channel), portal: 'WIKICASA', realEstateIdList: [id] }, 1, 0)
      return (d.results ?? []).some((r) => r.realEstateID === id)
    } catch {
      return null
    }
  }

  private async list(bean: Record<string, unknown>, limit: number, offset: number): Promise<RawListResponse> {
    const url = `${BASE}/getListRealEstate?limit=${limit}&offset=${offset}&${LIST_QS}`
    for (let attempt = 1; ; attempt++) {
      await this.pace()
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(bean),
      })
      if (res.ok) return (await res.json()) as RawListResponse
      // An empty result set is a 404 with a JSON error body, not an empty list.
      if (res.status === 404) {
        const text = await res.text().catch(() => '')
        if (/No real estate found/i.test(text)) return { count: 0, results: [] }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await this.sleep(2000 * attempt)
        continue
      }
      throw new Error(`wikicasa: HTTP ${res.status}`)
    }
  }

  /** ≥ REQUEST_GAP_MS between any two requests from this client instance. */
  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + REQUEST_GAP_MS - Date.now()
    if (wait > 0) await this.sleep(wait)
    this.lastRequestAt = Date.now()
  }
}

/** WKT `POLYGON((lng lat, …))`, closed, ≤ MAX_VERTICES. */
export function wkt(ring: Ring): string {
  const pts = simplifyToLatLng(ring, MAX_VERTICES, false)
  const closed = [...pts, pts[0]!]
  return `POLYGON((${closed.map(([lat, lng]) => `${lng.toFixed(6)} ${lat.toFixed(6)}`).join(', ')}))`
}

function channelBean(channel: Criteria['channel']): Record<string, unknown> {
  const rent = channel === 'rent'
  return { sale: !rent, rent, contractType: rent ? 2 : 1 }
}

/**
 * Criteria → search bean. Unknown fields fail OPEN (ignored, count
 * unchanged), so only names verified live on 2026-09-07 are emitted — each
 * of these moved the Toscana count when set. `maxBedrooms` is deliberately
 * NOT mapped to `roomsTo`: `rooms` is locali (all habitable rooms), so
 * `roomsTo: 3` would drop every 3-bedroom house; `roomsFrom` is safe because
 * locali ≥ camere.
 */
export function compile(c: Criteria): Record<string, unknown> {
  const b: Record<string, unknown> = { ...channelBean(c.channel), portal: 'WIKICASA' }
  b.listingTypologyIdList = typologyIds(c)
  if (c.minPrice != null) b.priceFrom = c.minPrice
  if (c.maxPrice != null) b.priceTo = c.maxPrice
  if (c.minBedrooms != null) b.roomsFrom = c.minBedrooms
  if (c.minBathrooms != null) b.bathroomsFrom = c.minBathrooms
  if (c.minFloorArea != null) b.sqMfrom = c.minFloorArea
  if (c.maxFloorArea != null) b.sqMto = c.maxFloorArea
  // Private garden specifically (`publicGarden` is the shared/condominio one).
  if (c.mustHaveGarden) b.privateGarden = true
  // Garage OR parking space; `box` alone is garages only.
  if (c.mustHaveParking) b.boxCarSpot = true
  // Real auction flag — the default search INCLUDES auctions (8 of 8,083).
  if (c.excludeAuctions) b.excludeAuctions = true
  // Nuda proprietà — seller keeps lifetime use; looks like a bargain, isn't.
  if (c.freeholdOnly) b.excludeBareOwnership = true
  return b
}

/**
 * Search-side typology ids (`GET build/listingTypologies`, CASE branch):
 * 0 all CASE, 5 APPARTAMENTI, 6 VILLE, 7 VILLE_A_SCHIERA, 8 ATTICI,
 * 9 CASE_INDIPENDENTI, 10 RUSTICI, 59 VILLE_BIFAMILIARI; TERRENI branch
 * 30 EDIFICABILI, 31 AGRICOLI (mixing the two branches in one list works).
 * These are NOT the per-listing `typologyID` values on a row.
 */
const IT_TIPOLOGIA: Record<string, number[]> = {
  detached: [9],
  'semi-detached': [59],
  terraced: [7],
  villa: [6],
  farmhouse: [10],
  land: [30, 31],
}
const HOUSE_DEFAULTS = ['detached', 'semi-detached', 'terraced', 'villa', 'farmhouse']

function typologyIds(c: Criteria): number[] {
  if (c.propertyType === 'flat') return [5, 8]
  if (c.propertyType !== 'house') return [0]
  const wanted = c.houseSubtypes?.length ? c.houseSubtypes : HOUSE_DEFAULTS
  const ids = [...new Set(wanted.flatMap((s) => IT_TIPOLOGIA[s] ?? []))]
  // Every requested subtype unmapped (bungalow-only): sending no typology at
  // all would widen to every CASE type incl. flats — fall back to houses.
  return ids.length ? ids : [...new Set(HOUSE_DEFAULTS.flatMap((s) => IT_TIPOLOGIA[s]!))]
}

function unsupportedOf(c: Criteria): string[] {
  const u: string[] = []
  // Locali, not camere — see compile(). Nothing downstream enforces this either.
  if (c.maxBedrooms != null) u.push('maxBedrooms')
  if (c.minPlotArea != null) u.push('minPlotArea')
  if (c.maxPlotArea != null) u.push('maxPlotArea')
  if (c.minYearBuilt != null) u.push('minYearBuilt')
  if (c.maxYearBuilt != null) u.push('maxYearBuilt')
  if (c.minInternetMbit != null) u.push('minInternetMbit')
  if (c.excludeNewBuild) u.push('excludeNewBuild')
  if (c.noBuyerFee) u.push('noBuyerFee')
  if (c.maxDaysSinceAdded != null) u.push('maxDaysSinceAdded')
  // excludeAuctions is real here; there is no retirement/shared-ownership flag.
  if (c.excludeSchemes) u.push('excludeSchemes')
  if (c.excludeCommonhold) u.push('excludeCommonhold')
  // `query` exists in the internal bean but is unverified — hub matches text.
  if (c.keywords?.length) u.push('keywords')
  if (c.houseSubtypes?.some((s) => !IT_TIPOLOGIA[s])) u.push('houseSubtypes')
  // `reservedPrice` rows come back regardless; normalise() blanks their price.
  if (c.excludePriceOnRequest) u.push('excludePriceOnRequest')
  return u
}

interface RawListResponse {
  count?: number
  results?: RawRow[]
}

export interface RawRow {
  realEstateID?: number
  url?: string
  title?: string
  address?: string
  cityName?: string
  price?: number
  priceSale?: number
  priceRent?: number
  reservedPrice?: boolean
  sqm?: number
  rooms?: number
  bathrooms?: number
  publishMap?: boolean
  cityDto?: { latitude?: number; longitude?: number }
  date?: string
  recent?: boolean
  description?: string
  agency?: { name?: string }
  reImages?: Array<{ images?: Array<{ format?: number; storagePath?: string }> }>
}

/** Land/garden area phrase from the description, e.g. "giardino privato di circa 250 mq". */
const PLOT_RE = /(?:terreno|giardino|parco|resede)[^.;:]{0,60}?\d[\d.]*\s*(?:mq|m²|m2|metri quadr\w*)|\d[\d.]*\s*(?:mq|m²|m2|metri quadr\w*)\s*(?:circa\s+)?(?:di\s+)?(?:terreno|giardino|parco|resede)/i

export function normalise(r: RawRow, rent = false): Listing | null {
  if (!r.realEstateID) return null
  const id = String(r.realEstateID)
  const exact = r.publishMap === true
  const desc = (r.description ?? '').replace(/\s+/g, ' ').trim()
  const price = rent ? r.priceRent : r.priceSale
  const listedAt = r.date ? new Date(r.date.replace(/\+0000$/, 'Z')) : undefined
  return {
    portal: 'wikicasa',
    id,
    url: r.url?.startsWith('/') ? `https://www.wikicasa.it${r.url}` : `https://www.wikicasa.it/annuncio/${id}`,
    title: r.title,
    address: [r.address, r.cityName].filter(Boolean).join(', ') || undefined,
    price: !r.reservedPrice && price && price > 0 ? price : undefined,
    currency: 'EUR',
    // Locali (all habitable rooms) — the row has no camere count. Upper bound
    // on bedrooms, so the hub's minBedrooms gate stays fail-open.
    bedrooms: positive(r.rooms),
    bathrooms: positive(r.bathrooms),
    floorArea: positive(r.sqm),
    propertyType: propertyTypeOf(r.title),
    lat: r.cityDto?.latitude,
    lon: r.cityDto?.longitude,
    coordsPrecision: exact ? undefined : 'area',
    listedAt: listedAt && !Number.isNaN(listedAt.getTime()) ? listedAt.toISOString() : undefined,
    isNew: r.recent,
    summary: summaryOf(desc),
    agent: r.agency?.name,
    image: imageOf(r),
  }
}

/** "Villa in Via Roma 1, Pisa" / "Rustico, Bucine" → "Villa" / "Rustico". */
function propertyTypeOf(title: string | undefined): string | undefined {
  if (!title) return undefined
  const m = /^(.+?)(?:\s+in\s+|,\s)/.exec(title)
  return (m?.[1] ?? title).trim() || undefined
}

/** First 400 chars, with the land/garden m² phrase pulled forward if it sits past the cut. */
function summaryOf(desc: string): string | undefined {
  if (!desc) return undefined
  const head = desc.slice(0, 400)
  const plot = PLOT_RE.exec(desc)?.[0].trim()
  return plot && !head.includes(plot) ? `[${plot}] ${head}` : head
}

function imageOf(r: RawRow): string | undefined {
  const imgs = r.reImages?.[0]?.images ?? []
  return imgs.find((i) => i.format === 1)?.storagePath ?? imgs[0]?.storagePath
}

function positive(n: number | undefined): number | undefined {
  return typeof n === 'number' && n > 0 ? n : undefined
}
