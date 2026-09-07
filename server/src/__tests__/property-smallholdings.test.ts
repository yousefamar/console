import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SmallholdingsClient,
  UkGeocoder,
  acresToM2,
  isBareLand,
  normalise,
  parseTitle,
  passesCriteria,
  type RawPost,
  type Terms,
} from '../property/smallholdings.js'
import type { Ring } from '../property/geo.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/smallholdings-posts.json', import.meta.url), 'utf8')) as {
  posts: RawPost[]
  categories: Array<{ id: number; name: string }>
  tags: Array<{ id: number; slug: string }>
}
const terms: Terms = {
  categories: new Map(fixture.categories.map((c) => [c.id, c.name])),
  tags: new Map(fixture.tags.map((t) => [t.id, t.slug])),
}

const dirs: string[] = []
const tmpCache = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'smallholdings-test-'))
  dirs.push(dir)
  return join(dir, 'nested', 'geocode-uk.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** Nominatim stub: place name → coordinates (or nothing). Records every query. */
const PLACES: Record<string, [number, number]> = {
  moelfre: [52.86, -3.15], // inside the Oswestry ring
  // ~2.7 km east of the ring — inside the 6 km buffer. (Not further: geo.ts
  // nearGeometry's bbox pre-filter pads by bufferKm/100 degrees, which is only
  // ~4 km of longitude at 53°N, so 4–6 km east/west is wrongly rejected there.)
  cheswardine: [52.85, -2.86],
  hardwick: [52.55, 1.3], // Norfolk — nowhere near
  newbridge: [50.13, -5.6], // Cornwall — nowhere near
}
const nominatimStub = (queries: string[]) => (url: string): Response => {
  const q = new URL(url).searchParams.get('q') ?? ''
  queries.push(q)
  const place = q.split(',')[0]!.trim().toLowerCase()
  const hit = PLACES[place]
  return json(hit ? [{ lat: String(hit[0]), lon: String(hit[1]) }] : [])
}

/** WP REST stub over `posts`, paginated like the real site. */
const wpStub = (posts: RawPost[], requests: string[]) => (url: string): Response => {
  requests.push(url)
  const u = new URL(url)
  if (u.pathname.endsWith('/categories')) return json(fixture.categories)
  if (u.pathname.endsWith('/tags')) return json(fixture.tags)
  if (/\/posts\/\d+$/.test(u.pathname)) {
    const id = Number(u.pathname.split('/').pop())
    const p = posts.find((x) => x.id === id)
    return p ? json(p) : json({ code: 'rest_post_invalid_id' }, 404)
  }
  if (u.pathname.endsWith('/posts')) {
    const perPage = Number(u.searchParams.get('per_page'))
    const page = Number(u.searchParams.get('page'))
    const totalPages = Math.max(1, Math.ceil(posts.length / perPage))
    if (page > totalPages) return json({ code: 'rest_post_invalid_page_number' }, 400)
    return json(posts.slice((page - 1) * perPage, page * perPage), 200, { 'x-wp-total': String(posts.length), 'x-wp-totalpages': String(totalPages) })
  }
  return json({ code: 'unrouted' }, 500)
}

const fetchOf = (...routes: Array<[test: (url: string) => boolean, handler: (url: string) => Response]>) =>
  ((input: string | URL | Request) => {
    const url = String(input)
    const route = routes.find(([test]) => test(url))
    return Promise.resolve(route ? route[1](url) : json({ code: 'unrouted' }, 500))
  }) as unknown as typeof fetch

const isNominatim = (u: string) => u.includes('nominatim.openstreetmap.org')
const isWp = (u: string) => u.includes('smallholdingsforsale.co.uk')

// Square around Oswestry (Shropshire), [lng, lat].
const OSWESTRY_RING: Ring = [
  [-3.2, 52.8],
  [-2.9, 52.8],
  [-2.9, 52.95],
  [-3.2, 52.95],
  [-3.2, 52.8],
]

describe('smallholdings parseTitle', () => {
  it('reads the canonical shape: main-house beds (not the annexe), acres, place, price, type', () => {
    const p = parseTitle('4 Bed Farmhouse Smallholding For Sale Inc. 1 Bed Annexe, Outbuildings &#038; 6.37 Acres of Paddocks in Hardwick (£750K)')
    expect(p).toEqual({ price: 750_000, acres: 6.37, bedrooms: 4, place: 'Hardwick', type: 'Farmhouse Smallholding', auction: false })
  })

  it('handles £1M / £1.125M / bare (845K) / trailing "- £575K" / "opening bid" prices', () => {
    expect(parseTitle('6 Bed Farmhouse Smallholding For Sale With 2 Bed Cottage &#038; 3.16 Acres of Land in Welshpool (£1M)').price).toBe(1_000_000)
    expect(parseTitle('4 Bed Smallholding For Sale With 10 Acres of Burton-On-Trent (£1.125M)').price).toBe(1_125_000)
    expect(parseTitle('Remote Smallholding For Sale With Boarding Kennel Business in Pontypridd (845K)').price).toBe(845_000)
    const ruthin = parseTitle('3 Bed Stone Cottage Smallholding For Sale With Barn, Stables &#038; Land (Nr. Ruthin) - £575K')
    expect(ruthin.price).toBe(575_000)
    expect(ruthin.place).toBe('Ruthin')
    expect(ruthin.acres).toBeUndefined()
    const bid = parseTitle('Derelict Cottage Smallholding For Sale With 0.5 Acre Land in Newbridge (£135K opening bid)')
    expect(bid).toMatchObject({ price: 135_000, acres: 0.5, bedrooms: undefined, place: 'Newbridge', auction: true })
    expect(parseTitle('4 Bed Smallholding For Sale With 2.5 Acres of Grounds in Castle Douglas').price).toBeUndefined()
  })

  it('finds the place after the LAST preposition, never inside "(By Auction)"', () => {
    const p = parseTitle('5 Bed Small Farm For Sale (By Auction) With 25 Acres of Pasture and Woodland in Alston (£495K)')
    expect(p).toMatchObject({ place: 'Alston', auction: true, type: 'Small Farm', bedrooms: 5, acres: 25 })
    expect(parseTitle('2 Bed Semi-Detached Smallholding For Sale With Stables &#038; 0.29 Acre Paddock Nr. Cheswardine (£315K)')).toMatchObject({
      place: 'Cheswardine',
      acres: 0.29,
      type: 'Semi-Detached Smallholding',
    })
    expect(parseTitle('4 Bed Smallholding For Sale With 4 Acres of Paddock by Forfar (£585K)').place).toBe('Forfar')
    expect(parseTitle('2 Bed Coastal Smallholding For Sale With 3.46 Acres of Grounds on the Island of Hoy (£360K)').place).toBe('Hoy')
    expect(parseTitle('4 Bed Equestrian Smallholding For Sale With Stables and 1.25 Acres in Appleby-in-Westmorland (£535K)').place).toBe('Appleby-in-Westmorland')
    expect(parseTitle('4 Bed Derelict Smallholding For Sale With Planning Permission &#038; 6 Acres of Pasture in Moelfre, Oswestry (£295K)').place).toBe('Moelfre, Oswestry')
  })

  it('recovers a place from "Acres of <Place>" when "in" is missing, but not from land nouns', () => {
    expect(parseTitle('4 Bed Smallholding For Sale With 10 Acres of Burton-On-Trent (£1.125M)').place).toBe('Burton-On-Trent')
    expect(parseTitle('4 Bed Equestrian Smallholding For Sale With 5.15 Acres of Old Leake (£539K)').place).toBe('Old Leake')
    expect(parseTitle('5 Bed Eco Swedish Timber Smallholding For Sale With 176.6 Acres Of Pasture (£850K)').place).toBeUndefined()
    expect(parseTitle('5 Bed Smallholding For Sale With 7.6 Acres of Ancient Woodland in Llanwern (£800K)').place).toBe('Llanwern')
  })

  it('strips a trailing postcode district but keeps a bare full postcode as the place', () => {
    expect(parseTitle('4 Bed Bungalow Smallholding For Sale With Woodland &#038; Pasture in Haile, Egremont, CA22 (£475K)').place).toBe('Haile, Egremont')
    expect(parseTitle('3 Bed Smallholding For Sale With Outbuildings &#038; 5 Acres Of Paddocks in LL12 9EW (£675K)').place).toBe('LL12 9EW')
  })

  it('takes beds from the title over the excerpt, and acres from the excerpt when the title has none', () => {
    const p = parseTitle(
      '4 Bed Bungalow Smallholding For Sale With Woodland &#038; Pasture in Haile, Egremont, CA22 (£475K)',
      '<p>Cumbria 3 bed 6.4 acres £475K [&#8230;]</p>',
    )
    expect(p.bedrooms).toBe(4)
    expect(p.acres).toBe(6.4)
    expect(parseTitle('Six-bedroom Period Home With Orchard, 0.5 Acres and Sea Views in Dalbeattie (£530K)')).toMatchObject({ bedrooms: 6, type: 'Period Home', place: 'Dalbeattie' })
    expect(parseTitle('4 Semi-Detached Equestrian Smallholding For Sale With Stables &#038; 3.3 Acres of Pasture in Milton Keynes (£700K)', 'Buckinghamshire 4 bed 3.3 acres').bedrooms).toBe(4)
  })
})

describe('smallholdings acres → m² and bare-land rule', () => {
  it('converts at 4046.86 m²/acre, rounded', () => {
    expect(acresToM2(1)).toBe(4047)
    expect(acresToM2(6.37)).toBe(25_778)
    expect(acresToM2(0.5)).toBe(2023)
  })

  it('drops land, plots and barns-with-permission; keeps dwellings even without a bed count', () => {
    expect(isBareLand('36.7 Acres of Grassland For Sale Nr. Whitchurch (£295K)', undefined)).toBe(true)
    expect(isBareLand('Development Plot With Stone Building &#038; 18.28 Acres of Pasture and Woodland in Harrogate (£110K)', undefined)).toBe(true)
    expect(isBareLand('Two Storey Barn For Sale Requiring Renovation With Planning For Conversion &#038; 1.22 Acres of Land in Bamford (£285K)', undefined)).toBe(true)
    expect(isBareLand('Smallholding Land For Sale With Steading Buildings &#038; 5 Acres of Land in Sutherland (£370K)', undefined)).toBe(true)
    expect(isBareLand('Static Caravan on Croft Land For Sale With 29 Acres of Pasture in Barvas (£60K)', undefined)).toBe(true)
    // A plot stays a plot even when the permitted dwelling has a bed count.
    expect(isBareLand('Plot For Sale With Planning Permission For 3 Bed Dwelling &#038; 0.6 Acre in East Gomeldon (£195K)', 3)).toBe(true)
    expect(isBareLand('Building Plot With Chalet &#038; Planning Permission For Permanent Residence &#038; 2.2 Acres of Land Nr. Rachan (£380K)', undefined)).toBe(true)
    expect(isBareLand('Farmhouse Requiring Total Renovation For Sale With 7.88 Acres of Land in Hill O Beith (£495K)', undefined)).toBe(false)
    expect(isBareLand('Derelict Cottage Smallholding For Sale With 0.5 Acre Land in Newbridge (£135K opening bid)', undefined)).toBe(false)
    expect(isBareLand('2x Holiday Let Properties For Sale With 77.5 Acres of Pasture in Exeter (£850K)', undefined)).toBe(false)
    // Any bed count means a dwelling, whatever the rest of the title says.
    expect(isBareLand('2 Bed Smallholding For Sale With Land in Bowes (£300K)', 2)).toBe(false)
  })
})

describe('smallholdings normalise (fixture)', () => {
  it('turns 6 real posts into 4 listings — the grassland lot and the blog article are dropped', () => {
    const rows = fixture.posts.map((p) => normalise(p, terms))
    expect(rows.filter(Boolean).map((r) => r!.listing.id)).toEqual(['60057', '59924', '59911', '55823'])
  })

  it('does not let an excerpt bed count rescue a barn-with-permission', () => {
    const barn: RawPost = {
      id: 1,
      link: 'https://smallholdingsforsale.co.uk/x/',
      title: { rendered: 'Two Storey Barn For Sale Requiring Renovation With Planning For Conversion, Outbuildings &#038; 1.22 Acres of Land in Bamford Village (£285K)' },
      excerpt: { rendered: '<p>Derbyshire 3 bed barn conversion 1.22 acres £285K [&#8230;]</p>' },
    }
    expect(normalise(barn, terms)).toBeNull()
  })

  it('maps every field of the Oswestry derelict', () => {
    const r = normalise(fixture.posts.find((p) => p.id === 59924)!, terms)!
    expect(r.place).toBe('Moelfre, Oswestry')
    expect(r.county).toBe('Shropshire')
    expect(r.country).toBe('England')
    expect(r.listing).toEqual({
      portal: 'smallholdings',
      id: '59924',
      url: 'https://smallholdingsforsale.co.uk/4-bed-derelict-smallholding-for-sale-with-planning-permission-6-acres-of-pasture-in-moelfre-oswestry-295k/',
      title: '4 Bed Derelict Smallholding For Sale With Planning Permission & 6 Acres of Pasture in Moelfre, Oswestry (£295K)',
      address: 'Moelfre, Oswestry, Shropshire',
      price: 295_000,
      currency: 'GBP',
      bedrooms: 4,
      plotArea: 24_281,
      propertyType: 'Derelict Smallholding',
      coordsPrecision: 'area',
      listedAt: '2026-08-31T03:30:18.000Z',
      summary: 'Shropshire 4 bed (derelict with planning permission) 6 acres £295K',
      keyFeatures: ['derelict', 'development', 'pasture', 'planning-permission'],
    })
    // Nothing that isn't a Listing field leaks onto the wire.
    expect(Object.keys(r.listing)).not.toContain('place')
  })

  it('falls back to the excerpt for the county when categories are not loaded', () => {
    const r = normalise(fixture.posts.find((p) => p.id === 55823)!)!
    expect(r.county).toBe('Cornwall')
    expect(r.country).toBeUndefined()
    expect(r.listing.keyFeatures).toBeUndefined()
    expect(r.listing.bedrooms).toBeUndefined()
    expect(r.listing.plotArea).toBe(2023)
  })

  it('passesCriteria enforces price / beds / plot locally; unknown beds fail a minBedrooms search', () => {
    const l = normalise(fixture.posts.find((p) => p.id === 59924)!, terms)!.listing
    expect(passesCriteria(l, { maxPrice: 300_000, minBedrooms: 2, minPlotArea: 2000 })).toBe(true)
    expect(passesCriteria(l, { maxPrice: 250_000 })).toBe(false)
    expect(passesCriteria(l, { minBedrooms: 5 })).toBe(false)
    expect(passesCriteria(l, { minPlotArea: 30_000 })).toBe(false)
    expect(passesCriteria(l, { maxPlotArea: 20_000 })).toBe(false)
    const noBeds = normalise(fixture.posts.find((p) => p.id === 55823)!, terms)!.listing
    expect(passesCriteria(noBeds, { minBedrooms: 1 })).toBe(false)
    expect(passesCriteria(noBeds, { maxPrice: 300_000 })).toBe(true)
  })
})

describe('UkGeocoder', () => {
  it('caches hits and misses on disk, creating the directory, and never re-asks', async () => {
    const file = tmpCache()
    const queries: string[] = []
    const g = new UkGeocoder(file, fetchOf([isNominatim, nominatimStub(queries)]), 0)
    expect(await g.lookup('Moelfre, Oswestry', 'Shropshire', 'England')).toEqual({ lat: 52.86, lon: -3.15 })
    expect(queries).toEqual(['Moelfre, Oswestry, Shropshire, England'])
    expect(existsSync(file)).toBe(true)
    // Two-part place the full form can't resolve: try each part with the county before giving up the hierarchy.
    expect(await g.lookup('Glan Y Gors, Cheswardine', 'Shropshire', 'England')).toEqual({ lat: 52.85, lon: -2.86 })
    expect(queries.slice(1)).toEqual(['Glan Y Gors, Cheswardine, Shropshire, England', 'Glan Y Gors, Shropshire, England', 'Cheswardine, Shropshire, England'])
    queries.length = 1
    // Second instance reads the file: no request.
    const g2 = new UkGeocoder(file, fetchOf([isNominatim, nominatimStub(queries)]), 0)
    expect(await g2.lookup('moelfre,  oswestry', 'SHROPSHIRE')).toEqual({ lat: 52.86, lon: -3.15 })
    expect(queries).toHaveLength(1)
    // A miss tries the fallback "<place>, UK" and then caches the null.
    expect(await g2.lookup('Lancester', 'Lancashire', 'England')).toBeNull()
    expect(queries.slice(1)).toEqual(['Lancester, Lancashire, England', 'Lancester, UK'])
    expect(await g2.lookup('Lancester', 'Lancashire', 'England')).toBeNull()
    expect(queries).toHaveLength(3)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      'moelfre, oswestry|shropshire': { lat: 52.86, lon: -3.15 },
      'glan y gors, cheswardine|shropshire': { lat: 52.85, lon: -2.86 },
      'lancester|lancashire': null,
    })
  })

  it('spaces requests by the configured delay, even when called concurrently', async () => {
    const times: number[] = []
    const g = new UkGeocoder(tmpCache(), fetchOf([isNominatim, (u) => { times.push(Date.now()); return nominatimStub([])(u) }]), 60)
    await Promise.all([g.lookup('Moelfre', 'Shropshire'), g.lookup('Hardwick', 'Norfolk'), g.lookup('Newbridge', 'Cornwall')])
    expect(times).toHaveLength(3)
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(55)
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(55)
  })

  it('does not cache a network/5xx failure', async () => {
    const file = tmpCache()
    let fail = true
    const g = new UkGeocoder(file, fetchOf([isNominatim, (u) => (fail ? json({}, 503) : nominatimStub([])(u))]), 0)
    await expect(g.lookup('Moelfre', 'Shropshire')).rejects.toThrow(/nominatim: HTTP 503/)
    fail = false
    expect(await g.lookup('Moelfre', 'Shropshire')).toEqual({ lat: 52.86, lon: -3.15 })
  })
})

