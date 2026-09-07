import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SubitoClient, compile, plan, unsupportedFor, normalise, isBareLand, typologyOf, listIdOf, FARM_QUERY, type RawAd, type RawResponse } from '../property/subito.js'
import { coverRingWithCircles, type Ring } from '../property/geo.js'
import type { Criteria, Listing } from '../property/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'subito-items.json'), 'utf8')) as RawResponse
const ads = fixture.ads!

/** A ~20 km square around Pisa — fits in one 100 km circle. */
const pisa: Ring = [[10.25, 43.6], [10.55, 43.6], [10.55, 43.8], [10.25, 43.8], [10.25, 43.6]]
/** ~2° × 2° (≈160 × 220 km) — needs several circles. */
const tuscany: Ring = [[9.8, 42.6], [11.8, 42.6], [11.8, 44.4], [9.8, 44.4], [9.8, 42.6]]

const houseCriteria: Criteria = { channel: 'buy', propertyType: 'house', houseSubtypes: ['detached', 'villa'], maxPrice: 300000, minBedrooms: 2 }
const farmCriteria: Criteria = { ...houseCriteria, houseSubtypes: ['detached', 'farmhouse'] }

interface Call {
  url: URL
  headers: Record<string, string>
}

/** Stub fetch that records every call and answers from `respond(params)`. */
function stub(respond: (p: URLSearchParams, call: Call) => RawResponse | Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call = { url, headers }
    calls.push(call)
    const r = respond(url.searchParams, call)
    return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, client: new SubitoClient(fetchImpl, { requestGapMs: 0 }) }
}

const empty: RawResponse = { count_all: 0, lines: 0, start: 0, ads: [] }

/** Synthetic c=30 row builder for the terreno/rustico rules. */
const ad = (over: Partial<RawAd> & { size?: number; category?: RawAd['category'] }): RawAd => {
  const { size, ...rest } = over
  return {
    urn: 'id:ad:1:list:42',
    category: { key: '30', value: 'Terreni e rustici', friendly_name: 'terreni-e-rustici' },
    dates: { display_iso8601: '2026-09-06T02:34:03.797+0200' },
    features: [
      { uri: '/price', values: [{ key: '59000', value: '59000 €' }] },
      ...(size != null ? [{ uri: '/size', values: [{ key: String(size), value: `${size} mq` }] }] : []),
    ],
    advertiser: { company: false, type: 0 },
    geo: { town: { value: 'Buti', lat: 43.7275, lon: 10.5874 }, city: { value: 'Pisa' } },
    urls: { default: 'https://www.subito.it/terreni-e-rustici/x-42.htm' },
    ...rest,
  }
}

