import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  KleinanzeigenClient,
  SEED_LOCATIONS,
  PAGE,
  compile,
  searchUrl,
  unsupported,
  normalise,
  parseSearchPage,
  parseAdPage,
  parseCardDate,
  parsePrice,
  parseFacts,
  pickLocation,
  coverRing,
  planQueries,
  snapRadius,
  slugify,
  typeFromTitle,
  type SeedLocation,
} from '../property/kleinanzeigen.js'
import type { Ring } from '../property/geo.js'
import type { Criteria, Listing } from '../property/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => readFileSync(join(here, 'fixtures', name), 'utf8')
const listHtml = fixture('kleinanzeigen-list.html')
const adHtml = fixture('kleinanzeigen-ad.html')
const blockedHtml = fixture('kleinanzeigen-blocked.html')

const marburg = SEED_LOCATIONS.find((l) => l.name === 'Marburg')!
/** ~20 × 20 km box around Marburg — one r20 circle from the town itself. */
const marburgRing: Ring = [[8.63, 50.72], [8.91, 50.72], [8.91, 50.9], [8.63, 50.9], [8.63, 50.72]]
/** A smaller box inside the first. */
const marburgInner: Ring = [[8.72, 50.78], [8.82, 50.78], [8.82, 50.84], [8.72, 50.84], [8.72, 50.78]]
/** The zone's Hannover-area sliver (52.49 N 9.77 E), ~5 km across. */
const hannoverSliver: Ring = [[9.74, 52.47], [9.8, 52.47], [9.8, 52.51], [9.74, 52.51], [9.74, 52.47]]

/** The smoke criteria from the brief. */
const criteria: Criteria = { channel: 'buy', propertyType: 'house', maxPrice: 300000, minBedrooms: 2, minPlotArea: 800 }

interface Call {
  url: URL
  headers: Record<string, string>
  at: number
}

/** Stub fetch that records every call and answers from `respond(url)`. */
function stub(respond: (url: URL, call: Call) => string | Response, opts: ConstructorParameters<typeof KleinanzeigenClient>[1] = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call = { url, headers, at: Date.now() }
    calls.push(call)
    const r = respond(url, call)
    return r instanceof Response ? r : new Response(r, { status: 200, headers: { 'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'text/html' } })
  }) as unknown as typeof fetch
  return { calls, client: new KleinanzeigenClient(fetchImpl, { minIntervalMs: 0, cacheFile: null, ...opts }) }
}

/** Page number from a search URL (`seite:N` segment; 1 when absent). */
const pageOf = (url: URL) => Number(/seite:(\d+)/.exec(url.pathname)?.[1] ?? 1)

/** Synthetic SRP in the fixture's structure: `n` unique rows starting at id `from`, reporting `total`. */
function srp(total: number, from: number, n: number): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const id = from + i
    return `<article data-adid="${id}" data-href="/s-anzeige/haus-${id}/${id}-208-4825"><div><span>35037 Marburg</span><span>(3 km)</span></div><h3><a href="/s-anzeige/haus-${id}/${id}-208-4825">Einfamilienhaus ${id}</a></h3><p>Teaser text for the house number ${id}.</p><p>120 m² · 5 Zi.</p><p>${id} €</p><div><span>Von Privat</span></div></article>`
  }).join('\n')
  return `<!doctype html><html><body><span>${total.toLocaleString('de-DE')} Ergebnisse</span><ul>${rows}</ul></body></html>`
}

