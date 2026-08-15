// ImmoScout24 client (Germany). Protocol notes:
// ~/sync/brain/root/projects/home/immoscout24-api.md
//
// Split personality:
//   POST /Suche/controller/search/resultCountWithModel  — cookie-free, counts
//   POST /Suche/controller/search/change.go             — cookie-free, compiles
//                                                         our query model into
//                                                         the canonical URL
//   GET  /Suche/shape/…                                 — AWS-WAF gated HTML
//                                                         with the listings
// So counts are free, but reading listings needs a WAF token (see waf-token.ts).
// IS24 is the only portal that filters on plot size AND internet speed — both
// directly load-bearing criteria for this search.

import type { Ring } from './geo.js'
import { encodePolyline, simplifyToLatLng } from './geo.js'
import { pageModel } from './rightmove.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'
import type { WafTokenStore } from './waf-token.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const ORIGIN = 'https://www.immobilienscout24.de'
const MAX_VERTICES = 120
const PAGE = 20
const SORT_NEWEST = '2' // "Aktualität (neueste zuerst)"
/** German listings count Zimmer (incl. living rooms), so bedrooms + 1. */
const ROOM_OFFSET = 1

export class ImmoScout24Client implements PortalClient {
  readonly portal = 'immoscout24' as const
  readonly currency = 'EUR'

  constructor(
    private readonly waf: WafTokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const ring of rings) {
      const res = await this.postJson('/Suche/controller/search/resultCountWithModel?ssm=MAP', {
        query: queryModel(ring, criteria),
        nonQueryData: {},
      })
      total += (res as { resultCount?: number }).resultCount ?? 0
    }
    return total
  }

  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    let token = await this.waf.get()
    if (!token) throw new Error('immoscout24: no WAF token available (Playwright missing?)')
    const unsupported: string[] = []
    // IS24 has no auction/scheme flag, no Erbbaurecht (leasehold) filter, and
    // plot size only exists on houses.
    if (criteria.excludeSchemes) unsupported.push('excludeSchemes')
    if (criteria.excludeAuctions) unsupported.push('excludeAuctions')
    if (criteria.excludeNewBuild) unsupported.push('excludeNewBuild')
    if (criteria.freeholdOnly) unsupported.push('freeholdOnly')
    // excludeCommonhold only narrows freeholdOnly, which is itself unsupported here.
    if (criteria.maxDaysSinceAdded != null) unsupported.push('maxDaysSinceAdded')
    if (criteria.minBathrooms != null) unsupported.push('minBathrooms')
    // No verified houseTypes value covers villa/farmhouse/land as a single
    // list entry beyond what's already mapped — see queryModel().
    if (criteria.houseSubtypes?.some((s) => !IS24_HOUSE_TYPE[s])) unsupported.push('houseSubtypes')
    if (criteria.propertyType === 'flat') {
      if (criteria.minPlotArea != null) unsupported.push('minPlotArea')
      if (criteria.maxPlotArea != null) unsupported.push('maxPlotArea')
    }

    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false

    for (const ring of rings) {
      const url = await this.canonicalUrl(ring, criteria)
      for (let page = 1; (page - 1) * PAGE < limit; page++) {
        const sep = url.includes('?') ? '&' : '?'
        // `pagenumber=1` explicitly is a 401 from the WAF — page 1 must omit it.
        const paging = page > 1 ? `&pagenumber=${page}` : ''
        const target = `${ORIGIN}${url}${sep}sorting=${SORT_NEWEST}${paging}`
        let html: string
        try {
          html = await this.getHtml(target, token)
        } catch (e) {
          // A token can 401 well before its stated expiry, so a rejection is the
          // cue to re-mint rather than to give up for the rest of its TTL.
          if (!(e instanceof WafRejected)) throw e
          this.waf.invalidate()
          const next = await this.waf.get()
          if (!next) throw e
          token = next
          html = await this.getHtml(target, token)
        }
        const model = pageModel(html, 'resultListModel:') as RawResultListModel | null
        const rl = model?.searchResponseModel?.['resultlist.resultlist']
        if (!rl) throw new Error('immoscout24: no resultlist in HTML')
        if (page === 1) total += rl.paging?.numberOfHits ?? 0
        const entries = rl.resultlistEntries?.[0]?.resultlistEntry ?? []
        const markers = markerCoords(rl)
        for (const e of entries) {
          const l = normalise(e, markers)
          if (l) seen.set(l.id, l)
        }
        const pages = rl.paging?.numberOfPages ?? 1
        if (entries.length === 0 || page >= pages) break
        if (page >= 50) {
          truncated = true
          break
        }
      }
    }

    return { portal: this.portal, total, listings: [...seen.values()], truncated, unsupported }
  }

  /**
   * Let IS24 compile our query model into its own short-param URL
   * (`price=-400000.0`, `ground=800.0-`, …) rather than reverse-engineering
   * that grammar ourselves.
   */
  private async canonicalUrl(ring: Ring, criteria: Criteria): Promise<string> {
    const res = (await this.postJson(
      '/Suche/controller/search/change.go?otpEnabled=true&ssm=MAP',
      queryModel(ring, criteria),
    )) as { url?: string }
    if (!res.url) throw new Error('immoscout24: change.go returned no url')
    return res.url
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          'content-type': 'application/json',
          // Without this IS24 replies ISO-8859-1 and umlauts break a UTF-8 parse.
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (res.ok) return res.json()
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt))
        continue
      }
      throw new Error(`immoscout24: HTTP ${res.status} on ${path}`)
    }
  }

  private async getHtml(url: string, token: string): Promise<string> {
    const res = await this.fetchImpl(url, {
      headers: { 'user-agent': UA, cookie: `aws-waf-token=${token}`, accept: 'text/html' },
    })
    if (res.status === 401 || res.status === 403) throw new WafRejected(res.status)
    if (!res.ok) throw new Error(`immoscout24: HTTP ${res.status}`)
    return res.text()
  }
}

