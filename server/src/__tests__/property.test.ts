import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePolyline, simplifyToLatLng, outerRings, ringsInCountry, pointInGeometry } from '../property/geo.js'
import { PropertySearchStore, PORTAL_BY_COUNTRY, withInterestedCarried } from '../property/store.js'
import { postFilter, applyNotifyGate, PropertySync } from '../property/sync.js'
import { PropertyInventoryStore, fetchAll } from '../property/inventory.js'
import { groupDuplicates } from '../property/dedupe.js'
import { coverRingWithCircles, nearGeometry, haversineKm } from '../property/geo.js'
import { normaliseHouseType, notifyRejection, needsAirportDistance, withoutAirportGate } from '../property/notify-filter.js'
import { asEntryArray, ImmoScout24Client } from '../property/immoscout24.js'
import { isTooSmall, ImmobiliareClient } from '../property/immobiliare.js'
import { RightmoveClient, unflatten, detailFields } from '../property/rightmove.js'
import { plotAreaFromText, listingKind, normaliseTenure } from '../property/land.js'
import { normalise as otmNormalise } from '../property/onthemarket.js'
import { boxAround } from '../property/geo.js'
import { nextWeekdayMorningUtc } from '../property/airport-distance.js'
import type { Listing } from '../property/types.js'

const dirs: string[] = []
const tmpStore = (): PropertySearchStore => {
  const dir = mkdtempSync(join(tmpdir(), 'property-test-'))
  dirs.push(dir)
  return new PropertySearchStore(join(dir, 'searches.json'))
}
const tmpInventory = (): PropertyInventoryStore => {
  const dir = mkdtempSync(join(tmpdir(), 'property-inv-'))
  dirs.push(dir)
  return new PropertyInventoryStore(dir)
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const listing = (id: string, over: Partial<Listing> = {}): Listing => ({
  portal: 'rightmove',
  id,
  url: `https://example.test/${id}`,
  currency: 'GBP',
  ...over,
})

describe('encodePolyline', () => {
  it('matches the reference implementation', () => {
    // The canonical Google example.
    expect(encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]])).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
  })
})

describe('simplifyToLatLng', () => {
  const ring = Array.from({ length: 400 }, (_, i) => {
    const t = (i / 400) * Math.PI * 2
    return [8 + Math.cos(t), 50 + Math.sin(t)] as [number, number]
  })

  it('swaps [lng,lat] to [lat,lng]', () => {
    const [first] = simplifyToLatLng([[8, 50], [9, 51], [10, 52]], 90, false)
    expect(first).toEqual([50, 8])
  })

  it('gets under the vertex cap and closes the ring when asked', () => {
    const pts = simplifyToLatLng(ring, 90, true)
    expect(pts.length).toBeLessThanOrEqual(90)
    expect(pts[0]).toEqual(pts[pts.length - 1])
  })

  it('leaves the ring open when asked', () => {
    const pts = simplifyToLatLng([...ring, ring[0]!], 90, false)
    expect(pts[0]).not.toEqual(pts[pts.length - 1])
  })
})

describe('outerRings', () => {
  it('returns outer rings largest-first and drops holes', () => {
    const small: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    const big: [number, number][] = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]
    const hole: [number, number][] = [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]
    const rings = outerRings({ type: 'MultiPolygon', coordinates: [[small], [big, hole]] })
    expect(rings).toHaveLength(2)
    expect(rings[0]).toEqual(big)
  })
})

describe('pointInGeometry', () => {
  const square = { type: 'Polygon', coordinates: [[[-1, 51], [1, 51], [1, 53], [-1, 53], [-1, 51]]] }

  it('true for a point inside the ring', () => {
    expect(pointInGeometry([0, 52], square)).toBe(true)
  })

  it('false for a point outside the ring', () => {
    expect(pointInGeometry([10, 52], square)).toBe(false)
  })

  it('checks every ring of a MultiPolygon, not just the first', () => {
    const other = { type: 'Polygon', coordinates: [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]] }
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates, other.coordinates] }
    expect(pointInGeometry([11, 11], multi)).toBe(true)
    expect(pointInGeometry([0, 52], multi)).toBe(true)
    expect(pointInGeometry([50, 50], multi)).toBe(false)
  })

  it('false inside a hole, true elsewhere in the same polygon', () => {
    const hole: [number, number][] = [[-0.5, 51.5], [0.5, 51.5], [0.5, 52.5], [-0.5, 52.5], [-0.5, 51.5]]
    const withHole = { type: 'Polygon', coordinates: [square.coordinates[0], hole] }
    expect(pointInGeometry([0, 52], withHole)).toBe(false)
    expect(pointInGeometry([0.8, 52.8], withHole)).toBe(true)
    const multi = { type: 'MultiPolygon', coordinates: [withHole.coordinates] }
    expect(pointInGeometry([0, 52], multi)).toBe(false)
  })
})

describe('ringsInCountry', () => {
  it('keeps only rings overlapping the country bbox', () => {
    const uk: [number, number][] = [[-1, 51], [0, 51], [0, 52], [-1, 52], [-1, 51]]
    const it: [number, number][] = [[11, 44], [12, 44], [12, 45], [11, 45], [11, 44]]
    const geometry = { type: 'MultiPolygon', coordinates: [[uk], [it]] }
    expect(ringsInCountry(geometry, 'UK')).toHaveLength(1)
    expect(ringsInCountry(geometry, 'IT')).toHaveLength(1)
    // Neither ring is anywhere near Germany.
    expect(ringsInCountry(geometry, 'DE')).toHaveLength(0)
  })
})

describe('PORTAL_BY_COUNTRY', () => {
  it('maps each country to its one portal', () => {
    expect(PORTAL_BY_COUNTRY).toEqual({ UK: 'rightmove', DE: 'immoscout24', IT: 'immobiliare' })
  })
})

describe('PropertySearchStore.recordPoll', () => {
  it('seeds silently on the first poll, then reports only genuinely-new ids', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'where-to-move/livable-zone' })
    expect(s.seeded).toBe(false)

    const first = store.recordPoll(s.id, { total: 10, listings: [listing('a'), listing('b')] })
    expect(first?.seeding).toBe(true)
    expect(first?.fresh.map((l) => l.id)).toEqual(['a', 'b'])
    expect(first?.current.seeded).toBe(true)

    const second = store.recordPoll(s.id, { total: 11, listings: [listing('b'), listing('c')] })
    expect(second?.seeding).toBe(false)
    expect(second?.fresh.map((l) => l.id)).toEqual(['c'])
  })

  it('does not mark seen or seeded when the poll errored', () => {
    const store = tmpStore()
    const s = store.create({ country: 'DE', layer: 'l' })
    const r = store.recordPoll(s.id, { listings: [listing('a')], error: 'boom' })
    expect(r?.fresh).toEqual([])
    expect(r?.current.seeded).toBe(false)
    expect(r?.current.lastError).toBe('boom')
    // The failed poll's ids must not be swallowed — they alert once it recovers.
    expect(store.recordPoll(s.id, { listings: [listing('a')] })?.current.seenIds).toEqual(['a'])
  })

  it('keeps a total history but leaves lastResults alone on an empty page', () => {
    const store = tmpStore()
    const s = store.create({ country: 'IT', layer: 'l' })
    store.recordPoll(s.id, { total: 5, listings: [listing('a')] })
    const r = store.recordPoll(s.id, { total: 7, listings: [] })
    expect(r?.current.history?.map((h) => h.total)).toEqual([5, 7])
    expect(r?.current.lastResults?.map((l) => l.id)).toEqual(['a'])
  })
})

describe('PropertySearchStore.update', () => {
  it('re-seeds when the criteria change, so an edit cannot storm alerts', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l', criteria: { maxPrice: 500000 } })
    store.recordPoll(s.id, { listings: [listing('a')] })

    const next = store.update(s.id, { criteria: { maxPrice: 900000 } })
    expect(next?.seeded).toBe(false)
    expect(next?.seenIds).toEqual([])
  })

  it('re-seeds when the layer or country change', () => {
    const store = tmpStore()
    const a = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(a.id, { listings: [listing('x')] })
    expect(store.update(a.id, { layer: 'other' })?.seeded).toBe(false)

    const b = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(b.id, { listings: [listing('x')] })
    expect(store.update(b.id, { country: 'DE' })?.seeded).toBe(false)
  })

  it('leaves the seen set intact for cosmetic edits', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l', criteria: { maxPrice: 1 } })
    store.recordPoll(s.id, { listings: [listing('a')] })
    const next = store.update(s.id, { label: 'renamed', criteria: { maxPrice: 1 } })
    expect(next?.seeded).toBe(true)
    expect(next?.seenIds).toEqual(['a'])
  })

  it('does not touch dismissedIds even when criteria change re-seeds seenIds', () => {
    // A dismissal is about the listing, not about whether the current query
    // still matches it — unlike seenIds, it must survive a criteria edit.
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l', criteria: { maxPrice: 500000 } })
    store.recordPoll(s.id, { listings: [listing('a')] })
    store.dismiss(s.id, 'a')
    const next = store.update(s.id, { criteria: { maxPrice: 900000 } })
    expect(next?.seeded).toBe(false)
    expect(next?.dismissedIds).toEqual(['a'])
  })
})