describe('SubitoClient request shape', () => {
  it('sends the x-subito-channel header on every call — without it everything is an Akamai 403', async () => {
    const { calls, client } = stub(() => empty)
    await client.newest([pisa], houseCriteria, 100)
    await client.isLive({ portal: 'subito', id: '1', url: '', currency: 'EUR' })
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) expect(c.headers['x-subito-channel']).toBe('web')
  })

  it('compiles criteria to verified param names (pe, rs as locali, grd=true, t=s)', () => {
    const p = compile({ channel: 'buy', maxPrice: 300000, minPrice: 50000, minBedrooms: 2, maxBedrooms: 4, minBathrooms: 1, minFloorArea: 80, mustHaveGarden: true, keywords: ['giardino', 'terreno'] }, '29')
    expect(p).toEqual({ c: '29', t: 's', ps: '50000', pe: '300000', rs: '3', re: '5', btrs: '1', szs: '80', grd: 'true', q: 'giardino OR terreno' })
    expect(compile({ channel: 'rent' }, '29').t).toBe('u')
  })

  it('c=30 gets only price + the farm q — rooms/garden/size filters match nothing there', () => {
    const p = compile({ maxPrice: 300000, minBedrooms: 2, mustHaveGarden: true, minFloorArea: 80, keywords: ['x'] }, '30')
    expect(p).toEqual({ c: '30', t: 's', pe: '300000', q: FARM_QUERY })
    expect(FARM_QUERY).toBe('rustico OR casale OR podere OR cascina OR colonica')
  })

  it('queries one circle per tile with rad in metres, sort=datedesc, lim ≤ 100', async () => {
    const { calls, client } = stub(() => empty)
    await client.newest([pisa], houseCriteria, 100)
    expect(coverRingWithCircles(pisa, 100)).toHaveLength(1)
    expect(calls).toHaveLength(1)
    const p = calls[0]!.url.searchParams
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe('https://hades.subito.it/v1/search/items')
    expect(p.get('c')).toBe('29')
    expect(p.get('sort')).toBe('datedesc')
    expect(p.get('lim')).toBe('100')
    expect(p.get('start')).toBe('0')
    expect(p.get('pe')).toBe('300000')
    expect(p.get('rs')).toBe('3')
    expect(Number(p.get('lat'))).toBeCloseTo(43.7, 3)
    expect(Number(p.get('lon'))).toBeCloseTo(10.4, 3)
    const rad = Number(p.get('rad'))
    expect(rad).toBeGreaterThan(10_000)
    expect(rad).toBeLessThanOrEqual(100_000)
  })

  it('tiles a big ring into several circles and dedupes rows seen from more than one', async () => {
    const circles = coverRingWithCircles(tuscany, 100)
    expect(circles.length).toBeGreaterThan(1)
    const { calls, client } = stub(() => ({ count_all: 1, lines: 1, start: 1, ads: [ads[0]!] }))
    const r = await client.newest([tuscany], houseCriteria, 100)
    expect(calls).toHaveLength(circles.length)
    for (const c of calls) expect(Number(c.url.searchParams.get('rad'))).toBeLessThanOrEqual(100_000)
    expect(r.listings).toHaveLength(1)
    // total is the per-query sum — an over-estimate by design, like immobiliare's per-ring sum.
    expect(r.total).toBe(circles.length)
  })

  it('caps lim to what the limit still needs', async () => {
    const { calls, client } = stub(() => empty)
    await client.newest([pisa], houseCriteria, 50)
    expect(calls[0]!.url.searchParams.get('lim')).toBe('50')
  })
})

describe('SubitoClient pagination', () => {
  const row = (n: number): RawAd => ({ ...ads[0]!, urn: `id:ad:${n}:list:${n}` })
  const pages = (total: number) => (p: URLSearchParams): RawResponse => {
    const start = Number(p.get('start'))
    const lim = Number(p.get('lim'))
    const slice = Array.from({ length: Math.max(0, Math.min(lim, total - start)) }, (_, i) => row(start + i + 1))
    return { count_all: total, lines: slice.length, start: start + slice.length, ads: slice }
  }

  it('walks every page to the end when limit is Infinity and reports truncated=false', async () => {
    const { calls, client } = stub(pages(250))
    const r = await client.newest([pisa], houseCriteria, Infinity)
    expect(calls.map((c) => c.url.searchParams.get('start'))).toEqual(['0', '100', '200'])
    expect(r.listings).toHaveLength(250)
    expect(r.total).toBe(250)
    expect(r.truncated).toBe(false)
  })

  it('stops at the limit and reports truncated=true only when rows were left behind', async () => {
    const capped = stub(pages(250))
    const r = await capped.client.newest([pisa], houseCriteria, 100)
    expect(capped.calls).toHaveLength(1)
    expect(r.listings).toHaveLength(100)
    expect(r.truncated).toBe(true)

    const exact = stub(pages(100))
    const r2 = await exact.client.newest([pisa], houseCriteria, 100)
    expect(exact.calls).toHaveLength(1)
    expect(r2.truncated).toBe(false)
  })

  it('treats an empty page as the end even if count_all disagrees', async () => {
    const { calls, client } = stub((p) => (p.get('start') === '0' ? { count_all: 500, lines: 1, start: 1, ads: [row(1)] } : { count_all: 500, lines: 0, start: 1, ads: [] }))
    const r = await client.newest([pisa], houseCriteria, Infinity)
    expect(calls).toHaveLength(2)
    expect(r.listings).toHaveLength(1)
  })
})

