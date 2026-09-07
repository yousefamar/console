import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WikicasaClient, compile, normalise, wkt, isTooSmall, type RawRow } from '../property/wikicasa.js'
import type { Ring } from '../property/geo.js'
import type { Criteria } from '../property/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/wikicasa-list.json'), 'utf8')) as { count: number; results: RawRow[] }

/** Square ring around Pisa–Lucca, [lng, lat], closed. */
const RING: Ring = [
  [10.2, 43.6],
  [10.8, 43.6],
  [10.8, 44.0],
  [10.2, 44.0],
  [10.2, 43.6],
]
const CRITERIA: Criteria = {
  channel: 'buy',
  propertyType: 'house',
  houseSubtypes: ['detached', 'semi-detached', 'bungalow', 'villa', 'farmhouse'],
  maxPrice: 300000,
  minBedrooms: 2,
}

interface Call {
  url: URL
  body: Record<string, unknown>
}

/** A row with a real point at (lat, lon), newest ids first when ids descend. */
function row(id: number, lat: number, lon: number, extra: Partial<RawRow> = {}): RawRow {
  return {
    realEstateID: id,
    url: `/annuncio/${id}`,
    title: `Villa in Via Test ${id}, Pisa`,
    address: `Via Test ${id}`,
    cityName: 'Pisa',
    price: 200000,
    priceSale: 200000,
    reservedPrice: false,
    sqm: 120,
    rooms: 5,
    bathrooms: 2,
    publishMap: true,
    cityDto: { latitude: lat, longitude: lon },
    date: '2026-09-05T00:00:00.000+0000',
    recent: false,
    description: 'Bella villa.',
    agency: { name: 'Agenzia Test' },
    ...extra,
  }
}

/**
 * Stubbed portal: `pages` is the full newest-first result set for any polygon
 * query; `realEstateIdList` queries answer from the same rows. Records every
 * call. `limit`/`offset` are honoured like the live API (limit clamps at 25,
 * an empty page is a 404 with the JSON error body).
 */
function portal(rows: RawRow[]) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url, body })
    const limit = Math.min(25, Number(url.searchParams.get('limit')))
    const offset = Number(url.searchParams.get('offset'))
    const ids = body.realEstateIdList as number[] | undefined
    const pool = ids ? rows.filter((r) => ids.includes(r.realEstateID!)) : rows
    const page = pool.slice(offset, offset + limit)
    if (page.length === 0) {
      return new Response(JSON.stringify({ error: true, statusCode: 404, statusMessage: 'No real estate found' }), { status: 404 })
    }
    return new Response(JSON.stringify({ count: pool.length, results: page }), { status: 200 })
  }) as unknown as typeof fetch
  const client = new WikicasaClient(fetchImpl, async () => {})
  return { client, calls }
}

describe('wkt', () => {
  it('emits a closed WKT POLYGON in "lng lat" order', () => {
    const w = wkt(RING)
    expect(w.startsWith('POLYGON((10.200000 43.600000, 10.800000 43.600000')).toBe(true)
    expect(w.endsWith('10.200000 43.600000))')).toBe(true)
    // 4 distinct vertices + explicit closure.
    expect(w.match(/,/g)).toHaveLength(4)
  })

  it('keeps big rings whole (no simplification below the 3,000-vertex cap)', () => {
    const big: Ring = Array.from({ length: 2500 }, (_, i) => {
      const t = (i / 2500) * 2 * Math.PI
      return [10.5 + 0.3 * Math.cos(t), 43.8 + 0.2 * Math.sin(t)] as [number, number]
    })
    expect(wkt(big).match(/,/g)).toHaveLength(2500)
  })

  it('flags degenerate slivers so they are never sent', () => {
    expect(isTooSmall([[9.38, 45.86], [9.38, 45.86], [9.38, 45.86], [9.38, 45.86]])).toBe(true)
    expect(isTooSmall([[9.38, 45.86], [9.39, 45.86], [9.38, 45.86]])).toBe(true)
    expect(isTooSmall(RING)).toBe(false)
  })
})

