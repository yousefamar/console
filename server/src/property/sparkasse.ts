// Sparkasse-Immobilien client (Germany). Protocol notes:
// ~/sync/brain/root/projects/home/sparkasse-immobilien-api.md
//
// immobilien.sparkasse.de is the Sparkassen-Finanzgruppe's portal, and it
// syndicates ~90% of Immowelt's house stock (~30% of which is not on IS24) as
// plain, unprotected JSON with per-listing coordinates and plot size. So it is
// effectively an Immowelt mirror without Immowelt's DataDome wall.
//
// Geography is lat/lon + radius only (radius silently caps at 100 km), so each
// search ring is tiled into circles (`coverRingWithCircles`), every circle is
// queried, rows are deduped by id, and the hub clips to the real polygon.
//
// Number trap: every `numeric` field is the display `value` with the
// separators stripped, so "163,11 m²" → 16311, "3.5" Zimmer → 35 and
// "285.065,45 €" → 28506545. We parse the German-formatted `value` string
// ourselves and only fall back to `numeric` when there is no string.

import type { Ring } from './geo.js'
import { coverRingWithCircles } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ORIGIN = 'https://immobilien.sparkasse.de'
const API = `${ORIGIN}/api/immobilien-api`
/** `radius=200` returns exactly what `radius=100` does — the server caps it. */
const MAX_RADIUS_KM = 100
/** `pageSize=101` is an HTML error page. */
const PAGE = 100
/** Every request after the first in one call waits this long — no parallelism, no bursts. */
const REQUEST_DELAY_MS = 300
/** Runaway guard: 500 pages × 100 rows. No depth cap was seen live, so this should never bite. */
const MAX_PAGES = 500
const SORT_NEWEST = '3' // PROPERTY_NEWEST
const GROUPING_HAUS = '396'
const GROUPING_WOHNUNG = '403'
/** German listings count Zimmer (incl. living rooms), so bedrooms + 1 — same shift as the IS24 client. */
const ROOM_OFFSET = 1
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class SparkasseClient implements PortalClient {
  readonly portal = 'sparkasse' as const
  readonly currency = 'EUR'

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly delayMs: number = REQUEST_DELAY_MS,
  ) {}

  /**
   * Sum of per-circle counts. Circles overlap by design (the tiling has to
   * over-cover the ring, and a 100 km circle over-covers its box corner-to-
   * corner), so this OVER-estimates whenever a ring needs more than one
   * circle — a listing in two circles is counted twice. Acceptable for a
   * "roughly how many" probe; `newest()` dedupes for real.
   */
  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    const params = compile(criteria)
    let total = 0
    let first = true
    for (const ring of rings) {
      for (const c of coverRingWithCircles(ring, MAX_RADIUS_KM)) {
        if (!first) await sleep(this.delayMs)
        first = false
        const d = (await this.get('/estates/count', { ...params, ...circleParams(c) })) as { totalItems?: number }
        total += d.totalItems ?? 0
      }
    }
    return total
  }

  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const params = compile(criteria)
    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false
    let first = true

    for (const ring of rings) {
      for (const c of coverRingWithCircles(ring, MAX_RADIUS_KM)) {
        for (let page = 1; (page - 1) * PAGE < limit; page++) {
          if (!first) await sleep(this.delayMs)
          first = false
          const d = (await this.get('/estates', {
            ...params,
            ...circleParams(c),
            sort: SORT_NEWEST,
            pageSize: String(PAGE),
            page: String(page),
          })) as RawSearchResponse
          const rows = d.estates ?? []
          const pages = d.pageCount ?? 1
          if (page === 1) {
            // Same over-count caveat as count(): summed across overlapping circles.
            total += d.totalItems ?? 0
            // Defensive: no depth cap has been seen live (page 149/149 paged
            // fine), but if the portal ever reports more rows than its pages
            // hold, say so rather than silently under-pull.
            if ((d.totalItems ?? 0) > pages * PAGE) truncated = true
          }
          for (const r of rows) {
            const l = normalise(r)
            if (l) seen.set(l.id, l)
          }
          if (rows.length === 0 || page >= pages) break
          if (page >= MAX_PAGES) {
            truncated = true
            break
          }
        }
      }
    }

    return { portal: this.portal, total, listings: [...seen.values()], truncated, unsupported: unsupported(criteria) }
  }

  /**
   * `estateIds=<id>` is a cheap per-id probe: one row back while the listing
   * is indexed, `totalItems: 0` once it's gone (verified live 2026-09-07 with
   * a real id vs a made-up one). Any HTTP failure is "don't know".
   */
  async isLive(listing: Listing): Promise<boolean | null> {
    try {
      const d = (await this.get('/estates', { estateIds: listing.id, pageSize: '1' })) as RawSearchResponse
      return (d.estates ?? []).some((r) => String(r.id) === listing.id)
    } catch {
      return null
    }
  }

  private async get(endpoint: string, params: Record<string, string>): Promise<unknown> {
    const url = `${API}${endpoint}?${new URLSearchParams(params)}`
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
      if (res.ok) return res.json()
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * attempt)
        continue
      }
      throw new Error(`sparkasse: HTTP ${res.status} on ${endpoint}`)
    }
  }
}