describe('PropertySearchStore.dismiss', () => {
  it('adds and removes a listing id, idempotently', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l' })
    expect(store.dismiss(s.id, 'a')?.dismissedIds).toEqual(['a'])
    expect(store.dismiss(s.id, 'a')?.dismissedIds).toEqual(['a'])
    expect(store.dismiss(s.id, 'b')?.dismissedIds?.sort()).toEqual(['a', 'b'])
    expect(store.dismiss(s.id, 'a', false)?.dismissedIds).toEqual(['b'])
  })

  it('returns undefined for an unknown search', () => {
    const store = tmpStore()
    expect(store.dismiss('ps_nope', 'a')).toBeUndefined()
  })
})

describe('PropertySearchStore.review', () => {
  it('interested and dismissed are mutually exclusive; none clears both', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l' })
    let r = store.review(s.id, 'a', 'interested')!
    expect(r.interestedIds).toEqual(['a'])
    expect(r.dismissedIds).toEqual([])
    r = store.review(s.id, 'a', 'dismissed')!
    expect(r.interestedIds).toEqual([])
    expect(r.dismissedIds).toEqual(['a'])
    r = store.review(s.id, 'a', 'interested')!
    expect(r.dismissedIds).toEqual([])
    expect(r.interestedIds).toEqual(['a'])
    r = store.review(s.id, 'a', 'none')!
    expect(r.interestedIds).toEqual([])
    expect(r.dismissedIds).toEqual([])
  })

  it('survives a criteria edit like dismissals do (a verdict is about the listing, not the query)', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l', criteria: { maxPrice: 1 } })
    store.review(s.id, 'a', 'interested')
    const after = store.update(s.id, { criteria: { maxPrice: 2 } })!
    expect(after.seenIds).toEqual([])
    expect(after.interestedIds).toEqual(['a'])
  })

  it('removeListing drops the snapshot copy and the interested mark, keeps a dismissal', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: [listing('a'), listing('b')] })
    store.review(s.id, 'a', 'interested')
    store.review(s.id, 'b', 'dismissed')
    const r1 = store.removeListing(s.id, 'a')!
    expect(r1.lastResults?.map((l) => l.id)).toEqual(['b'])
    expect(r1.interestedIds).toEqual([])
    const r2 = store.removeListing(s.id, 'b')!
    expect(r2.lastResults).toEqual([])
    expect(r2.dismissedIds).toEqual(['b'])
  })
})

describe('withInterestedCarried', () => {
  it('carries interested listings that aged out of the snapshot; the snapshot copy wins when present', () => {
    const prev = [listing('old', { price: 1 }), listing('keep', { price: 1 }), listing('unmarked')]
    const snap = [listing('new'), listing('keep', { price: 2 })]
    const out = withInterestedCarried({ interestedIds: ['old', 'keep'], lastResults: prev }, snap)
    expect(out.map((l) => l.id)).toEqual(['new', 'keep', 'old'])
    expect(out.find((l) => l.id === 'keep')?.price).toBe(2)
  })

  it('no interested ids → the snapshot as-is', () => {
    expect(withInterestedCarried({}, [listing('a')]).map((l) => l.id)).toEqual(['a'])
  })

  it('recordPoll keeps an interested listing across a snapshot that dropped it', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: [listing('a'), listing('b')] })
    store.review(s.id, 'a', 'interested')
    const { current } = store.recordPoll(s.id, { listings: [listing('c')] })!
    expect(current.lastResults?.map((l) => l.id).sort()).toEqual(['a', 'c'])
  })
})

describe('boxAround', () => {
  it('is a closed 5-vertex ring centred on the point', () => {
    const r = boxAround(51.5, -0.1, 100)
    expect(r).toHaveLength(5)
    expect(r[0]).toEqual(r[4])
    const lats = r.map((p) => p[1]), lons = r.map((p) => p[0])
    expect((Math.min(...lats) + Math.max(...lats)) / 2).toBeCloseTo(51.5, 6)
    expect((Math.min(...lons) + Math.max(...lons)) / 2).toBeCloseTo(-0.1, 6)
  })
})

describe('PortalClient.isLive', () => {
  const res = (status: number, body = ''): Response => new Response(body, { status })
  const fetchOf = (fn: (url: string) => Response | Promise<Response>) => ((url: string | URL | Request) => Promise.resolve(fn(String(url)))) as unknown as typeof fetch

  it('rightmove: 410/404 → gone, 200 → live unless the body says removed, other → unknown', async () => {
    const l = listing('1')
    expect(await new RightmoveClient(fetchOf(() => res(410))).isLive(l)).toBe(false)
    expect(await new RightmoveClient(fetchOf(() => res(404))).isLive(l)).toBe(false)
    expect(await new RightmoveClient(fetchOf(() => res(200, '<html>lovely house</html>'))).isLive(l)).toBe(true)
    expect(await new RightmoveClient(fetchOf(() => res(200, 'This property has been removed by the agent'))).isLive(l)).toBe(false)
    expect(await new RightmoveClient(fetchOf(() => res(503))).isLive(l)).toBeNull()
    expect(await new RightmoveClient(fetchOf(() => { throw new Error('net') })).isLive(l)).toBeNull()
  })

  it('immoscout24: 410 → gone, deactivated flag → gone, WAF rejection → unknown', async () => {
    const waf = { get: async () => 'tok', invalidate: () => {} } as unknown as ConstructorParameters<typeof ImmoScout24Client>[0]
    const l = listing('1', { portal: 'immoscout24' })
    expect(await new ImmoScout24Client(waf, fetchOf(() => res(410))).isLive(l)).toBe(false)
    expect(await new ImmoScout24Client(waf, fetchOf(() => res(200, '"exposeState":{"isDeactivatedRedesign":false}'))).isLive(l)).toBe(true)
    expect(await new ImmoScout24Client(waf, fetchOf(() => res(200, '"exposeState":{"isDeactivatedRedesign":true}'))).isLive(l)).toBe(false)
    expect(await new ImmoScout24Client(waf, fetchOf(() => res(401))).isLive(l)).toBeNull()
  })

  it('immobiliare: re-queries a box around the listing and looks for its id; no coords → unknown', async () => {
    const body = (ids: number[]) => JSON.stringify({ count: ids.length, results: ids.map((id) => ({ realEstate: { id, title: 't', price: { value: 1 }, properties: [{ location: { latitude: 45, longitude: 9 } }] } })) })
    const l = listing('7', { portal: 'immobiliare', lat: 45, lon: 9 })
    const seen: string[] = []
    expect(await new ImmobiliareClient(fetchOf((u) => { seen.push(u); return res(200, body([7, 8])) })).isLive(l, {})).toBe(true)
    expect(seen[0]).toContain('vrt=')
    expect(await new ImmobiliareClient(fetchOf(() => res(200, body([8])))).isLive(l, {})).toBe(false)
    expect(await new ImmobiliareClient(fetchOf(() => res(403))).isLive(l, {})).toBeNull()
    expect(await new ImmobiliareClient(fetchOf(() => res(200, body([7])))).isLive(listing('7', { portal: 'immobiliare' }), {})).toBeNull()
  })
})

describe('postFilter excludeHouseSubtypes', () => {
  it('drops listings whose own type text classifies as an excluded subtype, on every portal, fail-open on blank text', () => {
    const rows = [
      listing('semi', { propertyType: 'Semi-Detached' }),
      listing('town', { propertyType: 'Town House' }),
      listing('tb', { propertyType: 'Terraced Bungalow' }),
      listing('eot', { propertyType: 'End of Terrace' }),
      listing('det', { propertyType: 'Detached' }),
      listing('blank'),
    ]
    const kept = postFilter(rows, { excludeHouseSubtypes: ['terraced'] }, [])
    expect(kept.map((l) => l.id)).toEqual(['semi', 'det', 'blank'])
    expect(postFilter(rows, {}, []).length).toBe(6)
  })
})