/** The WAF turned us away — distinct from a genuine HTTP failure. */
class WafRejected extends Error {
  constructor(status: number) {
    super(`immoscout24: WAF rejected the token (HTTP ${status})`)
  }
}

/** Google encoded polyline, precision 5. Closing the ring is optional here. */
function shape(ring: Ring): string {
  return encodePolyline(simplifyToLatLng(ring, MAX_VERTICES, false))
}

/**
 * Criteria → IS24 query model. The full model has ~141 fields; omitted ones
 * default sanely. Unknown fields fail open silently, but a bad value on a known
 * enum hard-400s — so only emit values verified against the live API.
 */
function queryModel(ring: Ring, c: Criteria): Record<string, unknown> {
  const rent = c.channel === 'rent'
  const flat = c.propertyType === 'flat'
  const type = flat ? (rent ? 'APARTMENT_RENT' : 'APARTMENT_BUY') : rent ? 'HOUSE_RENT' : 'HOUSE_BUY'

  const q: Record<string, unknown> = {
    view: 'IS24',
    realEstateType: type,
    realEstateTypes: [type],
    locationSelectionType: 'SHAPE',
    shape: shape(ring),
    shapeSearch: true,
  }
  if (c.minPrice != null || c.maxPrice != null) {
    q.priceRange = { min: c.minPrice ?? null, max: c.maxPrice ?? null }
  }
  if (c.minFloorArea != null || c.maxFloorArea != null) {
    q.livingSpaceRange = { min: c.minFloorArea ?? null, max: c.maxFloorArea ?? null }
  }
  // The real plot-size filter — `onlyWithGarden` is a no-op for houses.
  if (!flat && (c.minPlotArea != null || c.maxPlotArea != null)) {
    q.lotSizeRange = { min: c.minPlotArea ?? null, max: c.maxPlotArea ?? null }
  }
  // Zimmer counts living rooms too, so a 3-bedroom house is a 4-Zimmer-Haus.
  // Without this shift a DE search is a whole room stricter than the UK/IT one.
  if (c.minBedrooms != null || c.maxBedrooms != null) {
    q.numberOfRoomsRange = {
      min: c.minBedrooms != null ? c.minBedrooms + ROOM_OFFSET : null,
      max: c.maxBedrooms != null ? c.maxBedrooms + ROOM_OFFSET : null,
    }
  }
  // No verified query-model field for bathrooms, and unknown fields fail open
  // silently here — so it's post-filtered on the listing's numberOfBathRooms.
  if (c.minYearBuilt != null || c.maxYearBuilt != null) {
    q.yearOfConstructionRange = { min: c.minYearBuilt ?? null, max: c.maxYearBuilt ?? null }
  }
  if (c.minInternetMbit != null) q.minimumInternetSpeed = c.minInternetMbit
  if (c.mustHaveParking) q.onlyWithParking = true
  if (c.noBuyerFee && !rent) q.onlyWithoutCourtage = true
  // Only meaningful for flats — for houses the plot implies it (see api notes).
  if (c.mustHaveGarden && flat) q.onlyWithGarden = true
  if (c.keywords?.length) q.fullTextQuery = c.keywords.join(' ')
  if (!flat) {
    const wanted = (c.houseSubtypes ?? []).map((s) => IS24_HOUSE_TYPE[s]).filter((v): v is string => !!v)
    if (wanted.length) q.houseTypes = wanted
  }
  return q
}

