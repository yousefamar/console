import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SparkasseClient, compile, unsupported, normalise, parseGermanNumber } from '../property/sparkasse.js'
import type { Ring } from '../property/geo.js'
import type { Criteria, Listing } from '../property/types.js'

// Trimmed real page (Marburg, 30 km, houses ≤ €300k, ≥3 Zimmer, 2026-09-07):
// five rows picked to cover every numeric trap in the api note.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sparkasse-search.json', import.meta.url), 'utf8')) as {
  estates: unknown[]
  totalItems: number
}

const criteria: Criteria = {
  channel: 'buy',
  propertyType: 'house',
  houseSubtypes: ['detached', 'semi-detached', 'bungalow', 'villa', 'farmhouse'],
  maxPrice: 300000,
  minBedrooms: 2,
  minPlotArea: 800,
}

/** ~20 km square around Marburg — fits one 100 km circle. */
const smallRing: Ring = [
  [8.6, 50.7],
  [8.9, 50.7],
  [8.9, 50.9],
  [8.6, 50.9],
  [8.6, 50.7],
]
/** ~450 × 450 km — needs several circles. */
const bigRing: Ring = [
  [6.5, 48.5],
  [12.5, 48.5],
  [12.5, 52.5],
  [6.5, 52.5],
  [6.5, 48.5],
]

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const row = (id: string): unknown => ({ id, estateSubTypeId: 59, offererCategory: 32, title: id, lat: 50.8, lng: 8.7, mainFacts: [], priceData: { value: '1 €', numeric: 1 } })

/** Stub fetch that records every URL and answers from `handler`. */
function stubFetch(handler: (url: URL) => Response): { fetch: typeof fetch; urls: URL[] } {
  const urls: URL[] = []
  const stub = ((input: string | URL | Request) => {
    const url = new URL(String(input))
    urls.push(url)
    return Promise.resolve(handler(url))
  }) as unknown as typeof fetch
  return { fetch: stub, urls }
}

const client = (handler: (url: URL) => Response) => {
  const s = stubFetch(handler)
  return { client: new SparkasseClient(s.fetch, 0), urls: s.urls }
}

describe('sparkasse compile', () => {
  it('maps criteria onto the verified params, Zimmer-shifted, no plot param', () => {
    const p = compile(criteria)
    expect(p).toEqual({
      estateTypeGroupingIds: '396',
      offerType: '2',
      maxPrice: '300000',
      minRooms: '3',
      estateSubTypeIds: '59,58,61,62,63,64,65',
    })
    expect(p).not.toHaveProperty('minPropertySpace')
  })

  it('flat → Wohnung grouping without subtypes; any → both groupings; omitted subtypes → whole Haus grouping', () => {
    expect(compile({ propertyType: 'flat', houseSubtypes: ['detached'] })).toEqual({ estateTypeGroupingIds: '403', offerType: '2' })
    expect(compile({ propertyType: 'any' }).estateTypeGroupingIds).toBe('396,403')
    expect(compile({ propertyType: 'house' })).toEqual({ estateTypeGroupingIds: '396', offerType: '2' })
  })

  it('all-unmapped subtypes (land) send no subtype param rather than widening to everything', () => {
    expect(compile({ propertyType: 'house', houseSubtypes: ['land'] })).not.toHaveProperty('estateSubTypeIds')
    expect(compile({ propertyType: 'house', houseSubtypes: ['land', 'terraced'] }).estateSubTypeIds).toBe('54,55,56,57')
  })

  it('floor area and price bounds pass straight through', () => {
    expect(compile({ minPrice: 100000, maxPrice: 200000, minFloorArea: 120, maxFloorArea: 250, maxBedrooms: 4 })).toMatchObject({
      minPrice: '100000',
      maxPrice: '200000',
      minSpace: '120',
      maxSpace: '250',
      maxRooms: '5',
    })
  })

  it('refuses rent — the portal has no rent grouping and ignores marketingType', () => {
    expect(() => compile({ channel: 'rent' })).toThrow(/rent/)
  })
})

