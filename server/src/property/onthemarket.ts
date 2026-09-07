// OnTheMarket client (UK). Protocol notes:
// ~/sync/brain/root/projects/home/onthemarket-api.md
//
// One JSON endpoint does everything:
//   /async/search/properties-v2/  — 30 rows/page (fixed), page ≤ 34 (1,020-row
//                                   cap, `total-results` still reports the true
//                                   total), `polygons0=<Google polyline>` inline,
//                                   `sort-field=update_date` = newest activity first.
// No auth, no WAF, no cookies. Server-side `keywords`, `property-features`
// (garden/parking) and a WORKING `auction=false` — the three things Rightmove
// can't do — which is why this is here despite ~98% stock overlap with it.
//
// Terms / robots caveat (noting, not deciding — see the api note §Terms):
// OTM's terms §3.3 allow automated searching only by a program that "identifies
// itself uniquely in the User Agent field and is fully compliant with the
// Robots Exclusion Protocol", and robots.txt disallows every filtered URL for
// `User-agent: *` (`*max-price=`, `*min-bedrooms=`, `*prop-types=`,
// `*sort-field=`…) — i.e. every query this client sends. So: a self-identifying
// UA (not a browser spoof), one ring per request, a pause between pages, and
// the poller's hourly cadence. Keep the rate low.
//
// Traps found wiring this up (2026-09-07), beyond the api note:
//   - Every page carries a hoisted `spotlight?` row that ALSO appears in its
//     natural position, so pages past ceil(total/30) still yield NEW rows
//     (268 total → page 10 had 6 unseen ids). Never stop at the computed last
//     page — walk until a page comes back short, and dedupe by id.
//   - `direction=asc|desc` is accepted and ignored (identical order either
//     way); `update_date` is newest-first by default. Not sent.
//   - `keywords` works with or without the trailing comma; sent with, to match
//     the UI.

import type { Ring } from './geo.js'
import { encodePolyline, simplifyToLatLng } from './geo.js'
import { pageModel } from './rightmove.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'
import { normaliseTenure } from './land.js'

const UA = 'ConsoleHub-PropertyWatch/1.0 (+https://yousefamar.com; personal house-hunt poller)'
const ORIGIN = 'https://www.onthemarket.com'
const SEARCH_ENDPOINT = `${ORIGIN}/async/search/properties-v2/`
// No server-side simplification and 900 vertices are fine (api note), but
// counts converge by ~50 on a 16 km circle, so 150 keeps URLs ~1 KB with
// fidelity to spare over Rightmove's 90.
const MAX_VERTICES = 150
const PAGE_SIZE = 30 // fixed server-side; any other `frame-size` is a 400
const MAX_PAGE = 34 // page 35 is a 400 — 1,020 rows per query, hard
const SORT_NEWEST = 'update_date'
// Exhaustive pulls page through hundreds of rows per ring — space them out.
const DEEP_PAGE_DELAY_MS = 300

export interface OnTheMarketOptions {
  /** Pause between pages of one ring. Tests pass 0. */
  pageDelayMs?: number
}

