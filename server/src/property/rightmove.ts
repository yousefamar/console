// Rightmove client (UK). Protocol notes:
// ~/sync/brain/root/projects/home/rightmove-api.md
//
// Two endpoints, because neither alone does what we need:
//   /api/property-search/map/search  — clean JSON, 121 rows/page, IGNORES sortType
//   /property-for-sale/find.html     — HTML with __NEXT_DATA__, 24 rows/page,
//                                     HONOURS sortType=6 (newest first)
// The poller only wants the freshest listings, so it uses the HTML list view.
// `count()` uses the JSON endpoint (one small request, no HTML parse).

import type { Ring } from './geo.js'
import { encodePolyline, simplifyToLatLng } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'
import { plotAreaFromText, normaliseTenure } from './land.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const MAP_ENDPOINT = 'https://www.rightmove.co.uk/api/property-search/map/search'
const MAX_VERTICES = 90 // the server simplifies to ~85 anyway
const LIST_PAGE = 24 // fixed server-side; numberOfPropertiesPerPage is ignored on the HTML view
const INDEX_MAX = 1000 // index > 1000 is a 400
const SORT_NEWEST = '6'
const REMOVED_RE = /property has been removed|no longer (?:available|on the market)/i
// Exhaustive pulls page through hundreds of rows per ring — space them out.
const DEEP_PAGE_DELAY_MS = 300