describe('SubitoClient farmland branch', () => {
  it('adds the c=30 query only when farmhouse is among the requested subtypes', async () => {
    const plain = stub(() => empty)
    await plain.client.newest([pisa], houseCriteria, 100)
    expect(plain.calls.map((c) => c.url.searchParams.get('c'))).toEqual(['29'])

    const farm = stub(() => empty)
    await farm.client.newest([pisa], farmCriteria, 100)
    expect(farm.calls.map((c) => c.url.searchParams.get('c'))).toEqual(['29', '30'])
    const c30 = farm.calls[1]!.url.searchParams
    expect(c30.get('q')).toBe(FARM_QUERY)
    expect(c30.get('pe')).toBe('300000')
    expect(c30.has('rs')).toBe(false)
    expect(c30.has('grd')).toBe(false)
  })

  it('plan(): flats → c=7, any → 29 + 7, farmhouse never with flats', () => {
    expect(plan({ propertyType: 'flat' }).map((q) => q.c)).toEqual(['7'])
    expect(plan({ propertyType: 'any', houseSubtypes: ['farmhouse'] }).map((q) => q.c)).toEqual(['29', '7', '30'])
    expect(plan({ propertyType: 'flat', houseSubtypes: ['farmhouse'] }).map((q) => q.c)).toEqual(['7'])
    expect(plan({}).map((q) => q.c)).toEqual(['29'])
  })
})

describe('terreno vs rustico', () => {
  it('drops a terreno with no building named anywhere', () => {
    expect(isBareLand(ad({ subject: 'Terreno agricolo uso oliveto', body: 'Oliveto di 6580 mq con accesso dalla strada.', size: 6580 }))).toBe(true)
    expect(normalise(ad({ subject: 'Terreno edificabile', body: 'Lotto di 1200 mq, urbanizzato.', size: 1200 }))).toBeNull()
  })

  it('keeps a terreno whose text names a building, typed as land-with-building', () => {
    const l = normalise(ad({ subject: 'Terreno agricolo', body: 'Terreno di 3 ettari con rustico da ristrutturare di 120 mq.', size: 30000 }))!
    expect(l).not.toBeNull()
    expect(l.propertyType).toBe('Terreno agricolo con rustico')
    // /size on a terreno row is the land.
    expect(l.plotArea).toBe(30000)
    expect(l.floorArea).toBeUndefined()
  })

  it('reads /size as floor area for a rustico, unless it is implausibly large for a building', () => {
    const small = normalise(ad({ subject: 'RUSTICO A SAN GIULIANO TERME', body: 'Terratetto di 240 mq.', size: 240 }))!
    expect(small.floorArea).toBe(240)
    expect(small.plotArea).toBeUndefined()
    const big = normalise(ad({ subject: 'Rustico con terreno', body: 'Rustico di 90 mq su 12000 mq di terreno.', size: 12000 }))!
    expect(big.plotArea).toBe(12000)
    expect(big.floorArea).toBeUndefined()
  })

  it('/size is always floor area in the house category', () => {
    const l = normalise(ad({ category: { key: '29', value: 'Ville singole e a schiera' }, subject: 'Villa con parco', body: 'Villa di 200 mq.', size: 2500 }))!
    expect(l.floorArea).toBe(2500)
    expect(l.plotArea).toBeUndefined()
  })

  it('typology: leftmost on the subject, dwellings before land on the body, outbuildings never from the body', () => {
    expect(typologyOf('Rustico / Casale di 370 m² con 5 locali', '')).toEqual({ text: 'Rustico', land: false })
    expect(typologyOf('Casa indipendente di 115 m²', '')).toEqual({ text: 'Casa indipendente', land: false })
    expect(typologyOf('RIMESSAGGIO Con TERRENO', '')).toEqual({ text: 'Terreno', land: true })
    expect(typologyOf('Capannone da ristrutturare', '')).toEqual({ text: 'Capannone', land: false })
    expect(typologyOf('Immobile in asta di 214 m² con 5 locali e box auto', 'Villa su tre livelli con soggiorno')).toEqual({ text: 'Villa', land: false })
    expect(typologyOf('TRILOCALE INDIPENDENTE CON AMPIO TERRENO EDIFICABILE', '')).toEqual({ text: 'Trilocale', land: false })
    expect(typologyOf('Abitazione indipendente a Santo Stefano', '')).toEqual({ text: 'Abitazione indipendente', land: false })
    expect(typologyOf('Terreno con casa', '')).toEqual({ text: 'Terreno', land: true })
    expect(typologyOf('Occasione a Lari', 'Immerso in un terreno di 3000 mq, il casale offre…')).toEqual({ text: 'Casale', land: false })
    expect(typologyOf('Occasione', 'Ampio garage e giardino')).toBeUndefined()
    expect(typologyOf('Viareggina a - MarcianaCascina', 'Villetta su di un unico piano')).toEqual({ text: 'Villetta', land: false })
    expect(typologyOf('Boschi di Lari', 'Bel terreno')).toEqual({ text: 'Terreno', land: true })
  })

  it('a row with no recognisable typology is kept (fail-open)', () => {
    expect(normalise(ad({ subject: 'Occasione', body: 'Da vedere.', size: 100 }))).not.toBeNull()
  })
})