/** Answers page N of a `total`-row result set, 25 a page. */
const paged = (total: number) => (url: URL) => {
  const page = pageOf(url)
  const from = (page - 1) * PAGE
  return srp(total, 1000 + from, Math.max(0, Math.min(PAGE, total - from)))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pacing', () => {
  it('keeps every two requests at least minIntervalMs apart, across count() and newest()', async () => {
    vi.useFakeTimers()
    const { calls, client } = stub(paged(60), { minIntervalMs: 25_000 })
    const run = (async () => {
      await client.newest([marburgRing], criteria, 50)
      await client.count([marburgRing], criteria)
    })()
    await vi.runAllTimersAsync()
    await run
    // 2 pages for limit 50, then 1 page for the count.
    expect(calls).toHaveLength(3)
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(25_000)
  })

  it('never fires two requests together even when called concurrently', async () => {
    vi.useFakeTimers()
    const { calls, client } = stub(paged(25), { minIntervalMs: 25_000 })
    const run = Promise.all([client.count([marburgRing], criteria), client.count([marburgRing], criteria)])
    await vi.runAllTimersAsync()
    await run
    expect(calls).toHaveLength(2)
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(25_000)
  })

  it('stops at the run budget with truncated=true and keeps what it has; the window then frees up', async () => {
    vi.useFakeTimers()
    const { calls, client } = stub(paged(1000), { maxRequestsPerRun: 3, runWindowMs: 60 * 60 * 1000 })
    const r = await client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    expect(calls).toHaveLength(3)
    expect(r.truncated).toBe(true)
    expect(r.listings).toHaveLength(75)
    expect(r.total).toBe(1000)
    expect(client.budgetLeft()).toBe(0)
    // Anything that must make a request now refuses rather than waiting.
    await expect(client.count([marburgRing], criteria)).rejects.toThrow(/^kleinanzeigen: BUDGET/)
    await expect(client.detail(r.listings[0]!)).rejects.toThrow(/^kleinanzeigen: BUDGET/)
    expect(calls).toHaveLength(3)
    vi.advanceTimersByTime(60 * 60 * 1000 + 1)
    expect(client.budgetLeft()).toBe(3)
  })

  it('a spent budget makes newest() return empty+truncated without touching the network', async () => {
    const { calls, client } = stub(paged(25), { maxRequestsPerRun: 1 })
    await client.newest([marburgRing], criteria, 50)
    const r = await client.newest([marburgRing], criteria, 50)
    expect(calls).toHaveLength(1)
    expect(r.listings).toEqual([])
    expect(r.truncated).toBe(true)
  })
})

describe('BLOCKED', () => {
  it('a 403 block page throws kleinanzeigen: BLOCKED with the Ref#, and arms the back-off', async () => {
    vi.useFakeTimers()
    const { calls, client } = stub(() => new Response(blockedHtml, { status: 403 }), { blockBackoffMs: 30 * 60 * 1000 })
    await expect(client.newest([marburgRing], criteria, 50)).rejects.toThrow(/^kleinanzeigen: BLOCKED .*Ref#18\.5b281102\.1788805467\.1874166/)
    expect(calls).toHaveLength(1)
    // During the back-off nothing goes out — every entry point throws the same.
    await expect(client.count([marburgRing], criteria)).rejects.toThrow(/^kleinanzeigen: BLOCKED/)
    await expect(client.detail({ portal: 'kleinanzeigen', id: '1', url: 'https://www.kleinanzeigen.de/s-anzeige/x/1-208-4825', currency: 'EUR' })).rejects.toThrow(/^kleinanzeigen: BLOCKED/)
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1)
    await expect(client.newest([marburgRing], criteria, 50)).rejects.toThrow(/^kleinanzeigen: BLOCKED/)
    expect(calls).toHaveLength(2)
  })

  it('detects the block page even on a 200, and a 429', async () => {
    const soft = stub(() => blockedHtml)
    await expect(soft.client.newest([marburgRing], criteria, 50)).rejects.toThrow(/^kleinanzeigen: BLOCKED/)
    const rate = stub(() => new Response('', { status: 429 }))
    await expect(rate.client.count([marburgRing], criteria)).rejects.toThrow(/^kleinanzeigen: BLOCKED .*HTTP 429/)
    const akamai = stub(() => new Response('<html><head><title>Access Denied</title></head><body>You don\'t have permission</body></html>', { status: 200 }))
    await expect(akamai.client.count([marburgRing], criteria)).rejects.toThrow(/^kleinanzeigen: BLOCKED/)
  })

  it('other HTTP errors are plain errors, not blocks', async () => {
    const { client } = stub(() => new Response('oops', { status: 500 }))
    await expect(client.count([marburgRing], criteria)).rejects.toThrow(/^kleinanzeigen: HTTP 500/)
    expect(client.budgetLeft()).toBeGreaterThan(0)
  })
})