describe('SmallholdingsClient.newest', () => {
  const client = (posts: RawPost[], wp: string[], geo: string[]) =>
    new SmallholdingsClient({
      fetchImpl: fetchOf([isNominatim, nominatimStub(geo)], [isWp, wpStub(posts, wp)]),
      cacheFile: tmpCache(),
      nominatimDelayMs: 0,
      pageDelayMs: 0,
    })

  it('filters by criteria BEFORE geocoding, then keeps rows inside the rings or within the 6 km buffer', async () => {
    const wp: string[] = []
    const geo: string[] = []
    const c = client(fixture.posts, wp, geo)
    const r = await c.newest([OSWESTRY_RING], { channel: 'buy', maxPrice: 400_000 }, Infinity)
    // £750K Hardwick never reaches Nominatim; the three ≤£400k rows do.
    expect(geo.map((q) => q.split(',')[0])).toEqual(['Moelfre', 'Cheswardine', 'Newbridge'])
    expect(r.listings.map((l) => l.id)).toEqual(['59924', '59911']) // Newbridge (Cornwall) is out of zone
    expect(r.total).toBe(2)
    expect(r.truncated).toBe(false)
    expect(r.unsupported).toEqual([])
    const moelfre = r.listings[0]!
    expect(moelfre).toMatchObject({ lat: 52.86, lon: -3.15, coordsPrecision: 'area', price: 295_000 })
    expect(c.stats).toMatchObject({ posts: 6, listings: 4, passedCriteria: 3, geocoded: 3, geocodeMisses: 0, inZone: 2 })
  })

  it('applies minBedrooms / minPlotArea itself and reports only what it cannot enforce', async () => {
    const r = await client(fixture.posts, [], []).newest([OSWESTRY_RING], { channel: 'buy', maxPrice: 300_000, minBedrooms: 2, minPlotArea: 2000, excludeAuctions: true, keywords: ['pasture'], minBathrooms: 1 }, Infinity)
    expect(r.listings.map((l) => l.id)).toEqual(['59924'])
    expect(r.unsupported).toEqual(['excludeAuctions', 'keywords', 'minBathrooms'])
  })

  it('returns nothing for rent or flats without touching the network', async () => {
    const wp: string[] = []
    const c = client(fixture.posts, wp, [])
    expect((await c.newest([OSWESTRY_RING], { channel: 'rent' }, 50)).listings).toEqual([])
    expect((await c.newest([OSWESTRY_RING], { propertyType: 'flat' }, 50)).listings).toEqual([])
    expect(wp).toEqual([])
  })

  it('pages through the whole catalogue at limit=Infinity and stops after one page for a small limit', async () => {
    // 226 synthetic posts, all parseable, none in zone (Hardwick).
    const template = fixture.posts.find((p) => p.id === 60057)!
    const many: RawPost[] = Array.from({ length: 226 }, (_, i) => ({ ...template, id: 100_000 + i }))
    const wp: string[] = []
    const c = client(many, wp, [])
    const r = await c.newest([OSWESTRY_RING], { channel: 'buy' }, Infinity)
    const postPages = wp.filter((u) => u.includes('/posts?')).map((u) => new URL(u).searchParams.get('page'))
    expect(postPages).toEqual(['1', '2', '3'])
    expect(wp.filter((u) => u.includes('/categories') || u.includes('/tags'))).toHaveLength(2)
    expect(c.stats?.posts).toBe(226)
    expect(r.truncated).toBe(false)

    const wp2: string[] = []
    const c2 = client(many, wp2, [])
    const r2 = await c2.newest([OSWESTRY_RING], { channel: 'buy' }, 50)
    const pages2 = wp2.filter((u) => u.includes('/posts?')).map((u) => new URL(u).searchParams)
    expect(pages2).toHaveLength(1)
    expect(pages2[0]!.get('per_page')).toBe('50')
    expect(pages2[0]!.get('orderby')).toBe('date')
    expect(c2.stats?.posts).toBe(50)
    expect(r2.truncated).toBe(true)
  })

  it('count() is the in-zone row count', async () => {
    expect(await client(fixture.posts, [], []).count([OSWESTRY_RING], { maxPrice: 400_000 })).toBe(2)
  })
})