describe('sparkasse unsupported', () => {
  it('lists plot size and every flag the portal cannot express; nothing for the plain house search', () => {
    expect(unsupported(criteria)).toEqual(['minPlotArea'])
    expect(unsupported({ propertyType: 'house', houseSubtypes: ['detached'], maxPrice: 1, minBedrooms: 1, minFloorArea: 1 })).toEqual([])
  })

  it('flags land as an unmapped subtype, but not on flat searches where subtypes are moot', () => {
    expect(unsupported({ propertyType: 'house', houseSubtypes: ['land'] })).toEqual(['houseSubtypes'])
    expect(unsupported({ propertyType: 'flat', houseSubtypes: ['land'] })).toEqual([])
  })

  it('covers the whole long tail', () => {
    expect(
      unsupported({
        minBathrooms: 1,
        maxPlotArea: 1,
        minYearBuilt: 1,
        maxYearBuilt: 1,
        freeholdOnly: true,
        excludeCommonhold: true,
        mustHaveGarden: true,
        mustHaveParking: true,
        keywords: ['x'],
        minInternetMbit: 1,
        excludeSchemes: true,
        excludeAuctions: true,
        excludeNewBuild: true,
        noBuyerFee: true,
        maxDaysSinceAdded: 1,
        excludePriceOnRequest: true,
      }),
    ).toEqual([
      'minBathrooms',
      'maxPlotArea',
      'minYearBuilt',
      'maxYearBuilt',
      'freeholdOnly',
      'excludeCommonhold',
      'mustHaveGarden',
      'mustHaveParking',
      'keywords',
      'minInternetMbit',
      'excludeSchemes',
      'excludeAuctions',
      'excludeNewBuild',
      'noBuyerFee',
      'maxDaysSinceAdded',
      'excludePriceOnRequest',
    ])
  })
})

describe('parseGermanNumber', () => {
  it('reads the display string, not the separator-stripped numeric', () => {
    expect(parseGermanNumber('163,11 m²', 16311)).toBe(163.11)
    expect(parseGermanNumber('174,3 m²', 1743)).toBe(174.3)
    expect(parseGermanNumber('285.065,45 €', 28506545)).toBe(285065.45)
    expect(parseGermanNumber('1.098 m²', 1098)).toBe(1098)
    expect(parseGermanNumber('9.900 €', 9900)).toBe(9900)
    expect(parseGermanNumber('3.5', 35)).toBe(3.5)
    expect(parseGermanNumber('70 m²', 70)).toBe(70)
  })

  it('falls back to numeric only when there is no string; null → undefined', () => {
    expect(parseGermanNumber(null, 861)).toBe(861)
    expect(parseGermanNumber(undefined, undefined)).toBeUndefined()
    expect(parseGermanNumber(null, null)).toBeUndefined()
    expect(parseGermanNumber('m²', null)).toBeUndefined()
  })
})