describe('PropertySync outside bar', () => {
  // Search polygon = a UK-sized box; geofence = a box round Heathrow.
  // inside = Hounslow (-0.45, 51.47), outside = Manchester (-2.5, 53.4).
  const ukBox = { type: 'Polygon', coordinates: [[[-6, 49.5], [2, 49.5], [2, 59], [-6, 59], [-6, 49.5]]] }
  const geofence = { type: 'Polygon', coordinates: [[[-0.6, 51.3], [-0.3, 51.3], [-0.3, 51.6], [-0.6, 51.6], [-0.6, 51.3]]] }
  const harness = () => {
    const store = tmpStore()
    const mapLayers = { upsert: () => ({}), getMeta: () => undefined, getGeojson: (slug: string) => (slug === 'fence/heathrow' ? geofence : slug === 'l' ? ukBox : null), list: () => [] }
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: 4, truncated: false, unsupported: [], listings: [
        listing('in-semi', { lat: 51.47, lon: -0.45, price: 290000, propertyType: 'Semi-Detached' }),
        listing('out-semi', { lat: 53.4, lon: -2.5, price: 200000, propertyType: 'Semi-Detached' }),
        listing('out-det-ok', { lat: 53.4, lon: -2.5, price: 200000, propertyType: 'Detached' }),
        listing('out-det-pricey', { lat: 53.4, lon: -2.5, price: 290000, propertyType: 'Detached' }),
        listing('out-nocoords', { price: 200000, propertyType: 'Detached' }),
      ] }),
    }
    const sync = new PropertySync(
      { rightmove: client, immoscout24: client, immobiliare: client } as never, store, tmpInventory(),
      { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never,
      { isConfigured: () => false } as never, () => {},
    )
    return { store, sync }
  }

  it('outside the geofence a listing must also pass outsideCriteria; inside, the plain criteria are enough', async () => {
    const { store, sync } = harness()
    const s = store.create({ country: 'UK', layer: 'l', notifyLayer: 'fence/heathrow', outsideCriteria: { maxPrice: 250000, houseSubtypes: ['detached'] } })
    await sync.pollOne(s.id)
    expect(store.get(s.id)!.lastResults!.map((l) => l.id).sort()).toEqual(['in-semi', 'out-det-ok', 'out-nocoords'])
  })

  it('no outsideCriteria (or no geofence) → everything the search matched stays', async () => {
    const { store, sync } = harness()
    const a = store.create({ country: 'UK', layer: 'l', notifyLayer: 'fence/heathrow' })
    const b = store.create({ country: 'UK', layer: 'l', outsideCriteria: { maxPrice: 1 } })
    await sync.pollOne(a.id)
    await sync.pollOne(b.id)
    expect(store.get(a.id)!.lastResults!.length).toBe(5)
    expect(store.get(b.id)!.lastResults!.length).toBe(5)
  })
})

describe('PropertySync.pruneGone', () => {
  const harness = (isLive: (l: Listing) => Promise<boolean | null>) => {
    const store = tmpStore()
    const layers = new Map<string, unknown>()
    const mapLayers = {
      upsert: (slug: string, gj: unknown) => { layers.set(slug, gj); return { slug } },
      getMeta: (slug: string) => (layers.has(slug) ? { slug } : undefined),
      getGeojson: () => null,
      list: () => [...layers.keys()].map((slug) => ({ slug })),
    }
    const broadcasts: string[] = []
    const client = { portal: 'rightmove' as const, currency: 'GBP', count: async () => 0, newest: async () => ({ portal: 'rightmove' as const, total: 0, listings: [], truncated: false, unsupported: [] }), isLive }
    const sync = new PropertySync(
      { rightmove: client, immoscout24: client, immobiliare: client } as never,
      store,
      tmpInventory(),
      { broadcast: () => {} } as never,
      { broadcast: (_svc: string, op: string) => { broadcasts.push(op) } } as never,
      mapLayers as never,
      { isConfigured: () => false } as never,
      () => {},
    )
    return { store, sync, layers, broadcasts }
  }
  const pins = (layers: Map<string, unknown>) => {
    const gj = [...layers.values()][0] as { features: Array<{ properties: Record<string, unknown> }> }
    return gj.features.map((f) => f.properties)
  }

  it('removes interested listings the portal says are gone; keeps unknown and still-snapshotted ones', async () => {
    const probed: string[] = []
    const { store, sync, layers } = harness(async (l) => { probed.push(l.id); return l.id === 'gone' ? false : l.id === 'flaky' ? null : true })
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: ['gone', 'flaky', 'live', 'fresh', 'plain'].map((id) => listing(id, { lat: 1, lon: 1 })) })
    for (const id of ['gone', 'flaky', 'live', 'fresh']) store.review(s.id, id, 'interested')
    const removed = await sync.pruneGone(s.id, new Set(['fresh']))
    expect(removed).toEqual(['gone'])
    expect(probed.sort()).toEqual(['flaky', 'gone', 'live'])
    const after = store.get(s.id)!
    expect(after.lastResults?.map((l) => l.id).sort()).toEqual(['flaky', 'fresh', 'live', 'plain'])
    expect(after.interestedIds?.sort()).toEqual(['flaky', 'fresh', 'live'])
    const p = pins(layers)
    expect(p.find((x) => x.listingId === 'live')).toMatchObject({ review: 'interested', _color: expect.any(String), _icon: '🏡' })
    expect(p.find((x) => x.listingId === 'plain')).toMatchObject({ _icon: '🏠' })
    expect(p.find((x) => x.listingId === 'plain')?.review).toBeUndefined()
  })

  it('review repaints immediately: dismissed pins vanish, interested pins carry the colour', async () => {
    const { store, sync, layers, broadcasts } = harness(async () => true)
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: ['a', 'b'].map((id) => listing(id, { lat: 1, lon: 1 })) })
    sync.review(s.id, 'a', 'interested')
    expect(pins(layers).find((x) => x.listingId === 'a')?.review).toBe('interested')
    sync.review(s.id, 'b', 'dismissed')
    expect(pins(layers).map((x) => x.listingId)).toEqual(['a'])
    expect(broadcasts.filter((b) => b === 'updated')).toHaveLength(2)
  })
})

describe('PropertySearchStore.reseed', () => {
  it('clears seenIds/seeded without touching criteria/layer/country', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l', criteria: { maxPrice: 500000 } })
    store.recordPoll(s.id, { listings: [listing('a'), listing('b')] })
    expect(store.get(s.id)?.seenIds?.sort()).toEqual(['a', 'b'])

    const reseeded = store.reseed(s.id)
    expect(reseeded?.seeded).toBe(false)
    expect(reseeded?.seenIds).toEqual([])
    expect(reseeded?.layer).toBe('l')
    expect(reseeded?.criteria).toEqual({ maxPrice: 500000 })

    // The next poll must report itself as seeding again — sync.ts's caller
    // uses this flag to skip notifying, even though `fresh` itself still
    // lists every id not in the (now-empty) seenIds.
    const next = store.recordPoll(s.id, { listings: [listing('a'), listing('b')] })
    expect(next?.seeding).toBe(true)
  })

  it('returns undefined for an unknown search', () => {
    const store = tmpStore()
    expect(store.reseed('ps_nope')).toBeUndefined()
  })
})

describe('PropertySearchStore.recordBackfill', () => {
  it('merges into lastResults and marks every id seen, without reporting fresh', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: [listing('a')] })

    const updated = store.recordBackfill(s.id, [listing('a'), listing('b'), listing('c')])
    expect(updated?.lastResults?.map((l) => l.id).sort()).toEqual(['a', 'b', 'c'])
    expect(updated?.seenIds?.sort()).toEqual(['a', 'b', 'c'])
    expect(updated?.seeded).toBe(true)

    // A subsequent real poll must not treat the backfilled ids as fresh.
    const poll = store.recordPoll(s.id, { listings: [listing('b')] })
    expect(poll?.fresh).toEqual([])
  })

  it('keeps existing pins that the backfill did not re-surface', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: [listing('old')] })
    const updated = store.recordBackfill(s.id, [listing('new')])
    expect(updated?.lastResults?.map((l) => l.id).sort()).toEqual(['new', 'old'])
  })
})