describe('compile', () => {
  it('buy + house subtypes → sale bean with the search-side typology ids', () => {
    const b = compile(CRITERIA)
    expect(b).toMatchObject({ sale: true, rent: false, contractType: 1, portal: 'WIKICASA', priceTo: 300000, roomsFrom: 2 })
    // detached 9, semi 59, villa 6, farmhouse (rustici) 10 — bungalow has no id.
    expect(b.listingTypologyIdList).toEqual([9, 59, 6, 10])
    expect(b).not.toHaveProperty('priceFrom')
    expect(b).not.toHaveProperty('roomsTo')
  })

  it('defaults to the five-type house set; flats and any have their own ids', () => {
    expect(compile({ propertyType: 'house' }).listingTypologyIdList).toEqual([9, 59, 7, 6, 10])
    expect(compile({ propertyType: 'house', houseSubtypes: ['bungalow'] }).listingTypologyIdList).toEqual([9, 59, 7, 6, 10])
    expect(compile({ propertyType: 'house', houseSubtypes: ['land'] }).listingTypologyIdList).toEqual([30, 31])
    expect(compile({ propertyType: 'flat' }).listingTypologyIdList).toEqual([5, 8])
    expect(compile({ propertyType: 'any' }).listingTypologyIdList).toEqual([0])
    expect(compile({}).listingTypologyIdList).toEqual([0])
  })

  it('rent flips the channel triple', () => {
    expect(compile({ channel: 'rent' })).toMatchObject({ sale: false, rent: true, contractType: 2 })
  })

  it('emits only the live-verified filter names, never maxBedrooms as roomsTo', () => {
    const b = compile({
      channel: 'buy',
      minPrice: 100000,
      maxPrice: 300000,
      minBedrooms: 2,
      maxBedrooms: 4,
      minBathrooms: 2,
      minFloorArea: 100,
      maxFloorArea: 250,
      mustHaveGarden: true,
      mustHaveParking: true,
      excludeAuctions: true,
      freeholdOnly: true,
      keywords: ['piscina'],
      minPlotArea: 1000,
    })
    expect(b).toMatchObject({
      priceFrom: 100000,
      priceTo: 300000,
      roomsFrom: 2,
      bathroomsFrom: 2,
      sqMfrom: 100,
      sqMto: 250,
      privateGarden: true,
      boxCarSpot: true,
      excludeAuctions: true,
      excludeBareOwnership: true,
    })
    expect(Object.keys(b).sort()).toEqual(
      ['bathroomsFrom', 'boxCarSpot', 'contractType', 'excludeAuctions', 'excludeBareOwnership', 'listingTypologyIdList', 'portal', 'priceFrom', 'priceTo', 'privateGarden', 'rent', 'roomsFrom', 'sale', 'sqMfrom', 'sqMto'],
    )
  })
})

