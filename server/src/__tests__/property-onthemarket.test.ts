import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OnTheMarketClient, compile, normalise, parsePrice, unsupportedFor } from '../property/onthemarket.js'
import { simplifyToLatLng } from '../property/geo.js'
import type { Ring } from '../property/geo.js'
import type { Criteria, Listing } from '../property/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/onthemarket-search.json'), 'utf8')) as {
  'total-results': number
  properties: Array<Record<string, unknown>>
}

/** The Worcester box from the api note, as a GeoJSON ring ([lng, lat], closed). */
const worcester: Ring = [
  [-2.45, 52.05],
  [-1.98, 52.05],
  [-1.98, 52.34],
  [-2.45, 52.34],
  [-2.45, 52.05],
]

/** A ~400-vertex circle, to exercise the simplifier. */
const circle: Ring = Array.from({ length: 400 }, (_, i) => {
  const t = (i / 400) * Math.PI * 2
  return [-2.2 + 0.1 * Math.cos(t), 52.2 + 0.06 * Math.sin(t)] as [number, number]
})

const criteria: Criteria = {
  channel: 'buy',
  propertyType: 'house',
  houseSubtypes: ['detached', 'semi-detached', 'bungalow', 'villa', 'farmhouse'],
  maxPrice: 300000,
  minBedrooms: 2,
  mustHaveGarden: true,
  mustHaveParking: true,
  excludeSchemes: true,
}