describe('notify gate (notify-filter)', () => {
  it('classifies Rightmove type text into the portable vocabulary', () => {
    expect(normaliseHouseType('Detached')).toEqual(['detached'])
    expect(normaliseHouseType('Detached Bungalow').sort()).toEqual(['bungalow', 'detached'])
    expect(normaliseHouseType('Link Detached House')).toEqual(['detached'])
    expect(normaliseHouseType('Semi-Detached')).toEqual(['semi-detached'])
    expect(normaliseHouseType('Semi-detached Villa').sort()).toEqual(['semi-detached', 'villa'])
    expect(normaliseHouseType('Terraced Bungalow').sort()).toEqual(['bungalow', 'terraced'])
    expect(normaliseHouseType('Cottage')).toEqual(['farmhouse'])
    expect(normaliseHouseType('Town House')).toEqual(['terraced'])
    expect(normaliseHouseType('House')).toEqual([])
    expect(normaliseHouseType(undefined)).toEqual([])
    // Other portals' text lands in the same buckets.
    expect(normaliseHouseType('Einfamilienhaus (freistehend)')).toEqual(['detached'])
    expect(normaliseHouseType('Doppelhaushälfte')).toEqual(['semi-detached'])
    expect(normaliseHouseType('Villa unifamiliare')).toEqual(['detached', 'villa'])
  })

  it('a semi never passes a detached-only gate, whatever else its text says', () => {
    const gate = { houseSubtypes: ['detached', 'bungalow', 'villa'] }
    expect(notifyRejection(listing('a', { propertyType: 'Semi-Detached Bungalow' }), gate)).toBe('houseType')
    expect(notifyRejection(listing('b', { propertyType: 'Semi-detached Villa' }), gate)).toBe('houseType')
    expect(notifyRejection(listing('c', { propertyType: 'Detached Bungalow' }), gate)).toBeNull()
    expect(notifyRejection(listing('d', { propertyType: 'Bungalow' }), gate)).toBeNull()
    // Unclassifiable type text fails — a notification is a positive claim.
    expect(notifyRejection(listing('e', { propertyType: 'House' }), gate)).toBe('houseType')
    expect(notifyRejection(listing('f', {}), gate)).toBe('houseType')
  })

  it('unknown fields FAIL the gate (unlike postFilter, which passes them)', () => {
    expect(notifyRejection(listing('a', {}), { maxPrice: 250_000 })).toBe('price')
    expect(notifyRejection(listing('a', { price: 250_000 }), { maxPrice: 250_000 })).toBeNull()
    expect(notifyRejection(listing('a', { price: 250_001 }), { maxPrice: 250_000 })).toBe('price')
    expect(notifyRejection(listing('a', { bedrooms: 2 }), { minBedrooms: 3 })).toBe('bedrooms')
    expect(notifyRejection(listing('a', {}), { minPlotArea: 800 })).toBe('plot')
    expect(notifyRejection(listing('a', { plotArea: 900 }), { minPlotArea: 800 })).toBeNull()
    expect(notifyRejection(listing('a', { floorArea: 80 }), { minFloorArea: 100 })).toBe('floorArea')
    // postFilter's contract for contrast: an unknown plot passes.
    expect(postFilter([listing('a', {})], { minPlotArea: 800 }, ['minPlotArea'])).toHaveLength(1)
  })

  it('keywords are any-of over title/summary/address, case-insensitive', () => {
    const gate = { keywords: ['acre', 'paddock', 'smallholding'] }
    expect(notifyRejection(listing('a', { summary: 'Set in 1.5 ACRES with outbuildings' }), gate)).toBeNull()
    expect(notifyRejection(listing('b', { title: 'Cottage with paddock' }), gate)).toBeNull()
    expect(notifyRejection(listing('c', { summary: 'Modern semi on a quiet road' }), gate)).toBe('keywords')
  })

  it('airport-drive gate needs the lookup and can be split off', () => {
    const gate = { maxPrice: 250_000, maxAirportDriveMinutes: 45 }
    expect(needsAirportDistance(gate)).toBe(true)
    expect(needsAirportDistance({ maxPrice: 1 })).toBe(false)
    expect(needsAirportDistance(undefined)).toBe(false)
    expect(withoutAirportGate(gate)).toEqual({ maxPrice: 250_000 })
    expect(notifyRejection(listing('a', { price: 1 }), gate)).toBe('airportDrive')
    const near = listing('b', { price: 1, nearestAirport: { iata: 'LHR', name: 'Heathrow', driveMinutes: 40, transitMinutes: null } })
    expect(notifyRejection(near, gate)).toBeNull()
    const far = listing('c', { price: 1, nearestAirport: { iata: 'LHR', name: 'Heathrow', driveMinutes: 46, transitMinutes: null } })
    expect(notifyRejection(far, gate)).toBe('airportDrive')
  })

  it('applyNotifyGate passes everything through when no gate is set', () => {
    const rows = [listing('a', { price: 999_999, propertyType: 'Semi-Detached' })]
    expect(applyNotifyGate(rows, undefined)).toEqual(rows)
    expect(applyNotifyGate(rows, { maxPrice: 250_000 })).toEqual([])
  })

  it('the UK defaults: detached-type AND ≤£250k, semis and dear detacheds both drop', () => {
    const uk = { houseSubtypes: ['detached', 'bungalow', 'villa', 'farmhouse', 'land'], maxPrice: 250_000 }
    const rows = [
      listing('semi', { propertyType: 'Semi-Detached', price: 200_000 }),
      listing('dear', { propertyType: 'Detached', price: 299_950 }),
      listing('good', { propertyType: 'Detached Bungalow', price: 245_000 }),
      listing('cottage', { propertyType: 'Cottage', price: 210_000 }),
    ]
    expect(applyNotifyGate(rows, uk).map((l) => l.id)).toEqual(['good', 'cottage'])
  })
})

describe('PropertySearchStore notify fields', () => {
  it('create() persists notify/notifyLayer/notifyCriteria, and update() changes to them never re-seed', () => {
    const store = tmpStore()
    const s = store.create({ country: 'UK', layer: 'l', notifyLayer: '/tmp/x.geojson', notify: true, notifyCriteria: { maxPrice: 1 } })
    expect(store.get(s.id)?.notifyLayer).toBe('/tmp/x.geojson')
    expect(store.get(s.id)?.notifyCriteria).toEqual({ maxPrice: 1 })
    store.recordPoll(s.id, { total: 1, listings: [listing('a')] })
    expect(store.get(s.id)?.seeded).toBe(true)
    store.update(s.id, { notify: false, notifyCriteria: { maxPrice: 2 }, notifyLayer: undefined })
    const after = store.get(s.id)!
    expect(after.notify).toBe(false)
    expect(after.notifyCriteria).toEqual({ maxPrice: 2 })
    expect(after.seeded).toBe(true)
    expect(after.seenIds).toEqual(['a'])
  })
})