describe('WikicasaClient.newest', () => {
  it('sends the ring as polygonFromMap with MOST_RECENT, no region ids, and pages by offset', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(1000 - i, 43.7, 10.4))
    const { client, calls } = portal(rows)
    const r = await client.newest([RING], CRITERIA, 50)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url.pathname).toBe('/api-nuxt/realEstate/getListRealEstate')
    expect(calls[0]!.url.searchParams.get('limit')).toBe('25')
    expect(calls[0]!.url.searchParams.get('offset')).toBe('0')
    expect(calls[0]!.url.searchParams.get('maxPhotos')).toBe('1')
    expect(calls[1]!.url.searchParams.get('offset')).toBe('25')
    const body = calls[0]!.body
    expect(body.filterOrder).toBe('MOST_RECENT')
    expect(body.polygonFromMap).toBe(wkt(RING))
    expect(body).toMatchObject({ sale: true, contractType: 1, priceTo: 300000, roomsFrom: 2, listingTypologyIdList: [9, 59, 6, 10] })
    expect(body).not.toHaveProperty('regionId')
    expect(body).not.toHaveProperty('placeId')
    expect(body).not.toHaveProperty('placeType')
    expect(r.total).toBe(30)
    expect(r.listings).toHaveLength(30)
    expect(r.truncated).toBe(false)
    expect(r.portal).toBe('wikicasa')
  })

  it('stops after enough pages for a finite limit', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(5000 - i, 43.7, 10.4))
    const { client, calls } = portal(rows)
    const r = await client.newest([RING], CRITERIA, 50)
    expect(calls).toHaveLength(2)
    expect(r.listings).toHaveLength(50)
    // Newest first: the highest ids came back.
    expect(r.listings[0]!.id).toBe('5000')
    expect(r.total).toBe(200)
  })

  it('walks to the very end for limit=Infinity and never claims truncation', async () => {
    const rows = Array.from({ length: 63 }, (_, i) => row(9000 - i, 43.7, 10.4))
    const { client, calls } = portal(rows)
    const r = await client.newest([RING], CRITERIA, Number.POSITIVE_INFINITY)
    // 25 + 25 + 13 — the short last page ends the walk without a 404 probe.
    expect(calls.map((c) => c.url.searchParams.get('offset'))).toEqual(['0', '25', '50'])
    expect(r.listings).toHaveLength(63)
    expect(r.truncated).toBe(false)
    expect(r.total).toBe(63)
  })

  it('treats the 404 "No real estate found" body as an empty ring, not an error', async () => {
    const { client, calls } = portal([])
    const r = await client.newest([RING], CRITERIA, 50)
    expect(calls).toHaveLength(1)
    expect(r.total).toBe(0)
    expect(r.listings).toEqual([])
  })

  it('drops exact-coordinate rows outside the ring but keeps hidden-address rows for the hub to buffer', async () => {
    const rows = [
      row(3, 43.7, 10.4), // inside
      row(2, 44.5, 10.4), // exact, outside → dropped
      row(1, 44.5, 10.4, { publishMap: false, address: '' }), // fuzzy, outside → kept as 'area'
    ]
    const { client } = portal(rows)
    const r = await client.newest([RING], CRITERIA, 50)
    expect(r.listings.map((l) => l.id)).toEqual(['3', '1'])
    expect(r.listings[0]!.coordsPrecision).toBeUndefined()
    expect(r.listings[1]!.coordsPrecision).toBe('area')
    expect(r.total).toBe(3)
  })

  it('skips degenerate rings without a request and queries each real ring separately', async () => {
    const rows = [row(10, 43.7, 10.4)]
    const { client, calls } = portal(rows)
    const sliver: Ring = [[9.38, 45.86], [9.38, 45.86], [9.38, 45.86], [9.38, 45.86]]
    const second: Ring = [[12.6, 45.5], [14.2, 45.5], [14.2, 46.3], [12.6, 46.3], [12.6, 45.5]]
    const r = await client.newest([RING, sliver, second], CRITERIA, 50)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body.polygonFromMap).toBe(wkt(RING))
    expect(calls[1]!.body.polygonFromMap).toBe(wkt(second))
    // The stub returns the same row for both rings; the second's is outside → PIP drops it, ids dedupe anyway.
    expect(r.listings).toHaveLength(1)
    expect(r.total).toBe(2)
  })

  it('reports everything the portal cannot filter server-side', async () => {
    const { client } = portal([])
    const r = await client.newest([RING], {
      ...CRITERIA,
      maxBedrooms: 4,
      minPlotArea: 500,
      maxPlotArea: 5000,
      minYearBuilt: 1950,
      maxYearBuilt: 2020,
      minInternetMbit: 100,
      excludeNewBuild: true,
      noBuyerFee: true,
      maxDaysSinceAdded: 7,
      excludeSchemes: true,
      excludeCommonhold: true,
      keywords: ['piscina'],
      excludePriceOnRequest: true,
      excludeAuctions: true,
      freeholdOnly: true,
      mustHaveGarden: true,
      mustHaveParking: true,
      minFloorArea: 100,
      minBathrooms: 2,
    }, 50)
    expect(r.unsupported.sort()).toEqual([
      'excludeCommonhold',
      'excludeNewBuild',
      'excludePriceOnRequest',
      'excludeSchemes',
      'houseSubtypes', // bungalow in CRITERIA has no id
      'keywords',
      'maxBedrooms',
      'maxDaysSinceAdded',
      'maxPlotArea',
      'maxYearBuilt',
      'minInternetMbit',
      'minPlotArea',
      'minYearBuilt',
      'noBuyerFee',
    ])
    // Applied server-side, so absent: excludeAuctions, freeholdOnly, mustHaveGarden, mustHaveParking, minFloorArea, minBathrooms, minBedrooms, maxPrice.
    const fully = await client.newest([RING], { channel: 'buy', propertyType: 'house', houseSubtypes: ['villa'], maxPrice: 1 }, 50)
    expect(fully.unsupported).toEqual([])
  })

  it('paces requests ≥1.5 s apart via the injected sleep', async () => {
    const waits: number[] = []
    const rows = Array.from({ length: 30 }, (_, i) => row(100 - i, 43.7, 10.4))
    const fetchImpl = (async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get('offset'))
      return new Response(JSON.stringify({ count: 30, results: rows.slice(offset, offset + 25) }), { status: 200 })
    }) as unknown as typeof fetch
    const client = new WikicasaClient(fetchImpl, async (ms) => { waits.push(ms) })
    await client.newest([RING], CRITERIA, 50)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(1000)
    expect(waits[0]).toBeLessThanOrEqual(1500)
  })
})

describe('WikicasaClient.count', () => {
  it('asks for one row per ring and sums the portal counts', async () => {
    const { client, calls } = portal(Array.from({ length: 7 }, (_, i) => row(50 - i, 43.7, 10.4)))
    expect(await client.count([RING], CRITERIA)).toBe(7)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.searchParams.get('limit')).toBe('1')
    expect(calls[0]!.body.polygonFromMap).toBe(wkt(RING))
    expect(calls[0]!.body).not.toHaveProperty('filterOrder')
  })
})