export class RightmoveClient implements PortalClient {
  readonly portal = 'rightmove' as const
  readonly currency = 'GBP'

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const ring of rings) {
      const q = new URLSearchParams({
        locationIdentifier: locationIdentifier(ring),
        numberOfPropertiesPerPage: '1',
        index: '0',
        ...compile(criteria),
      })
      const data = await this.getJson(`${MAP_ENDPOINT}?${q}`)
      total += parseCount((data as { resultCount?: unknown }).resultCount)
    }
    return total
  }

  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false

    for (const ring of rings) {
      for (let index = 0; index < limit; index += LIST_PAGE) {
        if (index > INDEX_MAX) {
          truncated = true
          break
        }
        const q = new URLSearchParams({
          locationIdentifier: locationIdentifier(ring),
          sortType: SORT_NEWEST,
          index: String(index),
          ...compile(criteria),
        })
        const path = criteria.channel === 'rent' ? 'property-to-rent' : 'property-for-sale'
        const html = await this.getText(`https://www.rightmove.co.uk/${path}/find.html?${q}`)
        const model = pageModel(html, '__NEXT_DATA__') as
          | { props?: { pageProps?: { searchResults?: { resultCount?: unknown; properties?: unknown[] } } } }
          | null
        const sr = model?.props?.pageProps?.searchResults
        if (!sr) throw new Error('rightmove: no searchResults in list page')
        if (index === 0) total += parseCount(sr.resultCount)
        const rows = (sr.properties ?? []) as RawListRow[]
        for (const p of rows) {
          const l = normalise(p)
          if (l) seen.set(l.id, l)
        }
        if (rows.length < LIST_PAGE) break
        if (limit > LIST_PAGE * 4) await sleep(DEEP_PAGE_DELAY_MS)
      }
    }

    // `keywords` is a SORT on Rightmove, not a filter, so we never send it —
    // the caller post-filters on summary text instead.
    const unsupported: string[] = []
    if (criteria.keywords?.length) unsupported.push('keywords')
    // `villa`/`farmhouse` have no Rightmove propertyTypes value and Listing.propertyType
    // is free text, so there's no way to post-filter them either — flag and move on.
    if (criteria.houseSubtypes?.some((s) => !HOUSE_SUBTYPE[s])) unsupported.push('houseSubtypes')
    if (criteria.minPlotArea != null) unsupported.push('minPlotArea')
    if (criteria.maxPlotArea != null) unsupported.push('maxPlotArea')
    if (criteria.minInternetMbit != null) unsupported.push('minInternetMbit')
    if (criteria.minFloorArea != null) unsupported.push('minFloorArea')
    if (criteria.maxFloorArea != null) unsupported.push('maxFloorArea')
    if (criteria.minYearBuilt != null) unsupported.push('minYearBuilt')
    if (criteria.maxYearBuilt != null) unsupported.push('maxYearBuilt')
    if (criteria.noBuyerFee) unsupported.push('noBuyerFee')
    // Rightmove's dontShow=auction flag is feature-switched off, so auctions
    // are always matched on listing text, on every portal.
    if (criteria.excludeAuctions) unsupported.push('excludeAuctions')
    // No portal filters "price on request" server-side — always post-filtered.
    if (criteria.excludePriceOnRequest) unsupported.push('excludePriceOnRequest')

    return {
      portal: this.portal,
      total,
      listings: [...seen.values()],
      truncated,
      unsupported,
    }
  }

  /**
   * A removed listing's page answers 410 (verified live 2026-09-07 — an
   * unknown id gives 410 Gone, a live one 200). Rightmove also serves a
   * 200 "removed by the agent" page for a while after withdrawal, so the body
   * is checked too. Anything else (WAF, 5xx, network) is "don't know".
   */
  async isLive(listing: Listing): Promise<boolean | null> {
    let res: Response
    try {
      res = await this.fetchImpl(`https://www.rightmove.co.uk/properties/${encodeURIComponent(listing.id)}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
      })
    } catch {
      return null
    }
    if (res.status === 404 || res.status === 410) return false
    if (!res.ok) return null
    const html = await res.text()
    return !REMOVED_RE.test(html)
  }

  /**
   * The listing's own page: key features, the full description, the agent's
   * exact property sub-type, tenure, listing history and (rarely) sizings —
   * none of which the search rows carry. The page embeds a SvelteKit
   * `devalue`-flattened model (`window.__PAGE_MODEL = {"data": "[…]"}`), so it
   * is unflattened rather than parsed as plain JSON. Land size is parsed from
   * the text ("3.2 acres", "0.5 ha", "plot of 1,200 sq m"). Verified live
   * 2026-09-07.
   */
  async detail(listing: Listing): Promise<Partial<Listing> | null> {
    const res = await this.fetchImpl(`https://www.rightmove.co.uk/properties/${encodeURIComponent(listing.id)}`, {
      headers: { 'user-agent': UA, accept: 'text/html' },
    })
    if (res.status === 404 || res.status === 410) return null
    if (res.status === 403 || res.status === 429) throw new Error(`rightmove: detail page ${res.status} — backing off`)
    if (!res.ok) return null
    const html = await res.text()
    if (REMOVED_RE.test(html)) return null
    const outer = pageModel(html, 'window.__PAGE_MODEL = ') as { data?: string } | null
    if (!outer?.data) return null
    let model: { propertyData?: DetailPropertyData } | null = null
    try {
      model = unflatten(JSON.parse(outer.data) as unknown[]) as { propertyData?: DetailPropertyData }
    } catch {
      return null
    }
    const p = model?.propertyData
    if (!p) return null
    if (p.status && (p.status.archived || p.status.published === false)) return null
    return detailFields(p)
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.request(url, { accept: '*/*' })
    return res.json()
  }

  private async getText(url: string): Promise<string> {
    const res = await this.request(url, {})
    return res.text()
  }

  private async request(url: string, extra: Record<string, string>, tries = 3): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, ...extra } })
      if (res.ok) return res
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await sleep(2000 * attempt)
        continue
      }
      throw new Error(`rightmove: HTTP ${res.status}`)
    }
  }
}

function locationIdentifier(ring: Ring): string {
  const pts = simplifyToLatLng(ring, MAX_VERTICES, true)
  return 'USERDEFINEDAREA^' + JSON.stringify({ polylines: encodePolyline(pts) })
}

/** Only these four are accepted; anything else 400s. */
const DAYS_SINCE_ADDED = [1, 3, 7, 14]

/** Our portable house subtype → Rightmove's `propertyTypes` value. `land` has no houseSubtype-only meaning elsewhere but Rightmove does carry it. */
const HOUSE_SUBTYPE: Record<string, string> = {
  detached: 'detached',
  'semi-detached': 'semi-detached',
  terraced: 'terraced',
  bungalow: 'bungalow',
  land: 'land',
}
const DEFAULT_HOUSE_SUBTYPES = ['detached', 'semi-detached', 'terraced', 'bungalow']