export class OnTheMarketClient implements PortalClient {
  readonly portal = 'onthemarket' as const
  readonly currency = 'GBP'
  private readonly pageDelayMs: number

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    opts: OnTheMarketOptions = {},
  ) {
    this.pageDelayMs = opts.pageDelayMs ?? DEEP_PAGE_DELAY_MS
  }

  /** No count-only endpoint; page 1 per ring is the cheapest total there is. */
  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const ring of rings) {
      const data = await this.searchPage(ring, criteria, 1)
      total += parseCount(data['total-results'])
    }
    return total
  }

  /**
   * One ring per request (not `polygons0..N` unioned): `fetchAll` splits a
   * capped ring by price band and recurses, which only works if a query maps
   * to one ring — and a union hits the 1,020-row cap sooner while the UK zone's
   * 18 rings × 150 vertices would blow the ~4.4 KB URL limit anyway.
   */
  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false

    for (const ring of rings) {
      // `limit` is per ring, like the other clients — the poller wants the
      // freshest N of EVERY ring, not the first ring that fills the quota.
      for (let page = 1; (page - 1) * PAGE_SIZE < limit && page <= MAX_PAGE; page++) {
        if (page > 1 && this.pageDelayMs > 0) await sleep(this.pageDelayMs)
        const data = await this.searchPage(ring, criteria, page)
        if (page === 1) total += parseCount(data['total-results'])
        const rows = asRows(data.properties)
        for (const p of rows) {
          const l = normalise(p)
          if (l) seen.set(l.id, l)
        }
        // A short page is the only reliable end marker (see header: spotlight
        // duplicates push real rows past ceil(total/30)). A FULL page 34 means
        // the cap bit and rows are unreachable — the caller splits the price
        // range and retries, so min/max-price are compiled exactly.
        if (rows.length < PAGE_SIZE) break
        if (page === MAX_PAGE) truncated = true
      }
    }

    return {
      portal: this.portal,
      total,
      listings: [...seen.values()],
      truncated,
      unsupported: unsupportedFor(criteria),
    }
  }

  /**
   * The detail page still renders 200 for a withdrawn listing, with
   * `dataLayer.status: "retracted"` (live ones say `"live"`); an unknown id
   * 404s. Anything else (WAF, 5xx, network, unparseable page) is "don't know".
   */
  async isLive(listing: Listing): Promise<boolean | null> {
    const page = await this.detailPage(listing)
    if (page === 'gone') return false
    if (!page) return null
    const status = dataLayerOf(page)?.status
    if (status === 'live') return true
    if (status === 'retracted') return false
    return null
  }

  /**
   * `__NEXT_DATA__` → `props.initialReduxState.property`: full description,
   * feature bullets, agent-supplied floor area (often absent), full postcode.
   * No plot area anywhere on OTM, and still no listed-at date.
   */
  async detail(listing: Listing): Promise<Partial<Listing> | null> {
    const page = await this.detailPage(listing)
    if (page === 'gone' || !page) return null
    const out: Partial<Listing> = { detailAt: Date.now() }
    if (typeof page.description === 'string' && page.description.trim()) out.description = page.description.trim()
    const features = Array.isArray(page.features)
      ? page.features.map((f) => (typeof f === 'string' ? f : f?.feature)).filter((f): f is string => typeof f === 'string' && !!f)
      : []
    if (features.length) out.keyFeatures = features
    const sqm = typeof page.minimumAreaSqM === 'number' ? page.minimumAreaSqM : parseFloat(String(page.minimumAreaSqM ?? ''))
    if (Number.isFinite(sqm) && sqm > 0) out.floorArea = Math.round(sqm)
    if (typeof page.location?.lat === 'number' && typeof page.location?.lon === 'number') {
      out.lat = page.location.lat
      out.lon = page.location.lon
    }
    const postcode = dataLayerOf(page)?.postcode
    if (typeof page.displayAddress === 'string' && page.displayAddress) {
      out.address = postcode && !page.displayAddress.includes(postcode) ? `${page.displayAddress}, ${postcode}` : page.displayAddress
    } else if (postcode && listing.address && !listing.address.includes(postcode)) {
      out.address = `${listing.address}, ${postcode}`
    }
    return out
  }

  private async searchPage(ring: Ring, criteria: Criteria, page: number): Promise<RawSearch> {
    const q = new URLSearchParams([
      ['search-type', criteria.channel === 'rent' ? 'to-rent' : 'for-sale'],
      ['polygons0', polygon(ring)],
      ...compile(criteria),
      ['sort-field', SORT_NEWEST],
      ['page', String(page)],
    ])
    const res = await this.request(`${SEARCH_ENDPOINT}?${q}`, { accept: 'application/json' })
    const data = (await res.json()) as RawSearch
    if (!data || !Array.isArray(data.properties)) throw new Error('onthemarket: no properties in search response')
    return data
  }

  /** `'gone'` for a 404, null for anything we can't read, else the property model. */
  private async detailPage(listing: Listing): Promise<RawDetail | 'gone' | null> {
    let res: Response
    try {
      res = await this.fetchImpl(`${ORIGIN}/details/${encodeURIComponent(listing.id)}/`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
      })
    } catch {
      return null
    }
    if (res.status === 404 || res.status === 410) return 'gone'
    if (!res.ok) return null
    const html = await res.text()
    const model = pageModel(html, '__NEXT_DATA__') as { props?: { initialReduxState?: { property?: RawDetail } } } | null
    return model?.props?.initialReduxState?.property ?? null
  }

  private async request(url: string, extra: Record<string, string>, tries = 3): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, ...extra } })
      if (res.ok) return res
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await sleep(2000 * attempt)
        continue
      }
      // Bad enum values come back as a 400 that lists the valid ones — surface it.
      let hint = ''
      if (res.status === 400) {
        try {
          hint = ` ${(await res.text()).slice(0, 200)}`
        } catch {
          /* body unreadable — the status alone will do */
        }
      }
      throw new Error(`onthemarket: HTTP ${res.status}${hint}`)
    }
  }
}

