// immobiliare.it client (Italy). Protocol notes:
// ~/sync/brain/root/projects/home/immobiliare-api.md
//
// The friendliest of the three: no auth, no cookies, clean JSON, an arbitrary
// polygon via `vrt`, a ~15-byte count endpoint, and a self-reported
// `isResultsLimitReached` so we never have to guess at truncation.

import type { Ring } from './geo.js'
import { simplifyToLatLng } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const BASE = 'https://www.immobiliare.it/api-next'
// Counts converge by ~100 vertices; 400 vertices is an HTTP 414.
const MAX_VERTICES = 120
const PAGE = 25
// immobiliare 422s `vrt` with fewer than 4 points ("This collection should
// contain 4 elements or more"). A ring with a duplicated closing vertex can
// simplify down to a 3-point sliver (~15m triangle seen in the wild, almost
// certainly a union artifact) — not worth a real search anyway, so skip it
// rather than let one degenerate ring kill every ring after it in the loop.
const MIN_VERTICES = 4

/** True for a ring immobiliare will 422 rather than search. */
export function isTooSmall(ring: Ring): boolean {
  return simplifyToLatLng(ring, MAX_VERTICES, false).length < MIN_VERTICES
}

export class ImmobiliareClient implements PortalClient {
  readonly portal = 'immobiliare' as const
  readonly currency = 'EUR'

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const ring of rings) {
      if (isTooSmall(ring)) continue
      const d = (await this.get('/listing/count/', ring, criteria)) as { count?: number }
      total += d.count ?? 0
    }
    return total
  }

  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false

    for (const ring of rings) {
      if (isTooSmall(ring)) continue
      for (let page = 1; (page - 1) * PAGE < limit; page++) {
        const d = (await this.get('/search-list/listings/', ring, criteria, {
          criterio: 'data',
          ordine: 'desc',
          pag: String(page),
        })) as RawSearchResponse
        total += page === 1 ? d.count ?? 0 : 0
        if (d.isResultsLimitReached) truncated = true
        const rows = d.results ?? []
        for (const r of rows) {
          const l = normalise(r)
          if (l) seen.set(l.id, l)
        }
        if (rows.length === 0 || page >= (d.maxPages ?? 1)) break
      }
    }

    const unsupported: string[] = []
    if (criteria.minPlotArea != null) unsupported.push('minPlotArea')
    if (criteria.maxPlotArea != null) unsupported.push('maxPlotArea')
    if (criteria.minInternetMbit != null) unsupported.push('minInternetMbit')
    if (criteria.minYearBuilt != null) unsupported.push('minYearBuilt')
    if (criteria.maxYearBuilt != null) unsupported.push('maxYearBuilt')
    if (criteria.excludeNewBuild) unsupported.push('excludeNewBuild')
    if (criteria.noBuyerFee) unsupported.push('noBuyerFee')
    if (criteria.maxDaysSinceAdded != null) unsupported.push('maxDaysSinceAdded')
    // noAste covers auctions only — no separate retirement/shared-ownership flag.
    if (criteria.excludeSchemes) unsupported.push('excludeSchemes')
    // excludeCommonhold only narrows freeholdOnly's UK tenure list; no IT equivalent.
    if (criteria.excludeCommonhold) unsupported.push('excludeCommonhold')
    // No bungalow-equivalent typology id and no land/plot category (see api notes).
    if (criteria.houseSubtypes?.some((s) => !IT_TIPOLOGIA[s])) unsupported.push('houseSubtypes')

    return { portal: this.portal, total, listings: [...seen.values()], truncated, unsupported }
  }

  private async get(
    endpoint: string,
    ring: Ring,
    criteria: Criteria,
    extra: Record<string, string> = {},
  ): Promise<unknown> {
    const q = new URLSearchParams({
      ...compile(criteria),
      ...extra,
      // Mandatory — without it every search endpoint 500s. Value is cosmetic.
      path: '/search-list/',
      __lang: 'en',
    })
    q.set('vrt', vrt(ring))
    const url = `${BASE}${endpoint}?${q}`
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
      if (res.ok) return res.json()
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt))
        continue
      }
      throw new Error(`immobiliare: HTTP ${res.status}`)
    }
  }
}

