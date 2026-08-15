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

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const MAP_ENDPOINT = 'https://www.rightmove.co.uk/api/property-search/map/search'
const MAX_VERTICES = 90 // the server simplifies to ~85 anyway
const LIST_PAGE = 24 // fixed server-side; numberOfPropertiesPerPage is ignored on the HTML view
const INDEX_MAX = 1000 // index > 1000 is a 400
const SORT_NEWEST = '6'

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
      }
    }

    // `keywords` is a SORT on Rightmove, not a filter, so we never send it —
    // the caller post-filters on summary text instead.
    const unsupported: string[] = []
    if (criteria.keywords?.length) unsupported.push('keywords')
    if (criteria.minPlotArea != null) unsupported.push('minPlotArea')
    if (criteria.minInternetMbit != null) unsupported.push('minInternetMbit')
    if (criteria.minFloorArea != null) unsupported.push('minFloorArea')

    return {
      portal: this.portal,
      total,
      listings: [...seen.values()],
      truncated,
      unsupported,
    }
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

/** Criteria → Rightmove query params. */
function compile(c: Criteria): Record<string, string> {
  const p: Record<string, string> = { channel: c.channel === 'rent' ? 'RENT' : 'BUY' }
  if (c.minPrice != null) p.minPrice = String(c.minPrice)
  if (c.maxPrice != null) p.maxPrice = String(c.maxPrice)
  if (c.minBedrooms != null) p.minBedrooms = String(c.minBedrooms)
  if (c.maxBedrooms != null) p.maxBedrooms = String(c.maxBedrooms)
  if (c.propertyType === 'house') p.propertyTypes = 'detached,semi-detached,terraced,bungalow'
  if (c.propertyType === 'flat') p.propertyTypes = 'flat'
  if (c.excludeAuctions) p.dontShow = 'retirement,sharedOwnership'
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