describe('normalise() over the recorded fixture', () => {
  const rows = ads.map(normalise)
  const kept = rows.filter((l): l is Listing => l !== null)

  it('drops exactly the bare-land row and keeps the other four', () => {
    expect(rows).toHaveLength(5)
    expect(kept.map((l) => l.title)).toEqual(['Terratetto Lari', 'Viareggina a - MarcianaCascina', 'RUSTICO A SAN GIULIANO TERME', 'Rustico indipendente'])
  })

  it('every row is a comune centroid: coordsPrecision area, town lat/lon', () => {
    for (const l of kept) {
      expect(l.coordsPrecision).toBe('area')
      expect(l.lat).toBeTypeOf('number')
      expect(l.lon).toBeTypeOf('number')
      expect(l.portal).toBe('subito')
      expect(l.currency).toBe('EUR')
    }
    // town centroid, not geo.map (which is a street address 2.5 km away on this row)
    expect(kept[0]!.lat).toBeCloseTo(43.566445, 5)
    expect(kept[0]!.lon).toBeCloseTo(10.59237, 5)
  })

  it('maps the agency house row: list id, url, price, locali-1 bedrooms, floor area, agency name, image rule, UTC listedAt', () => {
    const l = kept[0]!
    expect(l.id).toBe('658544195')
    expect(listIdOf('id:ad:612144312:list:658544195')).toBe('658544195')
    expect(l.url).toBe('https://www.subito.it/ville-singole-e-a-schiera/terratetto-lari-pisa-658544195.htm')
    expect(l.price).toBe(190000)
    expect(l.bedrooms).toBe(5) // 6 locali
    expect(l.bathrooms).toBe(2)
    expect(l.floorArea).toBe(165)
    expect(l.plotArea).toBeUndefined()
    expect(l.propertyType).toBe('Terratetto')
    expect(l.address).toBe('Via delle Vigne, 35, 56035 Boschi PI, Italia')
    expect(l.agent).toBe('AGENZIA IMMOBILIARE LA SPINA')
    expect(l.image).toMatch(/^https:\/\/images\.sbito\.it\/.*\?rule=gallery-desktop-1x-auto$/)
    expect(l.listedAt).toBe('2026-09-06T11:30:23.987Z')
    expect(l.summary!.length).toBeLessThanOrEqual(1500)
    expect(l.summary).toContain('terratetto di 165 mq')
  })

  it('falls back to the body for the typology when the subject has none', () => {
    const l = kept[1]!
    expect(l.propertyType).toBe('Villetta')
    expect(l.address).toBe('Cascina, Pisa')
  })

  it('c=30 rustico by an agency: /size is the building, no rooms, listed agent', () => {
    const l = kept[2]!
    expect(l.propertyType).toBe('Rustico')
    expect(l.floorArea).toBe(240)
    expect(l.plotArea).toBeUndefined()
    expect(l.bedrooms).toBeUndefined()
    expect(l.agent).toBe('STUDIO VECCHIANO srl')
    expect(l.price).toBe(59000)
  })

  it('private seller stays anonymous as "privato"', () => {
    const l = kept[3]!
    expect(l.agent).toBe('privato')
    expect(l.propertyType).toBe('Rustico')
    expect(l.floorArea).toBe(28)
    expect(l.summary).toContain('giardino di circa 1300mq')
  })

  it('missing price = prezzo su richiesta → undefined, not 0', () => {
    const l = normalise(ad({ subject: 'Rustico', body: 'x', features: [] }))!
    expect(l.price).toBeUndefined()
  })
})