/** Plain "lat,lng;lat,lng;…". The ring auto-closes server-side. */
function vrt(ring: Ring): string {
  return simplifyToLatLng(ring, MAX_VERTICES, false)
    .map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`)
    .join(';')
}

/**
 * Criteria → immobiliare params. Unknown params fail OPEN here (a typo returns
 * the unfiltered baseline), so only emit names verified against the live API.
 */
function compile(c: Criteria): Record<string, string> {
  const p: Record<string, string> = {
    idContratto: c.channel === 'rent' ? '2' : '1',
    idCategoria: '1',
  }
  if (c.minPrice != null) p.prezzoMinimo = String(c.minPrice)
  if (c.maxPrice != null) p.prezzoMassimo = String(c.maxPrice)
  if (c.minBedrooms != null) p.camereDaLettoMinimo = String(c.minBedrooms)
  if (c.maxBedrooms != null) p.camereDaLettoMassimo = String(c.maxBedrooms)
  if (c.minBathrooms != null) p.bagni = String(c.minBathrooms)
  if (c.minFloorArea != null) p.superficieMinima = String(c.minFloorArea)
  if (c.maxFloorArea != null) p.superficieMassima = String(c.maxFloorArea)
  // Full ownership — excludes nuda proprietà (bare ownership, seller keeps
  // lifetime use) and multiproprietà, both of which look like bargains and aren't.
  if (c.freeholdOnly) p.tipoProprieta = '1'
  // 10 = private garden (20 shared, 30 either) — shared doesn't meet the brief.
  if (c.mustHaveGarden) p['giardino[0]'] = '10'
  if (c.mustHaveParking) p['boxAuto[0]'] = '1'
  // noAste is the AUCTION flag specifically — immobiliare has no separate
  // retirement/shared-ownership scheme flag, so excludeSchemes stays unsupported
  // (and post-filtered) here while excludeAuctions maps straight onto this.
  if (c.excludeAuctions) p.noAste = '1'
  if (c.propertyType === 'house') {
    const defaults = ['detached', 'semi-detached', 'terraced', 'villa', 'farmhouse']
    const mapped = (c.houseSubtypes?.length ? c.houseSubtypes : defaults).map((s) => IT_TIPOLOGIA[s]).filter((v): v is string => !!v)
    // If every requested subtype is unmapped (e.g. bungalow-only), sending no
    // idTipologia at all would silently widen the query to ALL residential
    // types (flats included) rather than just falling back to house — worse
    // than doing nothing. Fall back to the default house set instead.
    const wanted = mapped.length ? mapped : defaults.map((s) => IT_TIPOLOGIA[s]!)
    wanted.forEach((id, i) => {
      p[`idTipologia[${i}]`] = id
    })
  }
  // Singular `keyword[N]` — `keywords=` is silently ignored. A real filter here,
  // unlike Rightmove: nonsense terms return 0 rather than the baseline.
  c.keywords?.forEach((k, i) => {
    p[`keyword[${i}]`] = k
  })
  return p
}

/**
 * Our portable house subtype → immobiliare's `idTipologia` id, verified live
 * 2026-08-15 by reading each id's actual `typology.name` on a results page (an
 * earlier version of this mapping had 12 and 13 swapped). No id found for
 * bungalow or land/plot — Italian stock doesn't carve those out separately.
 */
const IT_TIPOLOGIA: Record<string, string> = {
  detached: '7',
  'semi-detached': '13',
  terraced: '13',
  villa: '12',
  farmhouse: '11',
}

interface RawSearchResponse {
  count?: number
  maxPages?: number
  isResultsLimitReached?: boolean
  results?: RawResult[]
}

interface RawResult {
  realEstate?: {
    id?: unknown
    title?: string
    isNew?: boolean
    price?: { value?: number }
    properties?: Array<{
      surface?: string
      rooms?: string
      bedRoomsNumber?: string
      bathrooms?: string
      typology?: { name?: string }
      description?: string
      ga4features?: string[]
      location?: { latitude?: number; longitude?: number; address?: string; city?: string }
      photo?: { urls?: { small?: string } }
    }>
  }
  seo?: { url?: string }
}

function normalise(r: RawResult): Listing | null {
  const re = r.realEstate
  if (!re?.id) return null
  const prop = re.properties?.[0]
  const loc = prop?.location
  const address = [loc?.address, loc?.city].filter(Boolean).join(', ') || undefined
  return {
    portal: 'immobiliare',
    id: String(re.id),
    url: r.seo?.url ?? `https://www.immobiliare.it/annunci/${re.id}/`,
    title: re.title,
    address,
    price: re.price?.value,
    currency: 'EUR',
    bedrooms: parseNum(prop?.bedRoomsNumber),
    bathrooms: parseNum(prop?.bathrooms),
    floorArea: parseNum(prop?.surface),
    propertyType: prop?.typology?.name,
    lat: loc?.latitude,
    lon: loc?.longitude,
    isNew: re.isNew,
    summary: prop?.description?.slice(0, 400),
    image: prop?.photo?.urls?.small,
  }
}

function parseNum(v: string | undefined): number | undefined {
  if (!v) return undefined
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10)
  return Number.isFinite(n) ? n : undefined
}
