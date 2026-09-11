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
  type RawRow,
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

  it('resolves at most maxLookupsPerCall unknown towns per call; the rest fall to a resolved town and resolve on later calls', async () => {
    // Three rings around three unknown towns plus Marburg (known id). Budget: 1 lookup per call.
    const goslar: SeedLocation = { name: 'Goslar', state: 'Niedersachsen', lat: 51.9059936, lon: 10.4266284 }
    const goslarRing: Ring = [[10.38, 51.88], [10.48, 51.88], [10.48, 51.93], [10.38, 51.93], [10.38, 51.88]]
    const ids: Record<string, string> = { Celle: '{"_0":"Deutschland","_2811":"Celle - Niedersachsen"}', Goslar: '{"_0":"Deutschland","_2000":"Goslar - Niedersachsen"}' }
    const { calls, client } = stub((url) => (url.pathname.endsWith('.json') ? ids[url.searchParams.get('query')!]! : paged(5)(url)), {
      locations: [marburg, celle, goslar],
      maxLookupsPerCall: 1,
    })
    await client.newest([marburgInner, celleRing, goslarRing], criteria, 50)
    const lookups = () => calls.filter((c) => c.url.pathname === '/s-ort-empfehlungen.json').map((c) => c.url.searchParams.get('query'))
    expect(lookups()).toHaveLength(1)
    // The un-looked-up town's ring was served from the nearest resolved town (Celle, ~85 km → r100), not skipped.
    const searches1 = calls.filter((c) => c.url.pathname.startsWith('/s-haus-kaufen/')).map((c) => c.url.pathname)
    expect(searches1).toHaveLength(2)
    expect(searches1.some((p) => /\/celle\/.*\/c208l2811r100\+/.test(p))).toBe(true)
    await client.newest([marburgInner, celleRing, goslarRing], criteria, 50)
    expect(lookups()).toHaveLength(2)
    expect(new Set(lookups())).toEqual(new Set(['Celle', 'Goslar']))
    // Third call: everything is cached, no lookups, three tight queries.
    const before = calls.length
    await client.newest([marburgInner, celleRing, goslarRing], criteria, 50)
    expect(lookups()).toHaveLength(2)
    const searches3 = calls.slice(before).filter((c) => c.url.pathname.startsWith('/s-haus-kaufen/')).map((c) => c.url.pathname)
    expect(searches3).toHaveLength(3)
    expect(searches3.some((p) => /\/celle\/.*\/c208l2811r5\+/.test(p))).toBe(true)
    expect(searches3.some((p) => /\/goslar\/.*\/c208l2000r5\+/.test(p))).toBe(true)
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
    // Claims 500 results but every page is the same 25 rows → page 2 adds nothing.
    const repeat = stub(() => srp(500, 1, 25))
    const r = await repeat.client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    expect(repeat.calls).toHaveLength(2)
    expect(r.listings).toHaveLength(25)
    expect(r.truncated).toBe(false)
    // The real page: 5 in-radius rows, total 5 → one request, complete.
    const real = stub(() => listHtml)
    const r3 = await real.client.newest([marburgRing], criteria, Number.POSITIVE_INFINITY)
    expect(real.calls).toHaveLength(1)
    expect(r3.listings).toHaveLength(5)
    expect(r3.total).toBe(5)
    expect(r3.truncated).toBe(false)
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

describe('parseSearchPage over the fixture (real page, Marburg r10, 2026-09-08)', () => {
  const page = parseSearchPage(listHtml)

  it('reads the in-radius total from "1 - 5 von 5 Ergebnissen" and stops at the "Weitere Ergebnisse in anderen Orten" padding', () => {
    expect(page.total).toBe(5)
    // The page carries 15 <article>s; the last 10 are out-of-radius padding.
    expect(page.rows).toHaveLength(5)
    expect(page.rows.map((r) => r.adid)).toEqual(['3377018987', '3449390083', '2435726948', '3478715051', '3446753326'])
    expect(page.hasNext).toBe(false)
  })

  it('splits the card into address / distance / title / teaser / facts / price / seller', () => {
    const r = page.rows[1]!
    expect(r.href).toBe('/s-anzeige/ruhiges-familienparadies-auf-grossem-grundstueck-/3449390083-208-4828')
    expect(r.address).toBe('35096 Weimar (Lahn)')
    expect(r.plz).toBe('35096')
    expect(r.distanceKm).toBe(9)
    expect(r.title).toBe('Ruhiges Familienparadies auf großem Grundstück!')
    expect(r.summary).toMatch(/^In Weimar \(Lahn\) - Niederwalgern bieten wir/)
    expect(r.factsText).toBe('135 m² · 6 Zi.')
    expect(r.priceText).toBe('295.000 €')
    expect(r.sellerText).toBe('Sparkasse Marburg-Biedenkopf')
    expect(r.top).toBe(false)
    expect(r.image).toMatch(/^https:\/\/img\.kleinanzeigen\.de\//)
  })

  it('"(ca. 10 km)" distances and "VB" prices parse too', () => {
    expect(page.rows[0]!.distanceKm).toBe(10)
    expect(page.rows[2]!.priceText).toBe('285.000 € VB')
  })
})

describe('normalise() over the fixture', () => {
  const rows = parseSearchPage(listHtml).rows.map((r) => normalise(r)).filter((l): l is Listing => l !== null)

  it('every row is a PLZ-area listing; normalise() alone carries no coordinates (toListing adds the PLZ centroid)', () => {
    expect(rows).toHaveLength(5)
    for (const l of rows) {
      expect(l.portal).toBe('kleinanzeigen')
      expect(l.currency).toBe('EUR')
      expect(l.coordsPrecision).toBe('area')
      expect(l.lat).toBeUndefined()
      expect(l.plotArea).toBeUndefined()
      expect(l.url).toMatch(/^https:\/\/www\.kleinanzeigen\.de\/s-anzeige\//)
      // Cards carry no date in this layout.
      expect(l.listedAt).toBeUndefined()
    }
  })

  it('dealer row: VB price kept, Zimmer − 1 bedrooms, floor area, shop name', () => {
    const l = rows[2]!
    expect(l.id).toBe('2435726948')
    expect(l.price).toBe(285000)
    expect(l.bedrooms).toBe(6)
    expect(l.floorArea).toBe(220)
    expect(l.propertyType).toBe('Vierseitenhof')
    expect(l.address).toBe('35274 Kirchhain')
    expect(l.agent).toBe('Schomann Immobilienvermittlung')
    expect(l.summary).toBe('Vierseitenhof (Einzelkulturdenkmal) in Kirchhain Großseelheim — Hilfreiche Informationen zum Denkmalschutz finden Sie...')
  })

  it('type from the title where there is one; undefined when the title has no type word', () => {
    expect(rows[4]!.propertyType).toBe('Einfamilienhaus')
    expect(rows[3]!.propertyType).toBe('Zweifamilienhaus')
    expect(rows[0]!.propertyType).toBeUndefined()
    expect(rows[0]!.agent).toBe('Sparkasse Marburg-Biedenkopf')
  })

  const syntheticRow = (over: Partial<RawRow>): RawRow => ({ adid: '1', href: '/s-anzeige/x/1-208-4825', title: 'Haus', address: '35037 Marburg', plz: '35037', ...over })

  it('private seller → "privat"; "VB" alone is no price; missing facts stay undefined', () => {
    const l = normalise(syntheticRow({ sellerText: 'Von Privat', priceText: 'VB' }))!
    expect(l.agent).toBe('privat')
    expect(l.price).toBeUndefined()
    expect(l.bedrooms).toBeUndefined()
    expect(l.floorArea).toBeUndefined()
    expect(l.propertyType).toBe('Haus')
  })

  it('€1 placeholder and Resthof are surfaced as-is for the hub\'s own filters', () => {
    const l = normalise(syntheticRow({ title: 'Resthof — Zwangsversteigerung', priceText: '1 €', factsText: '4 Zi.', sellerText: 'Argetra GmbH', summary: 'Zwangsversteigerung am Amtsgericht.' }))!
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

describe('detail() (real ad page 3377018987, 2026-09-08)', () => {
  const row: Listing = { portal: 'kleinanzeigen', id: '3377018987', url: 'https://www.kleinanzeigen.de/s-anzeige/zwei-haeuser-zum-preis-von-einem-/3377018987-208-4826', currency: 'EUR' }

  it('reads the ad page: PLZ-centroid coordinates, plot, Schlafzimmer, Haustyp, date, description, features, seller', async () => {
    const { calls, client } = stub(() => adHtml)
    const d = (await client.detail(row))!
    expect(calls[0]!.url.toString()).toBe(row.url)
    expect(d.lat).toBeCloseTo(50.898111, 5)
    expect(d.lon).toBeCloseTo(8.675269, 5)
    expect(d.coordsPrecision).toBe('area')
    expect(d.plotArea).toBe(867)
    expect(d.floorArea).toBe(300)
    expect(d.bedrooms).toBe(6)
    expect(d.bathrooms).toBe(3)
    expect(d.propertyType).toBe('Bauernhaus')
    expect(d.price).toBe(288000)
    expect(d.listedAt).toBe('2026-09-06T00:00:00.000Z')
    expect(d.address).toBe('35083 Hessen - Wetter (Hessen)')
    // ".userprofile-vip" reads "Sparkasse Marburg-Biedenkopf - Hendrik Hinspeter": business only.
    expect(d.agent).toBe('Sparkasse Marburg-Biedenkopf')
    expect(d.keyFeatures).toEqual(['Etagen: 2', 'Baujahr: 2000', 'Provision: Mit Provision', 'Keller', 'Garage/Stellplatz'])
    expect(d.description).toMatch(/^In Wetter-Oberndorf können wir Ihnen dieses interessante Zweifamilienhaus zum Kauf anbieten\.\n\nDie Immobilie/)
    expect(d.detailAt).toBeTypeOf('number')
  })

  it('a live ad is NOT "gone" despite data-soldlabel on its <h1> — that attribute is on every ad', () => {
    expect(adHtml).toMatch(/<h1[^>]*id="viewad-title"[^>]*data-soldlabel="Nicht mehr verfügbar"/)
    expect(parseAdPage(adHtml)).not.toBeNull()
    expect(parseAdPage(adHtml)!.reserved).toBe(false)
  })

  it('gone ads → null (404, "Gelöscht •" title, a rendered sold badge); a reserved ad is still a listing', async () => {
    const notFound = stub(() => new Response('', { status: 404 }))
    expect(await notFound.client.detail(row)).toBeNull()
    const retitle = (prefix: string) => adHtml.replace(/(<h1[^>]*id="viewad-title"[^>]*>)/, `$1${prefix} • `)
    expect(parseAdPage(retitle('Gelöscht'))).toBeNull()
    expect(parseAdPage(retitle('Reserviert'))!.reserved).toBe(true)
    const badged = adHtml.replace(/(<h1[^>]*id="viewad-title"[^>]*>[\s\S]*?<\/h1>)/, '$1<span class="badge-soldlabel">Nicht mehr verfügbar</span>')
    expect(parseAdPage(badged)).toBeNull()
  })

  it('a private seller stays "privat"; Zimmer − 1 when there is no Schlafzimmer line', () => {
    const priv = adHtml
      .replace(/(<span[^>]*userprofile-vip-details-text[^>]*>)Gewerblicher Nutzer/, '$1Privater Nutzer')
      .replace(/<li class="addetailslist--detail">\s*Schlafzimmer[\s\S]*?<\/li>/, '')
    const d = parseAdPage(priv)!
    expect(d.agent).toBe('privat')
    expect(d.bedrooms).toBeUndefined()
    expect(d.rooms).toBe(9)
    expect(parseAdPage(adHtml)!.bedrooms).toBe(6)
  })

  it('every card gets its PLZ centroid from the bundled GeoNames table at once; an ad page read refines it to the site\'s own centroid', async () => {
    const { client } = stub(() => adHtml)
    const cards = parseSearchPage(listHtml).rows
    // Before any ad page: GeoNames centroid for 35083 (Wetter) and 35096 (Weimar/Lahn).
    const fresh = client.toListing(cards.find((r) => r.plz === '35083')!)!
    expect(fresh.lat).toBeCloseTo(50.9025, 3)
    expect(fresh.lon).toBeCloseTo(8.7237, 3)
    expect(fresh.coordsPrecision).toBe('area')
    expect(client.toListing(cards.find((r) => r.plz === '35096')!)!.lat).toBeCloseTo(50.7406, 1)
    // After detail(): the site's og: centroid wins for that PLZ (~3.5 km from GeoNames').
    await client.detail(row)
    const refined = client.toListing(cards.find((r) => r.plz === '35083')!)!
    expect(refined.lat).toBeCloseTo(50.8981, 4)
    expect(refined.lon).toBeCloseTo(8.6753, 4)
    // Unknown PLZ → no coordinates.
    expect(client.toListing({ adid: '9', href: '/s-anzeige/x/9-208-1', address: '00000 Nirgendwo', plz: '00000' })!.lat).toBeUndefined()
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