/** Closed ring as an encoded polyline; the echo in `geo-location.polygons` shows it verbatim. */
function polygon(ring: Ring): string {
  return encodePolyline(simplifyToLatLng(ring, MAX_VERTICES, true))
}

/**
 * Our portable house subtype → OTM `prop-types` values. Granular on purpose:
 * `houses` is the superset (it pulls in terraced/end-of-terrace/town-house),
 * and a typo'd type silently returns 0 rows, so every value here is from the
 * enum `/async/search/prop-types/` returned on 2026-09-07. `bungalows` already
 * covers detached-/semi-detached-bungalow. `villa` has no OTM value.
 */
const HOUSE_SUBTYPE: Record<string, string[]> = {
  detached: ['detached', 'link-detached-house'],
  'semi-detached': ['semi-detached'],
  terraced: ['terraced', 'end-of-terrace', 'town-house'],
  bungalow: ['bungalows'],
  farmhouse: ['cottage', 'barn-conversion'],
  land: ['land'],
}
const DEFAULT_HOUSE_SUBTYPES = ['detached', 'semi-detached', 'terraced', 'bungalow']

/** Criteria.maxDaysSinceAdded → `recently-added`. No 14-day band on OTM. */
const RECENTLY_ADDED: Record<number, string> = { 1: '24-hours', 3: '3-days', 7: '7-days' }

/** Criteria → OTM query params, as pairs (several are repeatable). */
export function compile(c: Criteria): Array<[string, string]> {
  const rent = c.channel === 'rent'
  const p: Array<[string, string]> = []
  if (c.minPrice != null && c.minPrice > 0) p.push(['min-price', String(c.minPrice)]) // 0 is a 400 ("must be positive")
  if (c.maxPrice != null) p.push(['max-price', String(c.maxPrice)])
  if (c.minBedrooms != null) p.push(['min-bedrooms', String(c.minBedrooms)])
  if (c.maxBedrooms != null) p.push(['max-bedrooms', String(c.maxBedrooms)])
  if (c.propertyType === 'house') {
    const wanted = (c.houseSubtypes?.length ? c.houseSubtypes : DEFAULT_HOUSE_SUBTYPES).flatMap((s) => HOUSE_SUBTYPE[s] ?? [])
    const types = wanted.length ? wanted : DEFAULT_HOUSE_SUBTYPES.flatMap((s) => HOUSE_SUBTYPE[s]!)
    for (const t of [...new Set(types)]) p.push(['prop-types', t])
  }
  if (c.propertyType === 'flat') p.push(['prop-types', 'flats-apartments'])
  // Deliberately NOT sending min-size/max-size: accepted and silently ignored
  // on residential for-sale (only farms-land stock carries sizes). Nor `tenure`
  // — same story; tenure only exists as the first `features` bullet.
  if (c.mustHaveGarden) p.push(['property-features', 'garden'])
  if (c.mustHaveParking) p.push(['property-features', 'parking'])
  // OR-ed, csv with a trailing comma (the UI's form; works without too).
  if (c.keywords?.length) p.push(['keywords', c.keywords.map((k) => k.trim()).filter(Boolean).join(',') + ','])
  if (c.excludeSchemes) {
    p.push(['retirement', 'false'])
    if (!rent) p.push(['shared-ownership', 'false'])
  }
  // Works here, unlike Rightmove's feature-switched-off dontShow=auction.
  if (c.excludeAuctions && !rent) p.push(['auction', 'false'])
  if (c.excludeNewBuild && !rent) p.push(['new-home-flag', 'F'])
  const band = c.maxDaysSinceAdded != null ? RECENTLY_ADDED[c.maxDaysSinceAdded] : undefined
  if (band) p.push(['recently-added', band])
  return p
}