describe('postFilter', () => {
  const criteria = { minFloorArea: 100, minPlotArea: 800, keywords: ['paddock'] }

  it('is a no-op for criteria the portal applied itself', () => {
    const rows = [listing('a', { floorArea: 50, plotArea: 10, summary: 'flat' })]
    expect(postFilter(rows, criteria, [])).toHaveLength(1)
  })

  it('drops rows failing a criterion the portal could not apply', () => {
    const rows = [listing('a', { plotArea: 100 }), listing('b', { plotArea: 2000 })]
    expect(postFilter(rows, criteria, ['minPlotArea']).map((l) => l.id)).toEqual(['b'])
  })

  it('keeps rows that simply do not expose the field', () => {
    // Absent ≠ failing: dropping these would hide most of IS24's hidden-detail rows.
    const rows = [listing('a', { plotArea: undefined })]
    expect(postFilter(rows, criteria, ['minPlotArea'])).toHaveLength(1)
  })

  it('matches keywords case-insensitively across title, summary and address', () => {
    const rows = [
      listing('a', { summary: 'With a large PADDOCK' }),
      listing('b', { title: 'Paddock House' }),
      listing('c', { summary: 'no land' }),
    ]
    expect(postFilter(rows, criteria, ['keywords']).map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('treats auctions and schemes as independent axes', () => {
    const rows = [
      listing('normal', { summary: 'A lovely family home' }),
      listing('auction', { summary: 'For sale by auction, guide price £200k' }),
      listing('retirement', { summary: 'Retirement living, over 55s only' }),
    ]
    const auctionsOnly = postFilter(rows, { excludeAuctions: true }, ['excludeAuctions']).map((l) => l.id)
    expect(auctionsOnly).toEqual(['normal', 'retirement'])

    const schemesOnly = postFilter(rows, { excludeSchemes: true }, ['excludeSchemes']).map((l) => l.id)
    expect(schemesOnly).toEqual(['normal', 'auction'])

    const both = postFilter(rows, { excludeAuctions: true, excludeSchemes: true }, ['excludeAuctions', 'excludeSchemes']).map(
      (l) => l.id,
    )
    expect(both).toEqual(['normal'])
  })

  it('drops price-on-request listings (no price field at all)', () => {
    const rows = [listing('priced', { price: 250000 }), listing('onRequest', { price: undefined })]
    const filtered = postFilter(rows, { excludePriceOnRequest: true }, ['excludePriceOnRequest']).map((l) => l.id)
    expect(filtered).toEqual(['priced'])
  })
})

describe('asEntryArray', () => {
  it('passes an array through unchanged', () => {
    const a = [{ '@id': '1' }, { '@id': '2' }]
    expect(asEntryArray(a)).toBe(a)
  })

  it('wraps a single-hit page (XML→JSON singleton flattening) instead of throwing on for...of', () => {
    const single = { '@id': '167740077' }
    expect(asEntryArray(single)).toEqual([single])
  })

  it('returns an empty array for a zero-hit page', () => {
    expect(asEntryArray(undefined)).toEqual([])
  })
})

describe('isTooSmall (immobiliare)', () => {
  it('flags a 3-vertex sliver (closed ring with a duplicated last point) as too small to submit', () => {
    // 422s live with "This collection should contain 4 elements or more" —
    // observed on a real ~15m union artifact near Trieste, 2026-08-15.
    const sliver: Array<[number, number]> = [
      [13.361202876628553, 45.75142669547999],
      [13.361278, 45.7513],
      [13.361457042962522, 45.75138957868349],
      [13.361202876628553, 45.75142669547999],
    ]
    expect(isTooSmall(sliver)).toBe(true)
  })

  it('does not flag a normal-sized ring', () => {
    const square: Array<[number, number]> = [
      [13.0, 45.0],
      [13.1, 45.0],
      [13.1, 45.1],
      [13.0, 45.1],
      [13.0, 45.0],
    ]
    expect(isTooSmall(square)).toBe(false)
  })
})

describe('nextWeekdayMorningUtc', () => {
  it('picks the same weekday 09:00 UTC when still in the future', () => {
    // Monday 2026-08-17, 07:00 UTC — 09:00 same day hasn't happened yet.
    const now = new Date('2026-08-17T07:00:00Z')
    expect(nextWeekdayMorningUtc(now)).toBe('2026-08-17T09:00:00Z')
  })

  it('rolls a Friday-evening query past the weekend to Monday', () => {
    const now = new Date('2026-08-21T20:00:00Z') // Friday evening
    expect(nextWeekdayMorningUtc(now)).toBe('2026-08-24T09:00:00Z') // Monday
  })

  it('never returns a time in the past relative to `now` — the whole point is avoiding a live 2am query', () => {
    // Same-day 09:00 has already passed by 10am, so it must roll to tomorrow.
    const now = new Date('2026-08-17T10:00:00Z')
    const result = new Date(nextWeekdayMorningUtc(now))
    expect(result.getTime()).toBeGreaterThan(now.getTime())
  })

  it('skips a Saturday-morning "now" straight to Monday, not Sunday', () => {
    const now = new Date('2026-08-22T05:00:00Z') // Saturday
    expect(nextWeekdayMorningUtc(now)).toBe('2026-08-24T09:00:00Z') // Monday
  })
})

describe('fetchAll', () => {
  const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]

  it('returns every row when the portal does not truncate', async () => {
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: 3, truncated: false, unsupported: ['minPlotArea'], listings: [listing('a'), listing('b'), listing('c')] }),
    }
    const r = await fetchAll(client as never, [ring, ring], {})
    expect(r.listings.map((l) => l.id).sort()).toEqual(['a', 'b', 'c'])
    expect(r.total).toBe(6)
    expect(r.truncated).toBe(false)
    expect(r.unsupported).toEqual(['minPlotArea'])
    expect(r.queries).toBe(2)
  })

  it('splits the price range when a query is truncated and unions the bands', async () => {
    // Portal holds 6 listings priced 50k..300k; any single query returning
    // more than 2 rows is "capped": it returns only the first 2 and flags it.
    const stock = [50, 100, 150, 200, 250, 300].map((k) => listing(`p${k}`, { price: k * 1000 }))
    const calls: Array<[number | undefined, number | undefined]> = []
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async (_r: unknown, c: { minPrice?: number; maxPrice?: number }) => {
        calls.push([c.minPrice, c.maxPrice])
        const hits = stock.filter((l) => (c.minPrice == null || l.price! >= c.minPrice) && (c.maxPrice == null || l.price! <= c.maxPrice))
        const truncated = hits.length > 2
        return { portal: 'rightmove' as const, total: hits.length, truncated, unsupported: [], listings: truncated ? hits.slice(0, 2) : hits }
      },
    }
    const r = await fetchAll(client as never, [ring], { maxPrice: 300000 })
    expect(r.listings.map((l) => l.id).sort()).toEqual(stock.map((l) => l.id).sort())
    expect(r.truncated).toBe(false)
    expect(r.total).toBe(6) // only the depth-0 query counts toward total
    expect(calls[0]).toEqual([undefined, 300000])
    expect(calls.length).toBeGreaterThan(1)
    // The lower half of a split never carries a zero floor (OnTheMarket 400s on min-price=0).
    expect(calls.every(([lo]) => lo !== 0)).toBe(true)
  })

  it('gives up splitting below the minimum band width and reports truncation', async () => {
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: 99, truncated: true, unsupported: [], listings: [listing('x')] }),
    }
    const r = await fetchAll(client as never, [ring], { minPrice: 100000, maxPrice: 103000 })
    expect(r.truncated).toBe(true)
    expect(r.listings.map((l) => l.id)).toEqual(['x'])
    expect(r.queries).toBe(1)
  })
})

describe('PropertyInventoryStore', () => {
  it('a full upsert marks missing ids removed; a skim never does; a return clears the mark', () => {
    const inv = tmpInventory()
    inv.upsert('s1', [listing('a'), listing('b')], { full: true, now: 1000 })
    expect(inv.live('s1').map((l) => l.id).sort()).toEqual(['a', 'b'])

    inv.upsert('s1', [listing('a')], { full: true, now: 2000 })
    expect(inv.live('s1').map((l) => l.id)).toEqual(['a'])
    expect(inv.get('s1').entries.find((e) => e.id === 'b')?.removedAt).toBe(2000)
    expect(inv.get('s1').syncedAt).toBe(2000)

    inv.upsert('s1', [listing('c')], { full: false, now: 3000 })
    expect(inv.live('s1').map((l) => l.id).sort()).toEqual(['a', 'c'])
    expect(inv.get('s1').syncedAt).toBe(2000)

    inv.upsert('s1', [listing('a'), listing('b'), listing('c')], { full: true, now: 4000 })
    const b = inv.get('s1').entries.find((e) => e.id === 'b')!
    expect(b.removedAt).toBeUndefined()
    expect(b.firstSeenAt).toBe(1000)
    expect(b.lastSeenAt).toBe(4000)
  })

  it('applyDetail() stays in memory until flush() — one write per batch, not per row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'property-inv-'))
    dirs.push(dir)
    const a = new PropertyInventoryStore(dir)
    a.upsert('s1', [listing('a')], { full: true, now: 1 })
    a.applyDetail('s1', 'a', { description: 'hello' })
    expect(new PropertyInventoryStore(dir).get('s1').entries[0]!.description).toBeUndefined()
    a.flush('s1')
    expect(new PropertyInventoryStore(dir).get('s1').entries[0]!.description).toBe('hello')
  })

  it('persists to disk and keeps nearestAirport across a re-pull that lacks it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'property-inv-'))
    dirs.push(dir)
    const a = new PropertyInventoryStore(dir)
    a.upsert('s1', [listing('a', { price: 1 })], { full: true, now: 1 })
    a.setNearestAirport('s1', 'a', { iata: 'LHR', name: 'Heathrow', driveMinutes: 30, transitMinutes: null })
    a.upsert('s1', [listing('a', { price: 2 })], { full: true, now: 2 })
    const b = new PropertyInventoryStore(dir)
    const e = b.get('s1').entries[0]!
    expect(e.price).toBe(2)
    expect(e.nearestAirport?.iata).toBe('LHR')
  })
})