describe('request shape', () => {
  it('sends browser-like headers, de-DE, and keeps the site cookies', async () => {
    const { calls, client } = stub((url) => new Response(paged(60)(url), { status: 200, headers: { 'set-cookie': 'bm_sz=abc; Domain=.kleinanzeigen.de; Path=/' } }))
    await client.newest([marburgRing], criteria, 50)
    expect(calls).toHaveLength(2)
    const h = calls[0]!.headers
    expect(h['user-agent']).toMatch(/Chrome\/\d+/)
    expect(h['accept-language']).toMatch(/^de-DE/)
    expect(h.accept).toMatch(/text\/html/)
    expect(calls[0]!.headers.cookie).toBeUndefined()
    expect(calls[1]!.headers.cookie).toBe('bm_sz=abc')
  })

  it('follows a redirect once, as its own paced request', async () => {
    const { calls, client } = stub((url) =>
      url.pathname.includes('/anzeige:angebote/') ? new Response(null, { status: 301, headers: { location: url.pathname.replace('/anzeige:angebote/', '/angebote/') } }) : paged(25)(url),
    )
    const r = await client.newest([marburgRing], criteria, 50)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url.pathname).toContain('/angebote/')
    expect(r.listings).toHaveLength(25)
  })
})

describe('URL grammar', () => {
  it('compiles the smoke criteria to the note\'s grammar', () => {
    const url = searchUrl({ location: { ...marburg, id: 4825 }, radiusKm: 20 }, criteria)
    expect(url).toBe('https://www.kleinanzeigen.de/s-haus-kaufen/marburg/anzeige:angebote/preis::300000/c208l4825r20+haus_kaufen.zimmer_d:3,+haus_kaufen.grundstuecksflaeche_d:800,')
    expect(searchUrl({ location: { ...marburg, id: 4825 }, radiusKm: 20 }, criteria, 2)).toContain('/anzeige:angebote/preis::300000/seite:2/c208l4825r20+')
  })

  it('ranges are min,max; a single mapped subtype becomes haustyp_s; several are left to the post-filter', () => {
    expect(compile({ minPrice: 50000, maxPrice: 300000, minBedrooms: 2, maxBedrooms: 4, minFloorArea: 100, maxFloorArea: 250, minPlotArea: 2000, minYearBuilt: 1950, maxYearBuilt: 2000, houseSubtypes: ['farmhouse'], noBuyerFee: true })).toEqual({
      segments: ['anzeige:angebote', 'preis:50000:300000'],
      attributes: ['haus_kaufen.zimmer_d:3,5', 'haus_kaufen.qm_d:100,250', 'haus_kaufen.grundstuecksflaeche_d:2000,', 'haus_kaufen.baujahr_i:1950,2000', 'haus_kaufen.haustyp_s:bauernhaus', 'haus_kaufen.provision_s:nein'],
    })
    expect(compile({ houseSubtypes: ['detached', 'semi-detached', 'bungalow', 'villa', 'farmhouse'] }).attributes).toEqual([])
    expect(compile({})).toEqual({ segments: ['anzeige:angebote'], attributes: [] })
  })

  it('refuses what the category cannot express', () => {
    expect(() => compile({ channel: 'rent' })).toThrow(/rent/)
    expect(() => compile({ propertyType: 'flat' })).toThrow(/flat/)
  })

  it('slugs are cosmetic but tidy', () => {
    expect(slugify('Schwäbisch Hall')).toBe('schwaebisch-hall')
    expect(slugify('Halle (Saale)')).toBe('halle-saale')
    expect(slugify('Fürth')).toBe('fuerth')
  })
})

describe('rings → town + radius', () => {
  it('covers a ring from the seed town that needs the smallest radius, snapped up to a UI value', () => {
    const c = coverRing(marburgRing, SEED_LOCATIONS)!
    expect(c.location.name).toBe('Marburg')
    expect(c.radiusKm).toBeGreaterThan(10)
    expect(c.radiusKm).toBeLessThan(20)
    expect(snapRadius(c.radiusKm)).toBe(20)
    expect(coverRing(hannoverSliver, SEED_LOCATIONS)!.location.name).toBe('Hannover')
  })

  it('snapRadius rounds up to 5/10/20/30/50/100/150/200 and caps at 200', () => {
    expect([1, 5, 6, 21, 31, 51, 101, 151, 250].map(snapRadius)).toEqual([5, 5, 10, 30, 50, 100, 150, 200, 200])
  })

  it('planQueries: one query per town, largest radius wins', () => {
    const plan = planQueries([marburgRing, marburgInner, hannoverSliver], SEED_LOCATIONS)
    // Hannover's centre is ~13 km from the sliver, so the sliver needs r20 from there.
    expect(plan.map((p) => [p.location.name, p.radiusKm])).toEqual([['Marburg', 20], ['Hannover', 20]])
  })

  it('newest() over two nested rings issues one r20 query', async () => {
    const { calls, client } = stub(paged(10))
    await client.newest([marburgRing, marburgInner], criteria, 50)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.pathname).toMatch(/\/c208l4825r20\+/)
  })
})