/** Criteria fields OTM can't apply server-side — the hub post-filters these. */
export function unsupportedFor(c: Criteria): string[] {
  const u: string[] = []
  // No bathroom filter at all.
  if (c.minBathrooms != null) u.push('minBathrooms')
  // Size filters are accepted and ignored on residential; list rows carry no area.
  if (c.minFloorArea != null) u.push('minFloorArea')
  if (c.maxFloorArea != null) u.push('maxFloorArea')
  if (c.minPlotArea != null) u.push('minPlotArea')
  if (c.maxPlotArea != null) u.push('maxPlotArea')
  if (c.minYearBuilt != null) u.push('minYearBuilt')
  if (c.maxYearBuilt != null) u.push('maxYearBuilt')
  // `tenure` is accepted and ignored; excludeCommonhold only narrows freeholdOnly.
  if (c.freeholdOnly) u.push('freeholdOnly')
  if (c.minInternetMbit != null) u.push('minInternetMbit')
  if (c.noBuyerFee) u.push('noBuyerFee')
  // `villa` has no prop-types value; Listing.propertyType is free text so it can't be post-filtered either.
  if (c.houseSubtypes?.some((s) => !HOUSE_SUBTYPE[s])) u.push('houseSubtypes')
  // recently-added has 24h/3d/7d bands only.
  if (c.maxDaysSinceAdded != null && !RECENTLY_ADDED[c.maxDaysSinceAdded]) u.push('maxDaysSinceAdded')
  // Rent has no auction / new-home / shared-ownership axes.
  if (c.channel === 'rent') {
    if (c.excludeAuctions) u.push('excludeAuctions')
    if (c.excludeNewBuild) u.push('excludeNewBuild')
  }
  // No portal filters "price on request" server-side — always post-filtered.
  if (c.excludePriceOnRequest) u.push('excludePriceOnRequest')
  return u
}

interface RawSearch {
  'total-results'?: unknown
  properties?: unknown
}

interface RawRow {
  id?: unknown
  'details-url'?: string
  price?: string
  'price-qualifier'?: string
  bedrooms?: number
  bathrooms?: number
  'humanised-property-type'?: string
  'property-title'?: string
  address?: string
  location?: { lat?: number; lon?: number }
  features?: unknown
  'days-since-added-reduced'?: string
  'recently-added?'?: boolean
  agent?: { name?: string }
  'cover-image'?: { default?: string }
}

interface RawDetail {
  description?: unknown
  features?: Array<{ feature?: string } | string>
  minimumAreaSqM?: unknown
  location?: { lat?: number; lon?: number }
  displayAddress?: unknown
  headerData?: { dataLayer?: unknown }
}

function asRows(v: unknown): RawRow[] {
  return Array.isArray(v) ? (v as RawRow[]) : []
}

export function normalise(p: RawRow): Listing | null {
  if (p.id == null || p.id === '') return null
  const features = Array.isArray(p.features) ? (p.features as unknown[]).filter((f): f is string => typeof f === 'string') : []
  // No prose on list rows. The "Added/Reduced < 7 days" band is the ONLY date
  // signal OTM exposes, so it leads the summary rather than being turned into
  // a fake `listedAt`. The price qualifier goes in too ("Guide price",
  // "Shared ownership") — it's the only place those words appear.
  const summary = [p['price-qualifier'], p['days-since-added-reduced'], ...features]
    .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .join(' · ')
  const lat = p.location?.lat
  const lon = p.location?.lon
  const tenureBullet = features.find((f) => /^tenure:/i.test(f))
  return {
    portal: 'onthemarket',
    tenure: normaliseTenure(tenureBullet?.replace(/^tenure:\s*/i, '')),
    id: String(p.id),
    url: ORIGIN + (p['details-url'] ?? `/details/${p.id}/`),
    title: p['property-title'],
    address: p.address,
    price: parsePrice(p.price),
    currency: 'GBP',
    bedrooms: typeof p.bedrooms === 'number' ? p.bedrooms : undefined,
    bathrooms: typeof p.bathrooms === 'number' ? p.bathrooms : undefined,
    propertyType: p['humanised-property-type'],
    lat: typeof lat === 'number' ? lat : undefined,
    lon: typeof lon === 'number' ? lon : undefined,
    listedAt: undefined,
    isNew: p['recently-added?'] === true ? true : undefined,
    summary: summary || undefined,
    agent: p.agent?.name,
    image: p['cover-image']?.default,
  }
}

/** "£230,000" → 230000; "£1,050 pcm (£242 pw)" → 1050; "POA" / absent → undefined. */
export function parsePrice(s: string | undefined): number | undefined {
  if (!s) return undefined
  // `price` is always the full figure; `short-price` ("£230k") is a different
  // field — a k/m suffix here means we're reading the wrong thing, so bail.
  const m = s.replace(/,/g, '').match(/£\s*(\d+(?:\.\d+)?)\s*([km])?/i)
  if (!m || m[2]) return undefined
  const n = parseFloat(m[1]!)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

function parseCount(v: unknown): number {
  return parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0
}

/** `headerData.dataLayer` is a JSON *string* inside the JSON. */
function dataLayerOf(page: RawDetail): { status?: string; postcode?: string } | null {
  const raw = page.headerData?.dataLayer
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? (raw as { status?: string; postcode?: string }) : null
  try {
    return JSON.parse(raw) as { status?: string; postcode?: string }
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