/** Criteria → Rightmove query params. */
function compile(c: Criteria): Record<string, string> {
  const rent = c.channel === 'rent'
  const p: Record<string, string> = { channel: rent ? 'RENT' : 'BUY' }
  if (c.minPrice != null) p.minPrice = String(c.minPrice)
  if (c.maxPrice != null) p.maxPrice = String(c.maxPrice)
  if (c.minBedrooms != null) p.minBedrooms = String(c.minBedrooms)
  if (c.maxBedrooms != null) p.maxBedrooms = String(c.maxBedrooms)
  if (c.minBathrooms != null) p.minBathrooms = String(c.minBathrooms)
  if (c.propertyType === 'house') {
    // `villa` and `farmhouse` have no Rightmove propertyTypes value — UK stock
    // doesn't carve them out, so those two subtypes are simply unrepresentable
    // here and fall out of the mapped set below.
    const wanted = (c.houseSubtypes?.length ? c.houseSubtypes : DEFAULT_HOUSE_SUBTYPES)
      .map((s) => HOUSE_SUBTYPE[s])
      .filter((v): v is string => !!v)
    p.propertyTypes = wanted.length ? wanted.join(',') : DEFAULT_HOUSE_SUBTYPES.join(',')
  }
  if (c.propertyType === 'flat') p.propertyTypes = 'flat'
  // Deliberately NOT sending minSize/maxSize: only ~49% of Rightmove listings
  // report a floor area, and the server-side filter drops the silent rest.
  // Post-filtering keeps them (see postFilter in sync.ts).
  //
  // Share-of-freehold is functionally freehold for our purposes; leasehold isn't
  // — unless excludeCommonhold asks for sole freehold specifically.
  if (c.freeholdOnly && !rent) {
    p.tenureTypes = c.excludeCommonhold ? 'FREEHOLD' : 'FREEHOLD,SHARE_OF_FREEHOLD'
  }
  const mustHave: string[] = []
  if (c.mustHaveGarden) mustHave.push('garden')
  if (c.mustHaveParking) mustHave.push('parking')
  if (mustHave.length) p.mustHave = mustHave.join(',')
  if (c.excludeSchemes) {
    p.dontShow = rent ? 'houseShare,retirement,student' : 'retirement,sharedOwnership'
    if (!rent) p.includeSSTC = 'false'
  }
  if (c.excludeNewBuild && !rent) {
    p.dontShow = p.dontShow ? `${p.dontShow},newHome` : 'newHome'
  }
  if (c.maxDaysSinceAdded != null && DAYS_SINCE_ADDED.includes(c.maxDaysSinceAdded)) {
    p.maxDaysSinceAdded = String(c.maxDaysSinceAdded)
  }
  return p
}

interface RawListRow {
  id?: unknown
  price?: { amount?: number }
  displayAddress?: string
  bedrooms?: number
  bathrooms?: number
  propertySubType?: string
  displaySize?: string
  location?: { latitude?: number; longitude?: number }
  propertyUrl?: string
  summary?: string
  customer?: { branchDisplayName?: string }
  firstVisibleDate?: string
  propertyImages?: { mainImageSrc?: string }
}

function normalise(p: RawListRow): Listing | null {
  if (p.id == null) return null
  return {
    portal: 'rightmove',
    id: String(p.id),
    url: 'https://www.rightmove.co.uk' + (p.propertyUrl ?? '').split('#')[0],
    address: p.displayAddress,
    price: p.price?.amount,
    currency: 'GBP',
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    floorArea: parseSqFtToM2(p.displaySize),
    propertyType: p.propertySubType,
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    listedAt: p.firstVisibleDate,
    summary: p.summary,
    agent: p.customer?.branchDisplayName,
    image: p.propertyImages?.mainImageSrc,
  }
}