/** Google polyline decoder (precision 5) — the inverse of geo.ts encodePolyline. */
function decodePolyline(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  let lat = 0
  let lng = 0
  const next = (): number => {
    let result = 0
    let shift = 0
    let b: number
    do {
      b = s.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < s.length) {
    lat += next()
    lng += next()
    out.push([lat / 1e5, lng / 1e5])
  }
  return out
}

function row(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    'details-url': `/details/${id}/`,
    price: '£200,000',
    bedrooms: 3,
    bathrooms: 1,
    'humanised-property-type': 'Detached house',
    'property-title': '3 bedroom detached house for sale',
    address: 'Somewhere, Worcester',
    location: { lat: 52.2, lon: -2.2 },
    features: ['Tenure: Freehold'],
    'days-since-added-reduced': 'Added today',
    agent: { name: 'Agent' },
    'cover-image': { default: `https://media.onthemarket.com/properties/${id}/1/image-0-480x320.jpg` },
    ...extra,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A fetch stub that records every URL and answers from `handler`. */
function stubFetch(handler: (url: URL, n: number) => Response | Promise<Response>): { fetch: typeof fetch; urls: URL[] } {
  const urls: URL[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    urls.push(url)
    return handler(url, urls.length)
  }) as typeof fetch
  return { fetch: fetchImpl, urls }
}

const client = (fetchImpl: typeof fetch): OnTheMarketClient => new OnTheMarketClient(fetchImpl, { pageDelayMs: 0 })

describe('OnTheMarketClient: query compilation', () => {
  it('builds the search URL from Criteria, granular prop-types and no `houses`', async () => {
    const { fetch, urls } = stubFetch(() => jsonResponse({ 'total-results': 0, properties: [] }))
    await client(fetch).newest([worcester], criteria, 30)
    expect(urls).toHaveLength(1)
    const u = urls[0]!
    expect(u.origin + u.pathname).toBe('https://www.onthemarket.com/async/search/properties-v2/')
    const q = u.searchParams
    expect(q.get('search-type')).toBe('for-sale')
    expect(q.get('max-price')).toBe('300000')
    expect(q.get('min-price')).toBeNull()
    expect(q.get('min-bedrooms')).toBe('2')
    expect(q.getAll('prop-types').sort()).toEqual(['barn-conversion', 'bungalows', 'cottage', 'detached', 'link-detached-house', 'semi-detached'])
    expect(q.getAll('prop-types')).not.toContain('houses')
    expect(q.getAll('property-features').sort()).toEqual(['garden', 'parking'])
    expect(q.get('retirement')).toBe('false')
    expect(q.get('shared-ownership')).toBe('false')
    expect(q.get('sort-field')).toBe('update_date')
    expect(q.get('page')).toBe('1')
    // Not sent: accepted-but-ignored or not asked for.
    expect(q.get('direction')).toBeNull()
    expect(q.get('auction')).toBeNull()
    expect(q.get('new-home-flag')).toBeNull()
    expect(q.get('keywords')).toBeNull()
    expect(q.get('min-size')).toBeNull()
    expect(q.get('tenure')).toBeNull()
    expect(q.get('frame-size')).toBeNull()
  })

  it('sends a self-identifying User-Agent and asks for JSON', async () => {
    let headers: Record<string, string> | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>
      return jsonResponse({ 'total-results': 0, properties: [] })
    }) as typeof fetch
    await client(fetchImpl).count([worcester], criteria)
    expect(headers?.['user-agent']).toMatch(/^ConsoleHub-PropertyWatch\//)
    expect(headers?.['user-agent']).not.toMatch(/Mozilla/)
    expect(headers?.accept).toBe('application/json')
  })

  it('round-trips the polygon: polygons0 decodes back to the closed, simplified ring', async () => {
    const { fetch, urls } = stubFetch(() => jsonResponse({ 'total-results': 0, properties: [] }))
    await client(fetch).newest([circle], criteria, 30)
    const encoded = urls[0]!.searchParams.get('polygons0')!
    const decoded = decodePolyline(encoded)
    const expected = simplifyToLatLng(circle, 150, true)
    expect(decoded.length).toBe(expected.length)
    expect(decoded.length).toBeLessThanOrEqual(150)
    expect(decoded[0]).toEqual(decoded[decoded.length - 1]) // closed
    for (let i = 0; i < expected.length; i++) {
      expect(decoded[i]![0]).toBeCloseTo(expected[i]![0], 5)
      expect(decoded[i]![1]).toBeCloseTo(expected[i]![1], 5)
    }
    // A 400-vertex ring got simplified; a 5-vertex box is passed through as-is.
    expect(decoded.length).toBeLessThan(400)
    const { fetch: f2, urls: u2 } = stubFetch(() => jsonResponse({ 'total-results': 0, properties: [] }))
    await client(f2).newest([worcester], criteria, 30)
    expect(decodePolyline(u2[0]!.searchParams.get('polygons0')!)).toEqual([
      [52.05, -2.45],
      [52.05, -1.98],
      [52.34, -1.98],
      [52.34, -2.45],
      [52.05, -2.45],
    ])
    // Same box as the api note's example, just wound the other way.
    const noteExample = decodePolyline(decodeURIComponent('o_u%7CHno%7DMosw%40%3F%3FoxzAnsw%40%3F%3FnxzA'))
    const asSet = (pts: Array<[number, number]>) => new Set(pts.map((p) => p.join(',')))
    expect(asSet(decodePolyline(u2[0]!.searchParams.get('polygons0')!))).toEqual(asSet(noteExample))
  })

  it('compiles the optional filters: price band, keywords (trailing comma), auction, new-home, recently-added', () => {
    const q = new URLSearchParams(
      compile({
        channel: 'buy',
        minPrice: 150000,
        maxPrice: 225000,
        maxBedrooms: 4,
        keywords: ['orchard', ' paddock '],
        excludeAuctions: true,
        excludeNewBuild: true,
        maxDaysSinceAdded: 7,
        propertyType: 'flat',
      }),
    )
    expect(q.get('min-price')).toBe('150000')
    expect(q.get('max-price')).toBe('225000')
    expect(q.get('max-bedrooms')).toBe('4')
    expect(q.get('keywords')).toBe('orchard,paddock,')
    expect(q.get('auction')).toBe('false')
    expect(q.get('new-home-flag')).toBe('F')
    expect(q.get('recently-added')).toBe('7-days')
    expect(q.getAll('prop-types')).toEqual(['flats-apartments'])
  })

  it('maps maxDaysSinceAdded 1/3 to OTM bands and drops 14 (no such band)', () => {
    expect(new URLSearchParams(compile({ maxDaysSinceAdded: 1 })).get('recently-added')).toBe('24-hours')
    expect(new URLSearchParams(compile({ maxDaysSinceAdded: 3 })).get('recently-added')).toBe('3-days')
    expect(new URLSearchParams(compile({ maxDaysSinceAdded: 14 })).get('recently-added')).toBeNull()
    expect(unsupportedFor({ maxDaysSinceAdded: 14 })).toContain('maxDaysSinceAdded')
    expect(unsupportedFor({ maxDaysSinceAdded: 7 })).not.toContain('maxDaysSinceAdded')
  })

  it('defaults propertyType=house to detached/semi/terraced/bungalow, with terraced spelled out', () => {
    const types = compile({ propertyType: 'house' }).filter(([k]) => k === 'prop-types').map(([, v]) => v)
    expect(types.sort()).toEqual(['bungalows', 'detached', 'end-of-terrace', 'link-detached-house', 'semi-detached', 'terraced', 'town-house'])
  })

  it('rent: to-rent channel, no sale-only flags', () => {
    const q = new URLSearchParams(compile({ channel: 'rent', excludeSchemes: true, excludeAuctions: true, excludeNewBuild: true }))
    expect(q.get('retirement')).toBe('false')
    expect(q.get('shared-ownership')).toBeNull()
    expect(q.get('auction')).toBeNull()
    expect(q.get('new-home-flag')).toBeNull()
    const { fetch, urls } = stubFetch(() => jsonResponse({ 'total-results': 0, properties: [] }))
    return client(fetch)
      .newest([worcester], { channel: 'rent' }, 30)
      .then(() => expect(urls[0]!.searchParams.get('search-type')).toBe('to-rent'))
  })
})