describe('SmallholdingsClient.isLive / detail', () => {
  const l = normalise(fixture.posts.find((p) => p.id === 59924)!, terms)!.listing

  it('isLive: 404 → gone, 200 → live unless the post now says sold, 5xx → unknown', async () => {
    const mk = (handler: (url: string) => Response) => new SmallholdingsClient({ fetchImpl: fetchOf([isWp, handler]), cacheFile: tmpCache(), nominatimDelayMs: 0, pageDelayMs: 0 })
    expect(await mk(() => json({ code: 'rest_post_invalid_id' }, 404)).isLive(l)).toBe(false)
    expect(await mk(() => json({ id: 59924, title: { rendered: 'x' }, excerpt: { rendered: 'y' } })).isLive(l)).toBe(true)
    expect(await mk(() => json({ id: 59924, title: { rendered: 'SOLD - 4 Bed' }, excerpt: { rendered: '' } })).isLive(l)).toBe(false)
    expect(await mk(() => json({}, 503)).isLive(l)).toBeNull()
  })

  it('detail: agent from the outbound link, description, image, postcode coordinates', async () => {
    const html =
      '<p>Glan Y Gors Plot, Moelfre, Oswestry, SY10 7QW</p><p>Halls are delighted to offer for sale this building plot.</p>' +
      '<p><a href="https://www.hallsgb.com/property_post_item/glan-y-gors/">Click To View Listing</a></p>' +
      '<p><a href="https://smallholdingsforsale.co.uk/planning-permission/">Read about planning</a></p>'
    const geo: string[] = []
    const c = new SmallholdingsClient({
      fetchImpl: fetchOf(
        [isNominatim, (u) => { geo.push(new URL(u).searchParams.get('q')!); return json([{ lat: '52.871', lon: '-3.141' }]) }],
        [isWp, () => json({ id: 59924, content: { rendered: html }, _embedded: { 'wp:featuredmedia': [{ source_url: 'https://x/full.png', media_details: { sizes: { medium: { source_url: 'https://x/med.png' } } } }] } })],
      ),
      cacheFile: tmpCache(),
      nominatimDelayMs: 0,
      pageDelayMs: 0,
    })
    const d = await c.detail(l)
    expect(d).toMatchObject({ agent: 'hallsgb.com', image: 'https://x/med.png', lat: 52.871, lon: -3.141, coordsPrecision: 'area' })
    expect(d!.description).toContain('Halls are delighted')
    expect(d!.description).not.toContain('Click To View Listing')
    expect(geo).toEqual(['SY10 7QW, UK'])
    expect(typeof d!.detailAt).toBe('number')
  })

  it('detail: 404 → null', async () => {
    const c = new SmallholdingsClient({ fetchImpl: fetchOf([isWp, () => json({}, 404)]), cacheFile: tmpCache(), nominatimDelayMs: 0, pageDelayMs: 0 })
    expect(await c.detail(l)).toBeNull()
  })
})