/** Our portable house subtype → IS24's `houseTypes` enum, verified live 2026-08-15. No entry for `land` — IS24 has no realEstateType for bare land. */
const IS24_HOUSE_TYPE: Record<string, string> = {
  detached: 'SINGLE_FAMILY_HOUSE',
  'semi-detached': 'SEMIDETACHED_HOUSE',
  terraced: 'TERRACE_HOUSE',
  bungalow: 'BUNGALOW',
  farmhouse: 'FARMHOUSE',
  villa: 'VILLA',
}

interface RawResultListModel {
  searchResponseModel?: {
    'resultlist.resultlist'?: RawResultList
  }
}

interface RawResultList {
  paging?: { numberOfHits?: number; numberOfPages?: number }
  resultlistEntries?: Array<{ resultlistEntry?: RawEntry[] }>
  mapMarkers?: { results?: RawMarker[] }
}

interface RawMarker {
  realEstateId?: number
  coordinate?: { latitude?: number; longitude?: number }
  /** Several listings at one point collapse into a single marker. */
  groupedListings?: Array<{ realEstateId?: number }>
}

/**
 * Listing id → coordinate, from the map-marker set that ships alongside the
 * result list. This covers every row on the page, including the ~65% whose
 * seller hid the street address (those get the marker's approximate point),
 * so it's a strictly better coord source than `address.wgs84Coordinate`.
 */
function markerCoords(rl: RawResultList): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>()
  for (const m of rl.mapMarkers?.results ?? []) {
    const lat = m.coordinate?.latitude
    const lon = m.coordinate?.longitude
    if (lat == null || lon == null) continue
    const ids = [m.realEstateId, ...(m.groupedListings ?? []).map((g) => g.realEstateId)]
    for (const id of ids) if (id != null) out.set(String(id), [lat, lon])
  }
  return out
}

interface RawEntry {
  '@id'?: unknown
  '@creation'?: string
  'resultlist.realEstate'?: {
    title?: string
    address?: {
      postcode?: string
      city?: string
      quarter?: string
      street?: string
      houseNumber?: string
      // Absent when the seller hides the exact address — then there's no pin.
      wgs84Coordinate?: { latitude?: number; longitude?: number }
    }
    price?: { value?: number }
    livingSpace?: number
    plotArea?: number
    numberOfRooms?: number
    numberOfBathRooms?: number
    '@xsi.type'?: string
    contactDetails?: { company?: string }
    galleryAttachments?: {
      // `url` is a single object, not an array (XML→JSON singleton flattening).
      attachment?: Array<{ urls?: Array<{ url?: { '@href'?: string } }> }>
    }
  }
}

/** IS24 image URLs carry literal `%WIDTH%x%HEIGHT%` placeholders — fill them. */
function imageUrl(href: string | undefined): string | undefined {
  return href?.replace('%WIDTH%x%HEIGHT%', '600x400')
}

function normalise(e: RawEntry, markers: Map<string, [number, number]>): Listing | null {
  const id = e['@id']
  const re = e['resultlist.realEstate']
  if (id == null || !re) return null
  const a = re.address
  const marker = markers.get(String(id))
  const street = [a?.street, a?.houseNumber].filter(Boolean).join(' ') || undefined
  const address = [street, a?.quarter, [a?.postcode, a?.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ') || undefined
  return {
    portal: 'immoscout24',
    id: String(id),
    url: `${ORIGIN}/expose/${id}`,
    title: re.title,
    address,
    // 0 means "Preis auf Anfrage", not free.
    price: re.price?.value || undefined,
    currency: 'EUR',
    // German listings count Zimmer (all rooms), so this runs ~1 above bedrooms.
    bedrooms: re.numberOfRooms,
    bathrooms: re.numberOfBathRooms,
    floorArea: re.livingSpace,
    plotArea: re.plotArea,
    propertyType: re['@xsi.type']?.replace(/^search:/, ''),
    lat: a?.wgs84Coordinate?.latitude ?? marker?.[0],
    lon: a?.wgs84Coordinate?.longitude ?? marker?.[1],
    listedAt: e['@creation'],
    agent: re.contactDetails?.company,
    image: imageUrl(re.galleryAttachments?.attachment?.[0]?.urls?.[0]?.url?.['@href']),
  }
}