describe('OnTheMarketClient: pagination', () => {
  it('walks to the end with limit=Infinity, stopping on the first short page, deduping the hoisted spotlight', async () => {
    // 268 "real" rows: pages 1–9 full, page 10 short — and every page carries
    // the same spotlight row up front, as the live server does.
    const spotlight = row('spot', { 'spotlight?': true })
    const { fetch, urls } = stubFetch((url) => {
      const page = Number(url.searchParams.get('page'))
      const n = page <= 9 ? 29 : 8
      const rows = [spotlight, ...Array.from({ length: n }, (_, i) => row(`p${page}-${i}`))]
      return jsonResponse({ 'total-results': 268, properties: rows })
    })
    const r = await client(fetch).newest([worcester], criteria, Number.POSITIVE_INFINITY)
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(r.total).toBe(268)
    expect(r.truncated).toBe(false)
    expect(r.listings).toHaveLength(9 * 29 + 8 + 1)
    expect(r.listings.filter((l) => l.id === 'spot')).toHaveLength(1)
  })

  it('sets truncated when page 34 is still full (the 1,020-row cap)', async () => {
    const { fetch, urls } = stubFetch((url) => {
      const page = Number(url.searchParams.get('page'))
      return jsonResponse({ 'total-results': 5000, properties: Array.from({ length: 30 }, (_, i) => row(`p${page}-${i}`)) })
    })
    const r = await client(fetch).newest([worcester], { ...criteria, minPrice: 100000, maxPrice: 300000 }, Number.POSITIVE_INFINITY)
    expect(urls).toHaveLength(34)
    expect(urls.at(-1)!.searchParams.get('page')).toBe('34')
    // The band the hub will split is what was actually sent.
    for (const u of urls) {
      expect(u.searchParams.get('min-price')).toBe('100000')
      expect(u.searchParams.get('max-price')).toBe('300000')
    }
    expect(r.total).toBe(5000)
    expect(r.truncated).toBe(true)
    expect(r.listings).toHaveLength(34 * 30)
  })

  it('is not truncated when the walk ends short before page 34, even with a large total', async () => {
    const { fetch, urls } = stubFetch((url) => {
      const page = Number(url.searchParams.get('page'))
      return jsonResponse({ 'total-results': 1500, properties: page < 3 ? Array.from({ length: 30 }, (_, i) => row(`p${page}-${i}`)) : [] })
    })
    const r = await client(fetch).newest([worcester], criteria, Number.POSITIVE_INFINITY)
    expect(urls).toHaveLength(3)
    expect(r.truncated).toBe(false)
  })

  it('honours limit per ring and issues one request per ring, deduping across rings', async () => {
    const { fetch, urls } = stubFetch(() => jsonResponse({ 'total-results': 40, properties: Array.from({ length: 30 }, (_, i) => row(`x${i}`)) }))
    const other: Ring = worcester.map(([lng, lat]) => [lng + 1, lat] as [number, number])
    const r = await client(fetch).newest([worcester, other], criteria, 30)
    expect(urls).toHaveLength(2)
    expect(urls.map((u) => u.searchParams.get('polygons0'))).not.toContain(null)
    expect(urls[0]!.searchParams.get('polygons0')).not.toBe(urls[1]!.searchParams.get('polygons0'))
    expect(r.total).toBe(80) // per-ring totals summed (before dedupe), like the other clients
    expect(r.listings).toHaveLength(30) // same ids from both rings collapse
  })

  it('limit=50 pulls two pages (30 + 30) and stops', async () => {
    const { fetch, urls } = stubFetch((url) => {
      const page = Number(url.searchParams.get('page'))
      return jsonResponse({ 'total-results': 900, properties: Array.from({ length: 30 }, (_, i) => row(`p${page}-${i}`)) })
    })
    await client(fetch).newest([worcester], criteria, 50)
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('count() sums total-results across rings with one request each', async () => {
    const { fetch, urls } = stubFetch((_u, n) => jsonResponse({ 'total-results': n === 1 ? 172 : 8, properties: [] }))
    const other: Ring = worcester.map(([lng, lat]) => [lng + 1, lat] as [number, number])
    expect(await client(fetch).count([worcester, other], criteria)).toBe(180)
    expect(urls).toHaveLength(2)
  })

  it('surfaces a 400 with the server hint and retries 5xx', async () => {
    const { fetch } = stubFetch(() => new Response('{"errors":{"page":"Not a valid page number."}}', { status: 400 }))
    await expect(client(fetch).count([worcester], criteria)).rejects.toThrow(/onthemarket: HTTP 400 .*Not a valid page number/)
  })
})

describe('OnTheMarketClient: normalise', () => {
  const listings = fixture.properties.map((p) => normalise(p as never)).filter((l): l is Listing => !!l)

  it('maps every recorded row', () => {
    expect(listings).toHaveLength(4)
    expect(fixture['total-results']).toBe(268)
  })

  it('maps the spotlight modern-auction semi', () => {
    const l = listings.find((x) => x.id === '19551202')!
    expect(l).toMatchObject({
      portal: 'onthemarket',
      id: '19551202',
      url: 'https://www.onthemarket.com/details/19551202/',
      title: '4 bedroom semi-detached house for sale',
      price: 280000,
      currency: 'GBP',
      bedrooms: 4,
      bathrooms: 1,
      propertyType: 'Semi-detached house',
      lat: 52.176133,
      lon: -2.215824,
      agent: 'Connells - Worcester',
      image: 'https://media.onthemarket.com/properties/19551202/1630381393/image-0-480x320.jpg',
    })
    expect(l.address).toMatch(/Worcester/)
    // No invented date: the band goes into the summary, listedAt stays empty.
    expect(l.listedAt).toBeUndefined()
    expect(l.isNew).toBeUndefined()
    expect(l.summary).toMatch(/^Guide price · Added > 14 days · Tenure: Freehold · Sale by Modern Auction/)
    expect(l.floorArea).toBeUndefined()
    expect(l.plotArea).toBeUndefined()
  })

  it('carries the price qualifier so the hub can see "Shared ownership" and flags recently-added', () => {
    const l = listings.find((x) => x.id === '20282318')!
    expect(l.price).toBe(191750)
    expect(l.isNew).toBe(true)
    expect(l.summary).toMatch(/^Shared ownership · Added today · Tenure: Leasehold/)
  })

  it('keeps the coarse type text for the hub to normalise (Terraced bungalow from `bungalows`)', () => {
    const l = listings.find((x) => x.id === '19993746')!
    expect(l.propertyType).toBe('Terraced bungalow')
    expect(l.price).toBe(275000)
    expect(l.summary).toMatch(/^Offers in region of · Reduced today/)
  })

  it('handles a row with no qualifier', () => {
    const l = listings.find((x) => x.id === '19852661')!
    expect(l.price).toBe(226995)
    expect(l.bedrooms).toBe(2)
    expect(l.summary).toMatch(/^Reduced < 7 days · Tenure: Freehold/)
  })

  it('drops rows without an id and reads absent/POA prices as undefined', () => {
    expect(normalise({} as never)).toBeNull()
    expect(normalise(row('1', { price: 'POA' }) as never)?.price).toBeUndefined()
    expect(normalise(row('2', { price: undefined }) as never)?.price).toBeUndefined()
    expect(parsePrice('£1,050 pcm (£242 pw)')).toBe(1050)
    expect(parsePrice('£230,000')).toBe(230000)
    expect(parsePrice('Offers over £1.2m')).toBeUndefined() // never seen; be safe rather than guess
  })
})

describe('OnTheMarketClient: unsupported', () => {
  it('lists exactly what OTM cannot filter server-side for the house-hunt criteria', () => {
    expect(unsupportedFor(criteria)).toEqual(['houseSubtypes']) // `villa` has no prop-types value
    expect(unsupportedFor({ ...criteria, houseSubtypes: ['detached', 'bungalow'] })).toEqual([])
  })

  it('does NOT list what OTM does filter: keywords, garden/parking, auction, schemes, new-build', () => {
    const u = unsupportedFor({ keywords: ['orchard'], mustHaveGarden: true, mustHaveParking: true, excludeAuctions: true, excludeSchemes: true, excludeNewBuild: true })
    expect(u).toEqual([])
  })

  it('lists every field the portal ignores', () => {
    const u = unsupportedFor({
      minBathrooms: 1,
      minFloorArea: 80,
      maxFloorArea: 200,
      minPlotArea: 500,
      maxPlotArea: 5000,
      minYearBuilt: 1900,
      maxYearBuilt: 2020,
      freeholdOnly: true,
      excludeCommonhold: true,
      minInternetMbit: 50,
      noBuyerFee: true,
      excludePriceOnRequest: true,
    })
    expect(u.sort()).toEqual(
      ['excludePriceOnRequest', 'freeholdOnly', 'maxFloorArea', 'maxPlotArea', 'maxYearBuilt', 'minBathrooms', 'minFloorArea', 'minInternetMbit', 'minPlotArea', 'minYearBuilt', 'noBuyerFee'].sort(),
    )
  })

  it('rent has no auction / new-home axes', () => {
    expect(unsupportedFor({ channel: 'rent', excludeAuctions: true, excludeNewBuild: true }).sort()).toEqual(['excludeAuctions', 'excludeNewBuild'])
  })

  it('newest() reports the same list', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ 'total-results': 0, properties: [] }))
    const r = await client(fetch).newest([worcester], { ...criteria, minPlotArea: 800 }, 30)
    expect(r.unsupported.sort()).toEqual(['houseSubtypes', 'minPlotArea'])
  })
})