describe('location ids', () => {
  const celle: SeedLocation = { name: 'Celle', state: 'Niedersachsen', lat: 52.624056, lon: 10.081052 }
  const celleRing: Ring = [[10.03, 52.6], [10.13, 52.6], [10.13, 52.65], [10.03, 52.65], [10.03, 52.6]]
  const lookup = { _0: 'Deutschland', _2811: 'Celle - Niedersachsen', _30001: 'Altstadt - Celle' }

  it('resolves a seed without an id through the autocomplete once, then from the cache', async () => {
    const { calls, client } = stub((url) => (url.pathname.endsWith('.json') ? JSON.stringify(lookup) : paged(5)(url)), { locations: [celle] })
    await client.newest([celleRing], criteria, 50)
    await client.newest([celleRing], criteria, 50)
    const lookups = calls.filter((c) => c.url.pathname === '/s-ort-empfehlungen.json')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]!.url.searchParams.get('query')).toBe('Celle')
    expect(lookups[0]!.headers.accept).toMatch(/json/)
    const searches = calls.filter((c) => c.url.pathname.startsWith('/s-haus-kaufen/'))
    expect(searches).toHaveLength(2)
    // The town centre sits inside this ~7 km ring → r5.
    for (const s of searches) expect(s.url.pathname).toMatch(/\/celle\/.*\/c208l2811r5\+/)
  })

  it('a town the site does not know falls to the next-best seed', async () => {
    const goslar: SeedLocation = { name: 'Goslar', state: 'Niedersachsen', lat: 51.9059936, lon: 10.4266284 }
    const { calls, client } = stub((url) => (url.pathname.endsWith('.json') ? (url.searchParams.get('query') === 'Celle' ? '{"_0":"Deutschland"}' : '{"_0":"Deutschland","_2000":"Goslar - Niedersachsen"}') : paged(5)(url)), {
      locations: [celle, goslar],
    })
    await client.newest([celleRing], criteria, 50)
    const searches = calls.filter((c) => c.url.pathname.startsWith('/s-haus-kaufen/'))
    expect(searches).toHaveLength(1)
    // Goslar is ~85 km from Celle: the sliver needs r100 from there.
    expect(searches[0]!.url.pathname).toMatch(/\/goslar\/.*\/c208l2000r100\+/)
  })

  it('pickLocation: exact name, right Bundesland, prefix fallback, never the country root', () => {
    expect(pickLocation({ _0: 'Deutschland', _5: 'Fürth - Hessen', _6: 'Fürth - Bayern', _7: 'Fürth - Nürnberg' }, { name: 'Fürth', state: 'Bayern' })).toEqual({ id: 6, label: 'Fürth - Bayern' })
    expect(pickLocation({ _0: 'Deutschland', _9: 'Freiburg - Baden-Württemberg', _10: 'Freiburg-Haslach - Freiburg' }, { name: 'Freiburg im Breisgau', state: 'Baden-Württemberg' })).toEqual({ id: 9, label: 'Freiburg - Baden-Württemberg' })
    expect(pickLocation({ _0: 'Deutschland' }, { name: 'Kerkrade', state: '' })).toBeNull()
    expect(pickLocation({}, { name: 'X', state: '' })).toBeNull()
  })
})