describe('unsupported', () => {
  it('always lists what Subito has no filter for', () => {
    const u = unsupportedFor({ houseSubtypes: ['detached'], excludeAuctions: true, excludeSchemes: true, freeholdOnly: true, excludePriceOnRequest: true, minPlotArea: 2000, mustHaveParking: true, excludeNewBuild: true, maxDaysSinceAdded: 7 })
    expect(u).toEqual(['houseSubtypes', 'excludeAuctions', 'excludeSchemes', 'freeholdOnly', 'excludePriceOnRequest', 'minPlotArea', 'excludeNewBuild', 'maxDaysSinceAdded', 'mustHaveParking'])
  })

  it('adds the residential filters when the c=30 pull ran without them', () => {
    const base: Criteria = { minBedrooms: 2, mustHaveGarden: true, minFloorArea: 80, keywords: ['x'] }
    expect(unsupportedFor(base)).toEqual([])
    expect(unsupportedFor({ ...base, houseSubtypes: ['farmhouse'] })).toEqual(['houseSubtypes', 'minBedrooms', 'minFloorArea', 'mustHaveGarden', 'keywords'])
  })

  it('newest() reports it on the result', async () => {
    const { client } = stub(() => empty)
    const r = await client.newest([pisa], farmCriteria, 100)
    expect(r.unsupported).toContain('houseSubtypes')
    expect(r.unsupported).toContain('minBedrooms')
  })
})

describe('isLive', () => {
  const live: Listing = { portal: 'subito', id: '658544195', url: '', currency: 'EUR' }

  it('probes list_ids and answers from whether the id came back', async () => {
    const found = stub((p) => (p.get('list_ids') === '658544195' ? { count_all: 1, lines: 1, start: 1, ads: [ads[0]!] } : empty))
    expect(await found.client.isLive(live)).toBe(true)
    expect(found.calls[0]!.url.searchParams.get('list_ids')).toBe('658544195')
    expect(found.calls[0]!.url.searchParams.has('c')).toBe(false)

    const gone = stub(() => empty)
    expect(await gone.client.isLive(live)).toBe(false)
  })

  it('HTTP failure → unknown (keep)', async () => {
    const blocked = stub(() => new Response('Access Denied', { status: 403 }))
    expect(await blocked.client.isLive(live)).toBeNull()
  })
})

describe('errors', () => {
  it('403 names the header; 400 carries the portal error body', async () => {
    const a = stub(() => new Response('Access Denied', { status: 403 }))
    await expect(a.client.newest([pisa], houseCriteria, 10)).rejects.toThrow(/403.*x-subito-channel/)
    const b = stub(() => new Response('{"error":"SEARCH:invalid-param-grd"}', { status: 400 }))
    await expect(b.client.newest([pisa], houseCriteria, 10)).rejects.toThrow(/400.*invalid-param-grd/)
  })
})

describe('typology spelling variants', () => {
  it('reads the elided "semindipendente" as well as "semi-indipendente"', () => {
    expect(typologyOf('CASA SEMINDIPENDENTE A BRONI', '')).toEqual({ text: 'Casa semindipendente', land: false })
    expect(typologyOf('Casa semi-indipendente', '')).toEqual({ text: 'Casa semi-indipendente', land: false })
  })
})