describe('PropertySync kind layers', () => {
  const box = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] }
  const harness = () => {
    const store = tmpStore()
    const inventory = tmpInventory()
    const layers = new Map<string, { type: string; features: Array<{ properties: Record<string, unknown> }> }>()
    const mapLayers = {
      upsert: (slug: string, geojson: unknown) => { layers.set(slug, geojson as never); return {} },
      getMeta: (slug: string) => (layers.has(slug) ? {} : undefined),
      getGeojson: (slug: string) => (slug === 'zone' ? box : null),
      list: () => [...layers.keys()].map((slug) => ({ slug, group: slug.split('/')[0], name: slug.split('/')[1] })),
      remove: (slug: string) => layers.delete(slug),
    }
    const byCountry: Record<string, Listing[]> = {
      UK: [listing('uk1', { lat: 51, lon: -1, price: 100000 }), listing('uk-far', { lat: 30, lon: -1, price: 100000 })],
      DE: [listing('de1', { lat: 50, lon: 8, price: 200000, portal: 'immoscout24' })],
    }
    const mk = (country: string) => ({
      portal: 'rightmove' as const, currency: 'EUR', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: byCountry[country]!.length, truncated: false, unsupported: [], listings: byCountry[country]! }),
    })
    const sync = new PropertySync(
      { rightmove: mk('UK'), immoscout24: mk('DE'), immobiliare: mk('IT') } as never, store, inventory,
      { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never,
      { isConfigured: () => false } as never, () => {},
    )
    return { store, inventory, sync, layers }
  }

  it('fullSync fills the inventory and one property/<kind> layer holds every country, clipped to the zone', async () => {
    const { store, sync, layers, inventory } = harness()
    const uk = store.create({ country: 'UK', layer: 'zone' })
    const de = store.create({ country: 'DE', layer: 'zone' })
    await sync.fullSync(uk.id)
    await sync.fullSync(de.id)
    expect(inventory.live(uk.id).length).toBe(2)
    expect(store.get(uk.id)?.inventory?.live).toBe(2)
    expect(store.get(uk.id)?.seeded).toBe(true)
    expect(store.get(uk.id)?.seenIds?.sort()).toEqual(['uk-far', 'uk1'])
    const layer = layers.get('property/house')!
    expect(layer).toBeDefined()
    const props = layer.features.map((f) => f.properties)
    expect(props.map((p) => p.listingId).sort()).toEqual(['de1', 'uk1']) // uk-far is outside the zone
    expect(props.find((p) => p.listingId === 'de1')).toMatchObject({ country: 'DE', portal: 'immoscout24', searchId: de.id })
    expect([...layers.keys()]).toEqual(['property/house'])
  })

  it('a truncated full pull merges but never marks the unreached rows removed', async () => {
    const store = tmpStore()
    const inventory = tmpInventory()
    const mapLayers = { upsert: () => ({}), getMeta: () => undefined, getGeojson: (slug: string) => (slug === 'zone' ? box : null), list: () => [], remove: () => true }
    let truncated = false
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: 2, truncated, unsupported: [], listings: truncated ? [listing('a', { lat: 51, lon: -1 })] : [listing('a', { lat: 51, lon: -1 }), listing('b', { lat: 51, lon: -1 })] }),
    }
    const sync = new PropertySync({ rightmove: client } as never, store, inventory, { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never, { isConfigured: () => false } as never, () => {})
    const s = store.create({ country: 'UK', layer: 'zone', criteria: { minPrice: 100000, maxPrice: 103000 } }) // band too narrow to split
    await sync.fullSync(s.id)
    expect(inventory.live(s.id).length).toBe(2)
    truncated = true
    await sync.fullSync(s.id)
    expect(inventory.live(s.id).map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(store.get(s.id)?.inventory?.truncated).toBe(true)
  })

  it('a farmland search feeds property/farmland, not the house layer', async () => {
    const { store, sync, layers } = harness()
    const s = store.create({ country: 'DE', layer: 'zone', kind: 'farmland' })
    await sync.fullSync(s.id)
    expect([...layers.keys()]).toEqual(['property/farmland'])
    expect(layers.get('property/farmland')!.features.length).toBe(1)
  })

  it('a coarse criteria edit drops the inventory; a review redraws without one', async () => {
    const { store, sync, layers, inventory } = harness()
    const s = store.create({ country: 'UK', layer: 'zone' })
    await sync.fullSync(s.id)
    expect(layers.get('property/house')!.features.length).toBe(1)
    sync.review(s.id, 'uk1', 'dismissed')
    expect(layers.get('property/house')!.features.length).toBe(0)
    sync.update(s.id, { criteria: { maxPrice: 50000 } })
    expect(inventory.get(s.id).entries.length).toBe(0)
    expect(store.get(s.id)?.inventory).toBeUndefined()
  })

  it('removing a search clears its inventory and its pins', async () => {
    const { store, sync, layers, inventory } = harness()
    const uk = store.create({ country: 'UK', layer: 'zone' })
    const de = store.create({ country: 'DE', layer: 'zone' })
    await sync.fullSync(uk.id)
    await sync.fullSync(de.id)
    expect(sync.remove(uk.id)).toBe(true)
    expect(inventory.get(uk.id).entries.length).toBe(0)
    expect(layers.get('property/house')!.features.map((f) => f.properties.listingId)).toEqual(['de1'])
  })
})

describe('groupDuplicates', () => {
  it('groups same-position same-price listings, keeps input order, leaves others alone', () => {
    const a = { lat: 51.5, lon: -0.1, price: 250000, bedrooms: 3, id: 'a' }
    const b = { lat: 51.5002, lon: -0.1, price: 251000, bedrooms: 3, id: 'b' } // ~22 m away, price within 1.5%
    const c = { lat: 51.5, lon: -0.1, price: 199000, bedrooms: 3, id: 'c' } // same spot, different price
    const d = { lat: 51.51, lon: -0.1, price: 250000, bedrooms: 3, id: 'd' } // 1.1 km away
    const groups = groupDuplicates([a, b, c, d]).map((g) => g.map((x) => x.id))
    expect(groups).toEqual([['a', 'b'], ['c'], ['d']])
  })

  it('never groups two rows from the same source, however close', () => {
    const a = { lat: 51.5, lon: -0.1, price: 250000, source: 's1', id: 'a' }
    const b = { lat: 51.5, lon: -0.1, price: 250000, source: 's1', id: 'b' }
    const c = { lat: 51.5, lon: -0.1, price: 250000, source: 's2', id: 'c' }
    expect(groupDuplicates([a, b, c]).map((g) => g.map((x) => x.id))).toEqual([['a', 'c'], ['b']])
  })

  it('falls back to bedrooms when a price is missing, and splits on a bedroom mismatch', () => {
    const a = { lat: 45.4, lon: 9.2, bedrooms: 3, id: 'a' }
    const b = { lat: 45.4, lon: 9.2, price: 200000, bedrooms: 3, id: 'b' }
    const c = { lat: 45.4, lon: 9.2, bedrooms: 5, id: 'c' }
    expect(groupDuplicates([a, b, c]).map((g) => g.map((x) => x.id))).toEqual([['a', 'b'], ['c']])
  })

  it('handles a cell boundary — neighbours in adjacent grid cells still match', () => {
    const a = { lat: 50.0019, lon: 8.0019, price: 100000, id: 'a' }
    const b = { lat: 50.0021, lon: 8.0021, price: 100000, id: 'b' } // ~27 m, other side of the 0.002° cell edge
    expect(groupDuplicates([a, b]).length).toBe(1)
  })
})

describe('PropertySync cross-portal dedupe', () => {
  const box = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] }
  const harness = (byPortal: Record<string, Listing[]>) => {
    const store = tmpStore()
    const inventory = tmpInventory()
    const layers = new Map<string, { features: Array<{ properties: Record<string, unknown> }> }>()
    const mapLayers = {
      upsert: (slug: string, geojson: unknown) => { layers.set(slug, geojson as never); return {} },
      getMeta: (slug: string) => (layers.has(slug) ? {} : undefined),
      getGeojson: (slug: string) => (slug === 'zone' ? box : null),
      list: () => [...layers.keys()].map((slug) => ({ slug, group: 'property', name: slug.split('/')[1] })),
      remove: (slug: string) => layers.delete(slug),
    }
    const mk = (portal: string) => ({
      portal, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal, total: byPortal[portal]!.length, truncated: false, unsupported: [], listings: byPortal[portal]! }),
    })
    const clients = Object.fromEntries(Object.keys(byPortal).map((p) => [p, mk(p)]))
    const sync = new PropertySync(
      clients as never, store, inventory,
      { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never,
      { isConfigured: () => false } as never, () => {},
    )
    return { store, sync, layers }
  }

  it('the same house on two portals is one pin, drawn from the primary portal, naming the other', async () => {
    const { store, sync, layers } = harness({
      rightmove: [listing('rm1', { lat: 51.5, lon: -1, price: 250000, bedrooms: 3 })],
      onthemarket: [
        listing('otm1', { lat: 51.5001, lon: -1, price: 250000, bedrooms: 3, portal: 'onthemarket' as never }),
        listing('otm-only', { lat: 52, lon: -1.5, price: 180000, bedrooms: 2, portal: 'onthemarket' as never }),
      ],
    })
    const rm = store.create({ country: 'UK', layer: 'zone' })
    const otm = store.create({ country: 'UK', layer: 'zone', portal: 'onthemarket' as never })
    await sync.fullSync(otm.id) // aggregator first: order of arrival must not decide who wins
    await sync.fullSync(rm.id)
    const props = layers.get('property/house')!.features.map((f) => f.properties)
    expect(props.map((p) => p.listingId).sort()).toEqual(['otm-only', 'rm1'])
    const pin = props.find((p) => p.listingId === 'rm1')!
    expect(pin).toMatchObject({ portal: 'rightmove', alsoOn: 'onthemarket', searchId: rm.id })
    expect(props.find((p) => p.listingId === 'otm-only')!.alsoOn).toBeUndefined()
  })

  it('a verdict on any copy applies to the whole group', async () => {
    const { store, sync, layers } = harness({
      rightmove: [listing('rm1', { lat: 51.5, lon: -1, price: 250000, bedrooms: 3 })],
      onthemarket: [listing('otm1', { lat: 51.5, lon: -1, price: 250000, bedrooms: 3, portal: 'onthemarket' as never })],
    })
    const rm = store.create({ country: 'UK', layer: 'zone' })
    const otm = store.create({ country: 'UK', layer: 'zone', portal: 'onthemarket' as never })
    await sync.fullSync(rm.id)
    await sync.fullSync(otm.id)
    sync.review(otm.id, 'otm1', 'interested')
    expect(layers.get('property/house')!.features[0]!.properties.review).toBe('interested')
    sync.review(otm.id, 'otm1', 'dismissed')
    expect(layers.get('property/house')!.features.length).toBe(0)
  })
})