describe('pagination', () => {
  it('walks every page to the end when limit is Infinity', async () => {
    const { calls, client } = stub(paged(60))
    const r = await client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    expect(calls.map((c) => pageOf(c.url))).toEqual([1, 2, 3])
    expect(r.listings).toHaveLength(60)
    expect(r.total).toBe(60)
    expect(r.truncated).toBe(false)
  })

  it('stops at the limit and reports truncated only when rows were left behind', async () => {
    const capped = stub(paged(60))
    const r = await capped.client.newest([marburgRing], criteria, 50)
    expect(capped.calls).toHaveLength(2)
    expect(r.listings).toHaveLength(50)
    expect(r.truncated).toBe(true)
    const exact = stub(paged(50))
    const r2 = await exact.client.newest([marburgRing], criteria, 50)
    expect(exact.calls).toHaveLength(2)
    expect(r2.truncated).toBe(false)
  })

  it('a page that adds nothing new ends the walk (the portal repeating itself), as does an empty page', async () => {
    const repeat = stub(() => listHtml)
    const r = await repeat.client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    // Fixture claims 47 results but every page is the same 4 rows → page 2 adds nothing.
    expect(repeat.calls).toHaveLength(2)
    expect(r.listings).toHaveLength(4)
    expect(r.truncated).toBe(false)
    const empty = stub((url) => (pageOf(url) === 1 ? srp(500, 1, 25) : srp(500, 1, 0)))
    const r2 = await empty.client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    expect(empty.calls).toHaveLength(2)
    expect(r2.listings).toHaveLength(25)
  })

  it('reuses a completed pull for a smaller circle on the same town within the hour (fullSync calls once per ring)', async () => {
    const { calls, client } = stub(paged(30))
    const a = await client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    const b = await client.newest([marburgInner], criteria, Number.POSITIVE_INFINITY)
    expect(calls).toHaveLength(2)
    expect(b.listings).toHaveLength(30)
    expect(b.total).toBe(a.total)
    // A skim (finite limit) is never served from the reuse cache.
    await client.newest([marburgInner], criteria, 50)
    expect(calls).toHaveLength(4)
  })

  it('count() is one page-1 request per query, summing the portal totals', async () => {
    const { calls, client } = stub((url) => (url.pathname.endsWith('.json') ? '{"_0":"Deutschland","_3161":"Hannover - Niedersachsen"}' : paged(222)(url)))
    expect(await client.count([marburgRing, hannoverSliver], criteria)).toBe(444)
    expect(calls.filter((c) => c.url.pathname.startsWith('/s-haus-kaufen/'))).toHaveLength(2)
  })
})