function circleParams(c: { lat: number; lon: number; radiusKm: number }): Record<string, string> {
  return {
    latitude: c.lat.toFixed(5),
    longitude: c.lon.toFixed(5),
    radius: String(Math.min(MAX_RADIUS_KM, Math.max(1, Math.ceil(c.radiusKm)))),
  }
}

/**
 * Criteria → Sparkasse params. Unknown params AND unknown grouping ids fail
 * OPEN (a typo returns the unfiltered baseline of every type), so only emit
 * names verified against the live API (see the api note's param table).
 */
export function compile(c: Criteria): Record<string, string> {
  // Only Kauf groupings are known; `marketingType=rent` and `offerType=3` are
  // ignored / empty, so a rent search would silently return sale listings.
  if (c.channel === 'rent') throw new Error('sparkasse: rent searches are not supported (Kauf groupings only)')
  const flat = c.propertyType === 'flat'
  const any = c.propertyType === 'any'
  const p: Record<string, string> = {
    estateTypeGroupingIds: any ? `${GROUPING_HAUS},${GROUPING_WOHNUNG}` : flat ? GROUPING_WOHNUNG : GROUPING_HAUS,
    // Appears ignored (the grouping already encodes Kauf), but the site sends it.
    offerType: '2',
  }
  if (c.minPrice != null) p.minPrice = String(c.minPrice)
  if (c.maxPrice != null) p.maxPrice = String(c.maxPrice)
  // Zimmer counts living rooms too, so a 3-bedroom house is a 4-Zimmer-Haus.
  if (c.minBedrooms != null) p.minRooms = String(c.minBedrooms + ROOM_OFFSET)
  if (c.maxBedrooms != null) p.maxRooms = String(c.maxBedrooms + ROOM_OFFSET)
  // Wohnfläche for houses and flats. There is no plot-size param at all
  // (`minPropertySpace`/`minPlotSpace` are ignored) — plot is post-filtered.
  if (c.minFloorArea != null) p.minSpace = String(c.minFloorArea)
  if (c.maxFloorArea != null) p.maxSpace = String(c.maxFloorArea)
  if (!flat && c.houseSubtypes?.length) {
    const ids = c.houseSubtypes.flatMap((s) => SUBTYPE_IDS[s] ?? [])
    // Omitting the param keeps the whole Haus grouping — still houses only,
    // so an all-unmapped request (e.g. land) can't widen the query to flats.
    if (ids.length) p.estateSubTypeIds = [...new Set(ids)].join(',')
  }
  return p
}