/** "1,234 sq ft" / "115 sq m" → m². */
function parseSqFtToM2(display: string | undefined): number | undefined {
  if (!display) return undefined
  const m = display.match(/([\d,.]+)\s*sq\.?\s*(ft|m)/i)
  if (!m) return undefined
  const n = parseFloat(m[1]!.replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  return m[2]!.toLowerCase() === 'm' ? Math.round(n) : Math.round(n * 0.092903)
}

function parseCount(v: unknown): number {
  return parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0
}

/**
 * `__NEXT_DATA__` is a JS object literal, so brace-match it rather than regex
 * the HTML (nested braces inside strings break any regex approach).
 */
export function pageModel(html: string, marker: string): unknown | null {
  const m = html.indexOf(marker)
  if (m < 0) return null
  const start = html.indexOf('{', m)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]!
    if (esc) {
      esc = false
      continue
    }
    if (c === '\\') {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1))
  }
  return null
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface DetailPropertyData {
  propertySubType?: string
  keyFeatures?: string[]
  text?: { description?: string; propertyPhrase?: string }
  sizings?: Array<{ unit?: string; minimumSize?: number; maximumSize?: number }>
  location?: { latitude?: number; longitude?: number }
  listingHistory?: { listingUpdateReason?: string }
  status?: { published?: boolean; archived?: boolean }
  tenure?: { tenureType?: string }
  address?: { displayAddress?: string; outcode?: string; incode?: string }
  bedrooms?: number
  bathrooms?: number
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€' }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Pick the fields we keep from a detail model. Exported for tests. */
export function detailFields(p: DetailPropertyData): Partial<Listing> {
  const keyFeatures = (p.keyFeatures ?? []).map((k) => decodeEntities(k).trim()).filter(Boolean)
  const description = decodeEntities(p.text?.description?.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '') ?? '').trim() || undefined
  const out: Partial<Listing> = { detailAt: Date.now() }
  if (keyFeatures.length) out.keyFeatures = keyFeatures
  if (description) out.description = description
  if (p.propertySubType) out.propertyType = p.propertySubType
  const tenure = normaliseTenure(p.tenure?.tenureType)
  if (tenure) out.tenure = tenure
  if (p.bedrooms != null) out.bedrooms = p.bedrooms
  if (p.bathrooms != null) out.bathrooms = p.bathrooms
  if (p.address?.displayAddress && p.address.outcode && p.address.incode) out.address = `${p.address.displayAddress}, ${p.address.outcode} ${p.address.incode}`
  const added = p.listingHistory?.listingUpdateReason?.match(/Added on (\d{2})\/(\d{2})\/(\d{4})/)
  if (added) out.listedAt = `${added[3]}-${added[2]}-${added[1]}T00:00:00Z`
  // `sizings` is the FLOOR area restated in sqft/sqm/acres (100 m² shows up as
  // 0.0247 ac — verified live 2026-09-07), so it is useless for land. Prose is
  // the only signal: agents always write the acreage out.
  const plot = plotAreaFromText([...keyFeatures, description ?? ''].join('\n'))
  if (plot != null) out.plotArea = plot
  return out
}

/**
 * SvelteKit `devalue` unflatten: the page model is a flat array where every
 * value is an index into that array (negative = undefined/NaN/±Infinity/-0).
 * Only the shapes Rightmove actually emits are handled (plain objects, arrays,
 * Date/Set/Map/RegExp/null-prototype tags).
 */
export function unflatten(values: unknown[]): unknown {
  const cache = new Map<number, unknown>()
  const hyd = (i: number): unknown => {
    if (i === -1 || i === -6) return undefined
    if (i === -2) return NaN
    if (i === -3) return Infinity
    if (i === -4) return -Infinity
    if (i === -5) return -0
    if (cache.has(i)) return cache.get(i)
    const v = values[i]
    if (v === null || typeof v !== 'object') {
      cache.set(i, v)
      return v
    }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        const t = v[0]
        if (t === 'Date') { const d = new Date(v[1] as string); cache.set(i, d); return d }
        if (t === 'Set') { const set = new Set<unknown>(); cache.set(i, set); for (const x of v.slice(1)) set.add(hyd(x as number)); return set }
        if (t === 'Map') { const map = new Map<unknown, unknown>(); cache.set(i, map); for (let k = 1; k < v.length; k += 2) map.set(hyd(v[k] as number), hyd(v[k + 1] as number)); return map }
        if (t === 'RegExp') { const r = new RegExp(v[1] as string, v[2] as string | undefined); cache.set(i, r); return r }
        if (t === 'null') { const o: Record<string, unknown> = Object.create(null); cache.set(i, o); for (let k = 1; k < v.length; k += 2) o[v[k] as string] = hyd(v[k + 1] as number); return o }
      }
      const arr: unknown[] = []
      cache.set(i, arr)
      for (const x of v) arr.push(hyd(x as number))
      return arr
    }
    const o: Record<string, unknown> = {}
    cache.set(i, o)
    for (const [k, x] of Object.entries(v as Record<string, number>)) o[k] = hyd(x)
    return o
  }
  return hyd(0)
}