describe('parseSearchPage over the fixture', () => {
  const page = parseSearchPage(listHtml)

  it('reads the total, dedupes the TOP duplicate on data-adid, sees the next link', () => {
    expect(page.total).toBe(47)
    expect(page.rows.map((r) => r.adid)).toEqual(['3500056603', '3498812204', '3501100777', '3497003310'])
    expect(page.hasNext).toBe(true)
  })

  it('splits the card into address / distance / title / teaser / facts / price / seller', () => {
    const r = page.rows[0]!
    expect(r.href).toBe('/s-anzeige/einfamilienhaus-mit-grossem-garten-in-rabenau/3500056603-208-4825')
    expect(r.address).toBe('35466 Rabenau')
    expect(r.plz).toBe('35466')
    expect(r.distanceKm).toBe(17)
    expect(r.title).toBe('Einfamilienhaus mit großem Garten in Rabenau')
    expect(r.summary).toMatch(/^Freistehendes Haus aus 1962/)
    expect(r.factsText).toBe('180 m² · 7 Zi.')
    expect(r.priceText).toBe('199.999 € VB')
    expect(r.sellerText).toBe('Von Privat')
    expect(r.top).toBe(true)
    expect(r.image).toMatch(/^https:\/\/img\.kleinanzeigen\.de\//)
  })
})

describe('normalise() over the fixture', () => {
  const rows = parseSearchPage(listHtml).rows.map((r) => normalise(r)).filter((l): l is Listing => l !== null)

  it('every row is a PLZ-area listing without coordinates until detail() runs', () => {
    expect(rows).toHaveLength(4)
    for (const l of rows) {
      expect(l.portal).toBe('kleinanzeigen')
      expect(l.currency).toBe('EUR')
      expect(l.coordsPrecision).toBe('area')
      expect(l.lat).toBeUndefined()
      expect(l.plotArea).toBeUndefined()
      expect(l.url).toMatch(/^https:\/\/www\.kleinanzeigen\.de\/s-anzeige\//)
    }
  })

  it('private Einfamilienhaus: VB price kept, Zimmer − 1 bedrooms, floor area, anonymous seller', () => {
    const l = rows[0]!
    expect(l.id).toBe('3500056603')
    expect(l.price).toBe(199999)
    expect(l.bedrooms).toBe(6)
    expect(l.floorArea).toBe(180)
    expect(l.propertyType).toBe('Einfamilienhaus')
    expect(l.address).toBe('35466 Rabenau')
    expect(l.agent).toBe('privat')
    expect(l.summary).toBe('Einfamilienhaus mit großem Garten in Rabenau — Freistehendes Haus aus 1962, teilsaniert, mit Scheune und 1.250 m² Grundstück am Ortsrand. Ölheizung, neue Fenster 2019, Keller...')
    expect(l.listedAt).toBeUndefined()
  })

  it('dealer row keeps the shop name and the Bauernhaus type', () => {
    const l = rows[1]!
    expect(l.agent).toBe('Sparkasse Marburg-Biedenkopf')
    expect(l.propertyType).toBe('Bauernhaus')
    expect(l.price).toBe(288000)
    expect(l.bedrooms).toBe(8)
    expect(l.floorArea).toBe(300)
  })

  it('"VB" alone is no price; missing facts stay undefined', () => {
    const l = rows[2]!
    expect(l.price).toBeUndefined()
    expect(l.bedrooms).toBeUndefined()
    expect(l.floorArea).toBeUndefined()
    expect(l.propertyType).toBe('Haus')
  })

  it('€1 placeholder and Resthof are surfaced as-is for the hub\'s own filters', () => {
    const l = rows[3]!
    expect(l.price).toBe(1)
    expect(l.propertyType).toBe('Resthof')
    expect(l.bedrooms).toBe(3)
    expect(l.agent).toBe('Argetra GmbH')
    expect(l.summary).toContain('Zwangsversteigerung')
  })

  it('helpers: price, facts, card dates, title types', () => {
    expect(parsePrice('199.999 € VB')).toBe(199999)
    expect(parsePrice('1.250.000 €')).toBe(1250000)
    expect(parsePrice('VB')).toBeUndefined()
    expect(parsePrice('Zu verschenken')).toBeUndefined()
    expect(parseFacts('180 m² · 7 Zi.')).toEqual({ floorArea: 180, rooms: 7 })
    expect(parseFacts('4 Zi.')).toEqual({ floorArea: undefined, rooms: 4 })
    expect(parseFacts('1.020 m²')).toEqual({ floorArea: 1020, rooms: undefined })
    const now = new Date('2026-09-07T18:00:00Z')
    expect(parseCardDate('Heute, 12:34', now)).toBe('2026-09-07T12:34:00.000Z')
    expect(parseCardDate('Gestern, 09:10', now)).toBe('2026-09-06T09:10:00.000Z')
    expect(parseCardDate('06.09.2026', now)).toBe('2026-09-06T00:00:00.000Z')
    expect(parseCardDate('Von Privat', now)).toBeUndefined()
    expect(typeFromTitle('Schönes Bauernhaus mit Scheune')).toBe('Bauernhaus')
    expect(typeFromTitle('DHH in ruhiger Lage')).toBeUndefined()
    expect(typeFromTitle('Doppelhaushälfte in Kirchhain')).toBe('Doppelhaushälfte')
  })
})

describe('detail()', () => {
  const row: Listing = { portal: 'kleinanzeigen', id: '3498812204', url: 'https://www.kleinanzeigen.de/s-anzeige/bauernhaus-mit-nebengebaeuden-und-weide/3498812204-208-4825', currency: 'EUR' }

  it('reads the ad page: PLZ-centroid coordinates, plot, Schlafzimmer, Haustyp, date, description, features, seller', async () => {
    const { calls, client } = stub(() => adHtml)
    const d = (await client.detail(row))!
    expect(calls[0]!.url.toString()).toBe(row.url)
    expect(d.lat).toBeCloseTo(50.898765, 6)
    expect(d.lon).toBeCloseTo(8.723456, 6)
    expect(d.coordsPrecision).toBe('area')
    expect(d.plotArea).toBe(4200)
    expect(d.floorArea).toBe(300)
    expect(d.bedrooms).toBe(6)
    expect(d.bathrooms).toBe(3)
    expect(d.propertyType).toBe('Bauernhaus')
    expect(d.price).toBe(288000)
    expect(d.listedAt).toBe('2026-09-06T00:00:00.000Z')
    expect(d.address).toBe('35083 Hessen - Wetter (Hessen)')
    expect(d.agent).toBe('Sparkasse Marburg-Biedenkopf')
    expect(d.keyFeatures).toEqual(['Etagen: 2', 'Baujahr: 1900', 'Provision: Mit Provision', 'Keller', 'Garage/Stellplatz', 'Garten'])
    expect(d.description).toContain('davon ca. 3.000 m² Weide.\nSanierungsbedarf')
    expect(d.detailAt).toBeTypeOf('number')
  })

  it('gone ads → null (404, "Gelöscht •", sold label); a reserved ad is still a listing', async () => {
    const notFound = stub(() => new Response('', { status: 404 }))
    expect(await notFound.client.detail(row)).toBeNull()
    const deleted = adHtml.replace('Reserviert • Bauernhaus', 'Gelöscht • Bauernhaus')
    expect(parseAdPage(deleted)).toBeNull()
    expect(parseAdPage(adHtml.replace('<h1 id="viewad-title"', '<div data-soldlabel="Nicht mehr verfügbar"></div><h1 id="viewad-title"'))).toBeNull()
    expect(parseAdPage(adHtml)!.reserved).toBe(true)
  })

  it('a private seller stays "privat"; Zimmer − 1 when there is no Schlafzimmer line', () => {
    const priv = adHtml
      .replace(/<aside class="userprofile-vip">[\s\S]*?<\/aside>/, '<aside class="userprofile-vip"><span class="userprofile-vip-name">Max M.</span><span>Privater Nutzer</span></aside>')
      .replace(/<li class="addetailslist--detail">Schlafzimmer.*?<\/li>\n/, '')
    const d = parseAdPage(priv)!
    expect(d.agent).toBe('privat')
    expect(d.bedrooms).toBeUndefined()
    expect(d.rooms).toBe(9)
  })

  it('learns the PLZ centroid and applies it to later cards with the same PLZ', async () => {
    const { client } = stub(() => adHtml)
    await client.detail(row)
    const card = parseSearchPage(listHtml).rows.find((r) => r.plz === '35083')!
    const l = client.toListing(card)!
    expect(l.lat).toBeCloseTo(50.8988, 4)
    expect(l.lon).toBeCloseTo(8.7235, 4)
    expect(l.coordsPrecision).toBe('area')
    const other = client.toListing(parseSearchPage(listHtml).rows.find((r) => r.plz === '35466')!)!
    expect(other.lat).toBeUndefined()
  })
})

describe('unsupported', () => {
  it('lists everything the portal cannot filter server-side', () => {
    expect(unsupported({ houseSubtypes: ['detached', 'semi-detached', 'bungalow', 'villa', 'farmhouse'], minBathrooms: 1, freeholdOnly: true, excludeCommonhold: true, mustHaveGarden: true, mustHaveParking: true, keywords: ['Scheune'], excludeSchemes: true, excludeAuctions: true, excludeNewBuild: true, maxDaysSinceAdded: 7, excludePriceOnRequest: true, minInternetMbit: 50 })).toEqual([
      'houseSubtypes',
      'minBathrooms',
      'freeholdOnly',
      'excludeCommonhold',
      'mustHaveGarden',
      'mustHaveParking',
      'keywords',
      'minInternetMbit',
      'excludeSchemes',
      'excludeAuctions',
      'excludeNewBuild',
      'maxDaysSinceAdded',
      'excludePriceOnRequest',
    ])
    // Price, plot, rooms, floor area, year and a single subtype ARE server-side.
    expect(unsupported({ maxPrice: 300000, minPlotArea: 800, minBedrooms: 2, minFloorArea: 100, minYearBuilt: 1950, houseSubtypes: ['farmhouse'] })).toEqual([])
    expect(unsupported({ houseSubtypes: ['land'] })).toEqual(['houseSubtypes'])
  })

  it('newest() reports it on the result', async () => {
    const { client } = stub(paged(5))
    const r = await client.newest([marburgRing], { ...criteria, mustHaveGarden: true, excludeAuctions: true }, 50)
    expect(r.unsupported).toEqual(['mustHaveGarden', 'excludeAuctions'])
  })
})