describe('coverRingWithCircles', () => {
  // ~110 km × 110 km square around 50°N 8°E
  const big: [number, number][] = [[7.2, 49.5], [8.8, 49.5], [8.8, 50.5], [7.2, 50.5], [7.2, 49.5]]

  it('covers a small ring with one circle', () => {
    const small: [number, number][] = [[8, 50], [8.2, 50], [8.2, 50.1], [8, 50.1], [8, 50]]
    const circles = coverRingWithCircles(small, 100)
    expect(circles).toHaveLength(1)
    expect(circles[0]!.radiusKm).toBeLessThan(20)
    for (const v of small) expect(haversineKm([circles[0]!.lon, circles[0]!.lat], v)).toBeLessThanOrEqual(circles[0]!.radiusKm)
  })

  it('splits a ring larger than the radius cap and every vertex ends up inside some circle', () => {
    const circles = coverRingWithCircles(big, 40)
    expect(circles.length).toBeGreaterThan(1)
    for (const c of circles) expect(c.radiusKm).toBeLessThanOrEqual(40)
    for (const v of big) expect(circles.some((c) => haversineKm([c.lon, c.lat], v) <= c.radiusKm)).toBe(true)
    // and interior points too
    expect(circles.some((c) => haversineKm([c.lon, c.lat], [8, 50]) <= c.radiusKm)).toBe(true)
  })

  it('skips quarters the ring never touches', () => {
    // An L-shaped ring: the top-right quarter of its bbox is empty.
    const L: [number, number][] = [[7, 49], [8, 49], [8, 49.5], [7.5, 49.5], [7.5, 50], [7, 50], [7, 49]]
    const circles = coverRingWithCircles(L, 30)
    const topRight = circles.filter((c) => c.lon > 7.75 && c.lat > 49.75)
    expect(topRight).toHaveLength(0)
  })
})

describe('nearGeometry', () => {
  const square = { type: 'Polygon', coordinates: [[[8, 50], [8.2, 50], [8.2, 50.2], [8, 50.2], [8, 50]]] }
  it('true inside, true just outside within the buffer, false well outside', () => {
    expect(nearGeometry([8.1, 50.1], square, 5)).toBe(true)
    expect(nearGeometry([8.25, 50.1], square, 5)).toBe(true) // ~3.6 km east of the edge
    expect(nearGeometry([8.4, 50.1], square, 5)).toBe(false) // ~14 km
  })
})

describe('clipToLayer with area-precision coordinates', () => {
  it('keeps a centroid-located listing near the zone edge but drops an exact one at the same spot', async () => {
    const zone = { type: 'Polygon', coordinates: [[[10, 44], [10.2, 44], [10.2, 44.2], [10, 44.2], [10, 44]]] }
    const store = tmpStore()
    const layers = new Map<string, { features: unknown[] }>()
    const mapLayers = {
      upsert: (slug: string, geojson: unknown) => { layers.set(slug, geojson as never); return {} },
      getMeta: () => undefined, getGeojson: (slug: string) => (slug === 'zone' ? zone : null), list: () => [], remove: () => true,
    }
    const client = {
      portal: 'subito' as const, currency: 'EUR', count: async () => 0,
      newest: async () => ({ portal: 'subito' as const, total: 2, truncated: false, unsupported: [], listings: [
        listing('fuzzy', { lat: 44.1, lon: 10.24, price: 100000, portal: 'subito' as const, coordsPrecision: 'area' }), // ~3 km east of the edge
        listing('exact', { lat: 44.1, lon: 10.24, price: 100000, portal: 'subito' as const }),
      ] }),
    }
    const sync = new PropertySync({ subito: client } as never, store, tmpInventory(), { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never, { isConfigured: () => false } as never, () => {})
    const s = store.create({ country: 'IT', layer: 'zone', portal: 'subito' })
    await sync.fullSync(s.id)
    const ids = (layers.get('property/house')!.features as Array<{ properties: { listingId: string } }>).map((f) => f.properties.listingId)
    expect(ids).toEqual(['fuzzy'])
  })

  it('a search naming a portal with no client fails loudly, not silently', async () => {
    const store = tmpStore()
    const sync = new PropertySync({} as never, store, tmpInventory(), { broadcast: () => {} } as never, { broadcast: () => {} } as never, { getGeojson: () => null, list: () => [], getMeta: () => undefined } as never, { isConfigured: () => false } as never, () => {})
    const s = store.create({ country: 'UK', layer: 'zone', portal: 'onthemarket' })
    const after = await sync.fullSync(s.id)
    expect(after?.inventory?.error).toMatch(/no client wired for portal 'onthemarket'/)
  })
})

describe('Rightmove detail model', () => {
  it('unflatten() rebuilds a devalue-flattened object graph', () => {
    // {"a": 1, "b": [true, "x"], "c": {"d": null}, "e": undefined}
    const flat = [{ a: 1, b: 2, c: 5, e: -1 }, 1, [3, 4], true, 'x', { d: 6 }, null]
    expect(unflatten(flat)).toEqual({ a: 1, b: [true, 'x'], c: { d: null }, e: undefined })
  })

  it('detailFields() keeps features, description, sub-type, postcode, added date and parses land from text', () => {
    const f = detailFields({
      propertySubType: 'Smallholding',
      keyFeatures: [' Approx 3.5 acres ', 'Stables &amp; barn', ''],
      text: { description: 'A cottage<br>with paddocks<br/>totalling <b>3.5 acres</b> in all.' },
      sizings: [],
      listingHistory: { listingUpdateReason: 'Added on 03/09/2026' },
      address: { displayAddress: 'Lane, Village', outcode: 'HR1', incode: '2AB' },
      bedrooms: 3,
    })
    expect(f.keyFeatures).toEqual(['Approx 3.5 acres', 'Stables & barn'])
    expect(f.description).toBe('A cottage\nwith paddocks\ntotalling 3.5 acres in all.')
    expect(f.propertyType).toBe('Smallholding')
    expect(f.address).toBe('Lane, Village, HR1 2AB')
    expect(f.listedAt).toBe('2026-09-03T00:00:00Z')
    expect(f.plotArea).toBe(Math.round(3.5 * 4046.86))
    expect(f.detailAt).toBeGreaterThan(0)
  })

  it('detailFields() ignores sizings (floor area restated in acres) and ignores "Reduced on"', () => {
    const f = detailFields({ sizings: [{ unit: 'ac', minimumSize: 0.0247, maximumSize: 0.0247 }, { unit: 'sqm', minimumSize: 100, maximumSize: 100 }], text: { description: 'a lovely house' }, listingHistory: { listingUpdateReason: 'Reduced on 01/01/2026' } })
    expect(f.plotArea).toBeUndefined()
    expect(f.listedAt).toBeUndefined()
  })

  it('plotAreaFromText() takes the largest plausible land figure and ignores floor areas', () => {
    expect(plotAreaFromText('Set in about 0.75 acres with a further 2 acre paddock')).toBe(Math.round(2 * 4046.86))
    expect(plotAreaFromText('1.5 ha of orchard')).toBe(15000)
    expect(plotAreaFromText('plot of approx 1,200 sq m')).toBe(1200)
    expect(plotAreaFromText('1,450 sq ft of accommodation')).toBeUndefined()
    expect(plotAreaFromText('over 900 acres of common land nearby')).toBeUndefined() // implausible for a house
    expect(plotAreaFromText('no land mentioned')).toBeUndefined()
  })
})

describe('listingKind', () => {
  it('a farmland search is always farmland; a house search promotes on type, plot or text', () => {
    expect(listingKind({}, 'farmland')).toBe('farmland')
    expect(listingKind({ propertyType: 'Semi-Detached' }, 'house')).toBe('house')
    expect(listingKind({ propertyType: 'Equestrian Facility' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Bauernhaus' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Detached', plotArea: 2500 }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Detached', plotArea: 1200 }, 'house')).toBe('farmland') // floor is 1,000 m²
    expect(listingKind({ propertyType: 'Detached', plotArea: 900 }, 'house')).toBe('house')
    expect(listingKind({ propertyType: 'Detached', keyFeatures: ['Approx 1 acre'] }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Detached', summary: 'large garden' }, 'house')).toBe('house')
  })

  it('keywords promote when no size is stated; a stated size below the floor wins over a keyword', () => {
    expect(listingKind({ propertyType: 'Detached', summary: 'Cottage with paddock and stables' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Detached', description: 'mature orchard to the rear' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Detached', summary: 'set in half an acre' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Einfamilienhaus', description: 'mit Streuobstwiese' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Villa', description: 'con uliveto' }, 'house')).toBe('farmland')
    expect(listingKind({ propertyType: 'Semi-Detached', description: 'orchard-style planting', plotArea: 300 }, 'house')).toBe('house')
    expect(listingKind({ propertyType: 'Semi-Detached', summary: 'Scotland; building plot; landscaped garden' }, 'house')).toBe('house')
  })
})

describe('PropertySync.enrich', () => {
  const box = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] }
  it('applies detail fields, marks gone rows removed, stops on a thrown error, and re-splits the layers', async () => {
    const store = tmpStore()
    const inventory = tmpInventory()
    const layers = new Map<string, { features: Array<{ properties: Record<string, unknown> }> }>()
    const mapLayers = {
      upsert: (slug: string, geojson: unknown) => { layers.set(slug, geojson as never); return {} },
      getMeta: (slug: string) => (layers.has(slug) ? {} : undefined),
      getGeojson: (slug: string) => (slug === 'zone' ? box : null),
      list: () => [...layers.keys()].map((slug) => ({ slug, group: 'property', name: slug.split('/')[1] })),
      remove: (slug: string) => layers.delete(slug),
    }
    const rows = [
      listing('big', { lat: 51, lon: -1, price: 250000, bedrooms: 3, listedAt: '2026-09-03' }),
      listing('gone', { lat: 51.1, lon: -1, price: 250000, bedrooms: 3, listedAt: '2026-09-02' }),
      listing('plain', { lat: 51.2, lon: -1, price: 250000, bedrooms: 3, listedAt: '2026-09-01' }),
      listing('later', { lat: 51.3, lon: -1, price: 250000, bedrooms: 3, listedAt: '2026-08-01' }),
    ]
    const detailCalls: string[] = []
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: 4, truncated: false, unsupported: [], listings: rows }),
      detail: async (l: Listing) => {
        detailCalls.push(l.id)
        if (l.id === 'big') return { keyFeatures: ['Set in 2 acres'], plotArea: 8094, detailAt: Date.now() }
        if (l.id === 'gone') return null
        if (l.id === 'plain') return { description: 'a house', detailAt: Date.now() }
        throw new Error('429 — backing off')
      },
    }
    const sync = new PropertySync({ rightmove: client } as never, store, inventory, { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never, { isConfigured: () => false } as never, () => {})
    const s = store.create({ country: 'UK', layer: 'zone' })
    await sync.fullSync(s.id)
    expect(layers.get('property/house')!.features.length).toBe(4)

    const r = await sync.enrich(s.id, 10)
    expect(detailCalls).toEqual(['big', 'gone', 'plain', 'later']) // newest first, stopped by the throw
    expect(r).toEqual({ enriched: 2, gone: 1, pending: 1 })
    expect(inventory.live(s.id).map((e) => e.id).sort()).toEqual(['big', 'later', 'plain'])
    expect(inventory.live(s.id).find((e) => e.id === 'big')?.keyFeatures).toEqual(['Set in 2 acres'])
    // 'big' moved to the farmland layer; 'gone' left the map; the rest stay houses.
    expect(layers.get('property/farmland')!.features.map((f) => f.properties.listingId)).toEqual(['big'])
    expect(layers.get('property/house')!.features.map((f) => f.properties.listingId).sort()).toEqual(['later', 'plain'])

    // Second pass only touches what is still due.
    detailCalls.length = 0
    await sync.enrich(s.id, 10)
    expect(detailCalls).toEqual(['later'])
  }, 20_000)
})

describe('postFilter keywords over detail text', () => {
  it('matches in keyFeatures and description too', () => {
    const rows = [listing('kf', { keyFeatures: ['Paddock'] }), listing('desc', { description: 'a small orchard' }), listing('none', { summary: 'flat' })]
    expect(postFilter(rows, { keywords: ['paddock', 'orchard'] }, ['keywords']).map((l) => l.id)).toEqual(['kf', 'desc'])
  })
})

describe('shared fixes for the extra sources', () => {
  it('nearGeometry pads longitude in real degrees — a point 4.7 km EAST of a ring at 53°N passes like one 4.7 km north', () => {
    // ~11 km square around Manchester
    const sq = { type: 'Polygon', coordinates: [[[-2.3, 53.4], [-2.15, 53.4], [-2.15, 53.5], [-2.3, 53.5], [-2.3, 53.4]]] }
    const east: [number, number] = [-2.15 + 4.7 / (111.32 * Math.cos((53.45 * Math.PI) / 180)), 53.45]
    const north: [number, number] = [-2.22, 53.5 + 4.7 / 110.574]
    expect(nearGeometry(north, sq, 6)).toBe(true)
    expect(nearGeometry(east, sq, 6)).toBe(true)
    expect(nearGeometry([-2.0, 53.45], sq, 6)).toBe(false) // ~10 km east
  })

  it('normaliseHouseType: semindipendente is semi, terratetto is terraced', () => {
    expect(normaliseHouseType('Casa semindipendente')).toEqual(['semi-detached'])
    expect(normaliseHouseType('Terratetto')).toEqual(['terraced'])
    expect(normaliseHouseType('Casa indipendente')).toEqual(['detached'])
  })

  it('postFilter enforces minBedrooms and houseSubtypes locally when the portal could not, fail-open on missing data', () => {
    const rows = [
      listing('ok', { bedrooms: 3, propertyType: 'Casa indipendente' }),
      listing('few', { bedrooms: 1, propertyType: 'Casa indipendente' }),
      listing('terr', { bedrooms: 3, propertyType: 'Terratetto' }),
      listing('blank', {}),
    ]
    const kept = postFilter(rows, { minBedrooms: 2, houseSubtypes: ['detached', 'semi-detached'] }, ['minBedrooms', 'houseSubtypes'])
    expect(kept.map((l) => l.id)).toEqual(['ok', 'blank'])
    // …and does nothing when the portal already applied them.
    expect(postFilter(rows, { minBedrooms: 2, houseSubtypes: ['detached'] }, []).length).toBe(4)
  })

  it('groupDuplicates skips the bedroom comparison when a side counts locali', () => {
    const a = { lat: 43.7, lon: 10.4, price: 200000, bedrooms: 3, id: 'immobiliare' }
    const b = { lat: 43.7, lon: 10.4, price: 200000, bedrooms: 5, bedroomsApprox: true, id: 'wikicasa' }
    expect(groupDuplicates([a, b]).length).toBe(1)
    const c = { lat: 43.7, lon: 10.4, price: 200000, bedrooms: 5, id: 'other' }
    expect(groupDuplicates([a, c]).length).toBe(2)
  })
})

describe('PropertySync layer geometry cache', () => {
  it('parses a search layer once per layer version, not once per clip', async () => {
    const box = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] }
    const store = tmpStore()
    let reads = 0
    let version = 1
    const mapLayers = {
      upsert: () => ({}), getMeta: (slug: string) => (slug === 'zone' ? { updatedAt: version } : undefined),
      getGeojson: (slug: string) => { if (slug === 'zone') reads++; return slug === 'zone' ? box : null }, list: () => [], remove: () => true,
    }
    const client = {
      portal: 'rightmove' as const, currency: 'GBP', count: async () => 0,
      newest: async () => ({ portal: 'rightmove' as const, total: 1, truncated: false, unsupported: [], listings: [listing('a', { lat: 51, lon: -1 })] }),
    }
    const sync = new PropertySync({ rightmove: client } as never, store, tmpInventory(), { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never, { isConfigured: () => false } as never, () => {})
    const s = store.create({ country: 'UK', layer: 'zone' })
    await sync.fullSync(s.id)
    await sync.fullSync(s.id)
    sync.review(s.id, 'a', 'interested')
    expect(reads).toBe(1)
    version = 2 // the layer was re-pushed
    sync.review(s.id, 'a', 'none')
    expect(reads).toBe(2)
  })
})