/** Everything the portal cannot filter server-side; the hub post-filters what it can. */
export function unsupported(c: Criteria): string[] {
  const out: string[] = []
  if (c.minBathrooms != null) out.push('minBathrooms')
  if (c.minPlotArea != null) out.push('minPlotArea')
  if (c.maxPlotArea != null) out.push('maxPlotArea')
  if (c.minYearBuilt != null) out.push('minYearBuilt')
  if (c.maxYearBuilt != null) out.push('maxYearBuilt')
  // offerType 5 = Erbpachtobjekt exists as a positive filter only; nothing excludes it.
  if (c.freeholdOnly) out.push('freeholdOnly')
  if (c.excludeCommonhold) out.push('excludeCommonhold')
  if (c.mustHaveGarden) out.push('mustHaveGarden')
  if (c.mustHaveParking) out.push('mustHaveParking')
  if (c.keywords?.length) out.push('keywords')
  if (c.minInternetMbit != null) out.push('minInternetMbit')
  if (c.excludeSchemes) out.push('excludeSchemes')
  // ZV resellers (Argetra etc.) are mixed into the Haus grouping; offerType=6 returns 0.
  if (c.excludeAuctions) out.push('excludeAuctions')
  if (c.excludeNewBuild) out.push('excludeNewBuild')
  if (c.noBuyerFee) out.push('noBuyerFee')
  if (c.maxDaysSinceAdded != null) out.push('maxDaysSinceAdded')
  // No portal filters "price on request" server-side — always post-filtered.
  if (c.excludePriceOnRequest) out.push('excludePriceOnRequest')
  // `land` has no house subtype (bare land is grouping 397, and agricultural
  // land there is empty anyway); anything else unmapped is reported too.
  if (c.propertyType !== 'flat' && c.houseSubtypes?.some((s) => !SUBTYPE_IDS[s])) out.push('houseSubtypes')
  return out
}

/**
 * Our portable house subtype → Sparkasse `estateSubTypeIds` (from
 * `/api/catalogs`, grouping 396, read live 2026-09-07). Terraced covers all
 * four Reihenhaus variants; farmhouse is Resthof + Bauernhaus + Landhaus
 * (Resthof is barely used as a tag — 0 hits in a 100 km Marburg circle).
 */
const SUBTYPE_IDS: Record<string, string[]> = {
  detached: ['59'],
  'semi-detached': ['58'],
  terraced: ['54', '55', '56', '57'],
  bungalow: ['61'],
  villa: ['62'],
  farmhouse: ['63', '64', '65'],
}

/** Catalog codes for grouping 396 (Haus) and 403 (Wohnung) — the German type text we surface. */
const SUBTYPE_CODE: Record<number, string> = {
  54: 'Reihenhaus',
  55: 'Reihenendhaus',
  56: 'Reihenmittelhaus',
  57: 'Reiheneckhaus',
  58: 'Doppelhaushälfte',
  59: 'Einfamilienhaus',
  60: 'Stadthaus',
  61: 'Bungalow',
  62: 'Villa',
  63: 'Resthof',
  64: 'Bauernhaus',
  65: 'Landhaus',
  66: 'Schloss',
  67: 'Zweifamilienhaus',
  68: 'Mehrfamilienhaus',
  69: 'Ferienhaus',
  70: 'Berghütte',
  71: 'Chalet',
  72: 'Strandhaus',
  73: 'Laube/Datsche/Gartenhaus',
  74: 'Apartmenthaus',
  75: 'Burg',
  76: 'Herrenhaus',
  77: 'Finca',
  78: 'Rustico',
  79: 'Fertighaus',
  107: 'Maisonettewohnung',
  108: 'Loft/Studio/Atelier',
  109: 'Penthouse',
  110: 'Terrassenwohnung',
  111: 'Etagenwohnung',
  112: 'Erdgeschosswohnung',
  113: 'Souterrainwohnung',
  114: 'Apartment',
  115: 'Ferienwohnung',
  116: 'Galerie',
  117: 'Rohdachboden',
  118: 'Attikawohnung',
  119: 'Keine Angabe',
  120: 'Zimmer',
  134: 'Dachgeschosswohnung',
  135: 'Keine Angabe',
}