describe('WikicasaClient.isLive', () => {
  it('present in realEstateIdList → live, absent/404 → gone, HTTP failure → unknown', async () => {
    const live = normalise(row(77, 43.7, 10.4))!
    const { client, calls } = portal([row(77, 43.7, 10.4), row(78, 43.7, 10.4)])
    expect(await client.isLive(live, CRITERIA)).toBe(true)
    expect(calls[0]!.body).toMatchObject({ sale: true, rent: false, contractType: 1, portal: 'WIKICASA', realEstateIdList: [77] })
    expect(calls[0]!.body).not.toHaveProperty('polygonFromMap')
    expect(await portal([row(78, 43.7, 10.4)]).client.isLive(live, CRITERIA)).toBe(false)
    expect(await portal([]).client.isLive(live, CRITERIA)).toBe(false)
    const broken = new WikicasaClient((async () => new Response('', { status: 503 })) as unknown as typeof fetch, async () => {})
    expect(await broken.isLive(live, CRITERIA)).toBeNull()
    const netErr = new WikicasaClient((async () => { throw new Error('net') }) as unknown as typeof fetch, async () => {})
    expect(await netErr.isLive(live, CRITERIA)).toBeNull()
  })
})

describe('normalise (recorded fixture)', () => {
  const byId = new Map(fixture.results.map((r) => [r.realEstateID!, normalise(r)!]))

  it('maps the exact-address villa', () => {
    const l = byId.get(30758874)!
    expect(l).toMatchObject({
      portal: 'wikicasa',
      id: '30758874',
      url: 'https://www.wikicasa.it/annuncio/30758874',
      title: 'Villa in Via Palmiro Togliatti 100, Pieve a Nievole',
      address: 'Via Palmiro Togliatti 100, Pieve a Nievole',
      price: 288000,
      currency: 'EUR',
      bedrooms: 6, // locali, not camere
      bathrooms: 2,
      floorArea: 138,
      propertyType: 'Villa',
      lat: 43.8824,
      lon: 10.8019,
      listedAt: '2026-09-05T00:00:00.000Z',
      isNew: false,
      agent: 'DOVE.IT',
    })
    expect(l.coordsPrecision).toBeUndefined()
    expect(l.plotArea).toBeUndefined()
    expect(l.image).toMatch(/^https:\/\/images\.wk-cdn\.it\/.+\/webp\/640x480\.webp$/)
    expect(l.summary!.length).toBeLessThanOrEqual(400 + 60)
  })

  it('marks hidden-address rows as area-precision and keeps the row point', () => {
    const l = byId.get(30768831)!
    expect(l.coordsPrecision).toBe('area')
    expect(l.lat).toBeCloseTo(43.8715382, 6)
    expect(l.lon).toBeCloseTo(10.3397917, 6)
    expect(l.address).toBe('Massarosa')
    expect(l.isNew).toBe(true)
    expect(byId.get(30756441)!.coordsPrecision).toBe('area')
  })

  it('takes propertyType from the title prefix in both title shapes', () => {
    expect(byId.get(30738606)!.propertyType).toBe('Rustico')
    expect(byId.get(30762939)!.propertyType).toBe('Terratetto')
    expect(byId.get(30756441)!.propertyType).toBe('Terratetto')
    expect(normalise(row(1, 43.7, 10.4, { title: 'Villa a schiera in Agnola 1307, Cascina' }))!.propertyType).toBe('Villa a schiera')
  })

  it('pulls the garden/land m² phrase into the summary when the description buries it', () => {
    // Phrase at char ~2,180 of a 2,800-char description → surfaced up front.
    const buried = byId.get(30758874)!.summary!
    expect(buried.startsWith('[giardino privato di circa 30 mq] ')).toBe(true)
    // Phrase already inside the first 400 chars → left where it is, not duplicated.
    const early = byId.get(30762939)!.summary!
    expect(early.startsWith('[')).toBe(false)
    expect(early).toContain('GIARDINO TERGALE privato di 76mq')
    const near = normalise(row(1, 43.7, 10.4, { description: 'Casa con giardino di 300 mq e garage.' }))!
    expect(near.summary).toBe('Casa con giardino di 300 mq e garage.')
    expect(near.plotArea).toBeUndefined()
    // No phrase → plain head.
    expect(byId.get(30738606)!.summary!.startsWith('[')).toBe(false)
  })

  it('blanks price on reservedPrice, zero and rent-vs-sale mismatch; drops rows without an id', () => {
    expect(normalise(row(1, 43.7, 10.4, { reservedPrice: true }))!.price).toBeUndefined()
    expect(normalise(row(1, 43.7, 10.4, { priceSale: 0 }))!.price).toBeUndefined()
    expect(normalise(row(1, 43.7, 10.4, { priceSale: 0, priceRent: 900 }), true)!.price).toBe(900)
    expect(normalise(row(1, 43.7, 10.4, { sqm: 0, rooms: 0 }))!.floorArea).toBeUndefined()
    expect(normalise(row(1, 43.7, 10.4, { sqm: 0, rooms: 0 }))!.bedrooms).toBeUndefined()
    expect(normalise({ title: 'no id' })).toBeNull()
  })
})