describe('tenure — leasehold is an automatic disqualification', () => {
  it('normaliseTenure maps portal wording to tokens', () => {
    expect(normaliseTenure('Tenure: Freehold')).toBe('freehold')
    expect(normaliseTenure('FREEHOLD')).toBe('freehold')
    expect(normaliseTenure('Share of Freehold')).toBe('share-of-freehold')
    expect(normaliseTenure('Leasehold (125 years remaining)')).toBe('leasehold')
    expect(normaliseTenure('Commonhold')).toBe('commonhold')
    expect(normaliseTenure(undefined)).toBeUndefined()
  })

  it('OnTheMarket rows carry the tenure bullet; Rightmove detail pages carry tenureType', () => {
    const row = otmNormalise({ id: 1, features: ['Tenure: Leasehold', 'Garden'], price: '£200,000', location: { lat: 51, lon: -1 } } as never)
    expect(row?.tenure).toBe('leasehold')
    expect(detailFields({ tenure: { tenureType: 'FREEHOLD' } }).tenure).toBe('freehold')
  })

  it('postFilter drops leasehold (and share-of-freehold/commonhold when excludeCommonhold) on every portal, passes unknown', () => {
    const rows = [
      listing('fh', { tenure: 'freehold' }),
      listing('lh', { tenure: 'leasehold' }),
      listing('sof', { tenure: 'share-of-freehold' }),
      listing('text-lh', { summary: 'Leasehold flat with 90 years' }),
      listing('text-both', { summary: 'Freehold. Leasehold garage nearby' }),
      listing('unknown', {}),
    ]
    expect(postFilter(rows, { freeholdOnly: true, excludeCommonhold: true }, []).map((l) => l.id)).toEqual(['fh', 'text-both', 'unknown'])
    expect(postFilter(rows, { freeholdOnly: true }, []).map((l) => l.id)).toEqual(['fh', 'sof', 'text-both', 'unknown'])
    expect(postFilter(rows, {}, []).length).toBe(6)
  })
})