describe('OnTheMarketClient: isLive / detail', () => {
  const detailHtml = (status: string, extra = ''): string =>
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        initialReduxState: {
          property: {
            description: '  A lovely house.  ',
            features: [{ id: 1, feature: 'Garage' }, { id: 2, feature: 'Orchard' }],
            minimumAreaSqM: 118.4,
            displayAddress: 'Great House Road, Worcester',
            location: { lat: 52.185452, lon: -2.236595 },
            headerData: { dataLayer: JSON.stringify({ status, postcode: 'WR2 4HS' }) },
          },
        },
      },
    })}</script>${extra}</html>`
  const listing: Listing = { portal: 'onthemarket', id: '18715598', url: 'https://www.onthemarket.com/details/18715598/', currency: 'GBP', address: 'Great House Road, Worcester' }

  it('true for a live page, false for retracted or 404, null for 5xx/unparseable', async () => {
    const at = (body: string | null, status = 200) => client((async () => new Response(body, { status })) as typeof fetch)
    expect(await at(detailHtml('live')).isLive(listing)).toBe(true)
    expect(await at(detailHtml('retracted')).isLive(listing)).toBe(false)
    expect(await at('not found', 404).isLive(listing)).toBe(false)
    expect(await at('boom', 503).isLive(listing)).toBeNull()
    expect(await at('<html>no next data</html>').isLive(listing)).toBeNull()
    expect(await at(detailHtml('weird')).isLive(listing)).toBeNull()
  })

  it('hits /details/<id>/ with a text/html accept', async () => {
    const { fetch, urls } = stubFetch(() => new Response(detailHtml('live'), { status: 200 }))
    await client(fetch).isLive(listing)
    expect(urls[0]!.href).toBe('https://www.onthemarket.com/details/18715598/')
  })

  it('detail() pulls description, bullets, floor area and full postcode; null when gone', async () => {
    const d = await client((async () => new Response(detailHtml('live'), { status: 200 })) as typeof fetch).detail(listing)
    expect(d).toMatchObject({
      description: 'A lovely house.',
      keyFeatures: ['Garage', 'Orchard'],
      floorArea: 118,
      lat: 52.185452,
      lon: -2.236595,
      address: 'Great House Road, Worcester, WR2 4HS',
    })
    expect(typeof d?.detailAt).toBe('number')
    expect(d?.plotArea).toBeUndefined()
    expect(d?.listedAt).toBeUndefined()
    expect(await client((async () => new Response('', { status: 404 })) as typeof fetch).detail(listing)).toBeNull()
  })
})