/** `offererCategory` → who is offering. 32 rows are Immowelt's stock republished here. */
const OFFERER: Record<number, string> = {
  4: 'Sparkassenangebot',
  32: 'immowelt Kooperationsangebot',
}

interface RawSearchResponse {
  estates?: RawEstate[]
  page?: number
  pageCount?: number
  totalItems?: number
}

interface RawFact {
  name?: string
  /** Display string, German locale: "163,11 m²", "1.098 m²", "3.5". */
  value?: string | null
  /** `value` with all non-digits stripped — wrong by 10× or 100× for any decimal. */
  numeric?: number | null
}

interface RawEstate {
  id?: unknown
  estateSubTypeId?: number
  objectType?: string
  offererCategory?: number
  title?: string
  /** The Ort — no PLZ or street in the row. */
  subtitle?: string
  images?: string[]
  priceData?: RawFact
  eyeCatcher?: Array<{ type?: string; label?: string }>
  mainFacts?: RawFact[]
  lat?: number
  lng?: number
}

/**
 * Parse a German-formatted display number: "." groups thousands, "," is the
 * decimal mark ("285.065,45 €" → 285065.45, "1.098 m²" → 1098) — except
 * Zimmer, which uses "." as the decimal mark ("3.5" → 3.5). A lone "." is
 * read as a thousands separator only when it is followed by exactly three
 * digits. Falls back to the portal's `numeric` when there is no string.
 */
export function parseGermanNumber(value: string | null | undefined, numeric?: number | null): number | undefined {
  if (value != null && value !== '') {
    const s = value.replace(/[^\d.,]/g, '')
    if (s) {
      let norm: string
      if (s.includes(',')) norm = s.replace(/\./g, '').replace(',', '.')
      else if (/^\d{1,3}(\.\d{3})+$/.test(s)) norm = s.replace(/\./g, '')
      else norm = s
      const n = Number(norm)
      if (Number.isFinite(n)) return n
    }
  }
  return numeric != null && Number.isFinite(numeric) ? numeric : undefined
}

function fact(r: RawEstate, name: string): number | undefined {
  const f = r.mainFacts?.find((m) => m.name === name)
  return f ? parseGermanNumber(f.value, f.numeric) : undefined
}

export function normalise(r: RawEstate): Listing | null {
  if (r.id == null || r.id === '') return null
  const id = String(r.id)
  const eyeCatcher = r.eyeCatcher?.map((e) => e.label).find(Boolean)
  return {
    portal: 'sparkasse',
    id,
    url: `${ORIGIN}/expose/${encodeURIComponent(id)}.html`,
    title: r.title,
    address: r.subtitle || undefined,
    // null = "Preis auf Anfrage" (and 0 would be too), so both read as absent.
    price: parseGermanNumber(r.priceData?.value, r.priceData?.numeric) || undefined,
    currency: 'EUR',
    // Zimmer (all rooms), not bedrooms — raw, like the IS24 client, so the
    // cross-portal dedupe compares like with like.
    bedrooms: fact(r, 'roomNumber'),
    floorArea: fact(r, 'livingSpace'),
    plotArea: fact(r, 'propertySpace'),
    propertyType: (r.estateSubTypeId != null ? SUBTYPE_CODE[r.estateSubTypeId] : undefined) ?? r.objectType,
    lat: r.lat ?? undefined,
    lon: r.lng ?? undefined,
    // Per listing (89 distinct points in a 90-row sample) — not an Ortsteil centroid.
    coordsPrecision: 'exact',
    // No listedAt in the row (only on the expose page); sort=3 keeps newest first.
    // The offerer is all the row carries: Sparkasse-own vs the Immowelt feed.
    // Kept, not dropped — the coop rows ARE the ~90% of Immowelt this portal is for.
    agent: eyeCatcher ?? (r.offererCategory != null ? OFFERER[r.offererCategory] : undefined),
    image: r.images?.[0],
  }
}