describe('sparkasse normalise', () => {
  const rows = fixture.estates.map((r) => normalise(r as Parameters<typeof normalise>[0])).filter((l): l is Listing => !!l)
  const byId = new Map(rows.map((l) => [l.id, l]))

  it('keeps every fixture row with id, expose url, exact coords and an image', () => {
    expect(rows).toHaveLength(5)
    for (const l of rows) {
      expect(l.portal).toBe('sparkasse')
      expect(l.currency).toBe('EUR')
      expect(l.url).toBe(`https://immobilien.sparkasse.de/expose/${l.id}.html`)
      expect(l.coordsPrecision).toBe('exact')
      expect(l.lat).toBeGreaterThan(50)
      expect(l.lon).toBeGreaterThan(8)
      expect(l.image).toMatch(/^https:\/\//)
      expect(l.listedAt).toBeUndefined()
    }
  })

  it('fixes the ×100 / ×10 living-space trap and the decimal price', () => {
    expect(byId.get('FID-F13-500-795')?.floorArea).toBe(174.3) // numeric said 1743
    expect(byId.get('FID-F13-588-147')?.floorArea).toBe(125.92) // numeric said 12592
    expect(byId.get('FID-F13-552-695')).toMatchObject({ floorArea: 88.34, price: 285065.45, propertyType: 'Bungalow' })
    expect(byId.get('FID-F13-422-979')?.floorArea).toBe(135)
  })

  it('reads plot area with thousands separators, and half-Zimmer as 3.5 not 35', () => {
    expect(byId.get('FID-F13-422-979')?.plotArea).toBe(1098)
    expect(byId.get('FID-F13-588-147')?.plotArea).toBe(861)
    expect(byId.get('FID-F13-595-354')?.plotArea).toBeUndefined()
    expect(byId.get('FID-F13-595-354')?.bedrooms).toBe(3.5)
    expect(byId.get('FID-F13-588-147')?.bedrooms).toBe(6)
  })

  it('flags the offerer (Immowelt coop vs Sparkasse-own) without dropping either, and surfaces the German subtype', () => {
    expect(byId.get('FID-F13-595-354')).toMatchObject({ agent: 'immowelt Kooperationsangebot', propertyType: 'Einfamilienhaus', address: 'Dautphetal', price: 9900 })
    expect(byId.get('FID-F13-588-147')?.agent).toBe('Sparkassenangebot')
  })

  it('drops rows without an id; treats null / 0 price as absent; unknown subtype falls back to objectType', () => {
    expect(normalise({})).toBeNull()
    expect(normalise({ id: 'X', priceData: { value: null, numeric: null } })?.price).toBeUndefined()
    expect(normalise({ id: 'X', priceData: { value: '0 €', numeric: 0 } })?.price).toBeUndefined()
    expect(normalise({ id: 'X', estateSubTypeId: 9999, objectType: 'house' })?.propertyType).toBe('house')
    expect(normalise({ id: 'X', offererCategory: 7 })?.agent).toBeUndefined()
  })
})

describe('SparkasseClient.count', () => {
  it('one circle for a small ring, with the compiled params and a ≤100 km radius', async () => {
    const { client: c, urls } = client(() => json({ totalItems: 135 }))
    expect(await c.count([smallRing], criteria)).toBe(135)
    expect(urls).toHaveLength(1)
    const q = urls[0]!
    expect(q.pathname).toBe('/api/immobilien-api/estates/count')
    expect(q.searchParams.get('estateTypeGroupingIds')).toBe('396')
    expect(q.searchParams.get('estateSubTypeIds')).toBe('59,58,61,62,63,64,65')
    expect(q.searchParams.get('maxPrice')).toBe('300000')
    expect(q.searchParams.get('minRooms')).toBe('3')
    expect(Number(q.searchParams.get('latitude'))).toBeCloseTo(50.8, 1)
    expect(Number(q.searchParams.get('longitude'))).toBeCloseTo(8.75, 1)
    expect(Number(q.searchParams.get('radius'))).toBeLessThanOrEqual(100)
    expect(Number(q.searchParams.get('radius'))).toBeGreaterThan(0)
  })

  it('tiles a big ring into several circles and sums them (an over-estimate where circles overlap)', async () => {
    const { client: c, urls } = client(() => json({ totalItems: 10 }))
    const n = await c.count([bigRing], criteria)
    expect(urls.length).toBeGreaterThan(4)
    expect(n).toBe(10 * urls.length)
    for (const u of urls) expect(Number(u.searchParams.get('radius'))).toBeLessThanOrEqual(100)
  })
})

describe('SparkasseClient.newest', () => {
  const pageOf = (url: URL, total: number, perPage: (page: number) => string[]) => {
    const page = Number(url.searchParams.get('page'))
    const pageCount = Math.ceil(total / 100)
    return json({ estates: perPage(page).map(row), page, pageCount, totalItems: total })
  }

  it('sends newest-first paging params and normalises the recorded fixture', async () => {
    const { client: c, urls } = client(() => json(fixture))
    const r = await c.newest([smallRing], criteria, 100)
    expect(urls).toHaveLength(1)
    const q = urls[0]!.searchParams
    expect(urls[0]!.pathname).toBe('/api/immobilien-api/estates')
    expect(q.get('sort')).toBe('3')
    expect(q.get('pageSize')).toBe('100')
    expect(q.get('page')).toBe('1')
    expect(r.portal).toBe('sparkasse')
    expect(r.total).toBe(fixture.totalItems)
    expect(r.listings).toHaveLength(5)
    expect(r.truncated).toBe(false)
    expect(r.unsupported).toEqual(['minPlotArea'])
  })

  it('limit=Infinity walks every page to the end and reports the total once', async () => {
    // 250 rows → pages 1..3 (100/100/50).
    const ids = (page: number) => Array.from({ length: page === 3 ? 50 : 100 }, (_, i) => `P${page}-${i}`)
    const { client: c, urls } = client((u) => pageOf(u, 250, ids))
    const r = await c.newest([smallRing], criteria, Infinity)
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(r.listings).toHaveLength(250)
    expect(r.total).toBe(250)
    expect(r.truncated).toBe(false)
  })

  it('a finite limit stops after enough pages without flagging truncation', async () => {
    const ids = (page: number) => Array.from({ length: 100 }, (_, i) => `P${page}-${i}`)
    const { client: c, urls } = client((u) => pageOf(u, 1000, ids))
    const r = await c.newest([smallRing], criteria, 150)
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2'])
    expect(r.listings).toHaveLength(200)
    expect(r.truncated).toBe(false)
  })

  it('stops on an empty page even if pageCount claims more', async () => {
    const { client: c, urls } = client((u) => {
      const page = Number(u.searchParams.get('page'))
      return json({ estates: page === 1 ? [row('a')] : [], page, pageCount: 5, totalItems: 500 })
    })
    const r = await c.newest([smallRing], criteria, Infinity)
    expect(urls).toHaveLength(2)
    expect(r.listings.map((l) => l.id)).toEqual(['a'])
  })

  it('flags truncated when the portal reports more rows than its pages can hold', async () => {
    const { client: c } = client((u) => json({ estates: [row('a')], page: Number(u.searchParams.get('page')), pageCount: 1, totalItems: 250 }))
    const r = await c.newest([smallRing], criteria, Infinity)
    expect(r.truncated).toBe(true)
  })

  it('dedupes rows seen from overlapping circles and across rings', async () => {
    const { client: c, urls } = client(() => json({ estates: [row('same'), row('same')], page: 1, pageCount: 1, totalItems: 2 }))
    const r = await c.newest([bigRing, smallRing], criteria, Infinity)
    expect(urls.length).toBeGreaterThan(5)
    expect(r.listings).toHaveLength(1)
    expect(r.total).toBe(2 * urls.length)
  })

  it('a 4xx fails fast with a clear error (5xx retries with a 2 s/4 s backoff — too slow to unit-test)', async () => {
    const { client: c, urls } = client(() => json({}, 404))
    await expect(c.newest([smallRing], criteria, 100)).rejects.toThrow(/sparkasse: HTTP 404/)
    expect(urls).toHaveLength(1)
  })

  it('rent is refused before any request is made', async () => {
    const { client: c, urls } = client(() => json({}))
    await expect(c.newest([smallRing], { channel: 'rent' }, 100)).rejects.toThrow(/rent/)
    expect(urls).toHaveLength(0)
  })
})

describe('SparkasseClient.isLive', () => {
  const l: Listing = { portal: 'sparkasse', id: 'FID-F13-595-354', url: 'x', currency: 'EUR' }

  it('probes estateIds: the id back → live, empty → gone, HTTP failure → unknown', async () => {
    const { client: live, urls } = client(() => json({ estates: [row('FID-F13-595-354')], totalItems: 1 }))
    expect(await live.isLive(l)).toBe(true)
    expect(urls[0]!.searchParams.get('estateIds')).toBe('FID-F13-595-354')
    expect(urls[0]!.searchParams.get('pageSize')).toBe('1')
    expect(await client(() => json({ estates: [], totalItems: 0 })).client.isLive(l)).toBe(false)
    expect(await client(() => json({ estates: [row('other')], totalItems: 1 })).client.isLive(l)).toBe(false)
    expect(await client(() => json({}, 403)).client.isLive(l)).toBeNull()
    const net = new SparkasseClient((() => Promise.reject(new Error('net'))) as unknown as typeof fetch, 0)
    expect(await net.isLive(l)).toBeNull()
  })
})
