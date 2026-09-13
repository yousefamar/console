import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HighStreetIndex, newBuildLike } from '../property/place.js'
import { PropertySearchStore } from '../property/store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function highStreets(points: Array<[number, number, number?]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'place-test-'))
  dirs.push(dir)
  const file = join(dir, 'high-streets.geojson')
  writeFileSync(
    file,
    JSON.stringify({
      type: 'FeatureCollection',
      features: points.map(([lon, lat, shops]) => ({ type: 'Feature', properties: { shops: shops ?? 12 }, geometry: { type: 'Point', coordinates: [lon, lat] } })),
    }),
  )
  return file
}

describe('HighStreetIndex', () => {
  // Reading town centre (Broad Street) and Blakes Cottages ~700 m east of it.
  const broadStreet: [number, number] = [-0.9725, 51.4555]

  it('measures straight-line metres to the nearest cell and memoises', () => {
    const idx = new HighStreetIndex(highStreets([broadStreet, [-0.99, 51.44]]))
    expect(idx.size()).toBe(2)
    const m = idx.nearestM(51.4555, -0.9725)!
    expect(m).toBeLessThan(5)
    // ~700 m east along the same latitude.
    const far = idx.nearestM(51.4555, -0.9625)!
    expect(far).toBeGreaterThan(650)
    expect(far).toBeLessThan(750)
    expect(idx.nearestM(51.4555, -0.9625)).toBe(far)
  })

  it('finds a cell in a neighbouring grid square, and caps at 5 km when nothing is near', () => {
    const idx = new HighStreetIndex(highStreets([broadStreet]))
    // 0.012° north = next grid row, ~1.3 km away.
    expect(idx.nearestM(51.4675, -0.9725)).toBeGreaterThan(1200)
    expect(idx.nearestM(51.4675, -0.9725)).toBeLessThan(1400)
    // Basingstoke: nothing within 3 grid rings.
    expect(idx.nearestM(51.2665, -1.0872)).toBe(5000)
  })

  it('no file → null (filter passes), and a rewritten file is picked up without a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'place-test-'))
    dirs.push(dir)
    const file = join(dir, 'missing.geojson')
    const idx = new HighStreetIndex(file)
    expect(idx.size()).toBe(0)
    expect(idx.nearestM(51.4555, -0.9725)).toBeNull()
    writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { shops: 10 }, geometry: { type: 'Point', coordinates: broadStreet } }] }))
    expect(idx.size()).toBe(1)
    expect(idx.nearestM(51.4555, -0.9725)).toBeLessThan(5)
    // Rewrite with a different point and a later mtime → reloaded, memo cleared.
    writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { shops: 10 }, geometry: { type: 'Point', coordinates: [-0.99, 51.44] } }] }))
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
    expect(idx.nearestM(51.4555, -0.9725)).toBeGreaterThan(1500)
  })
})

describe('newBuildLike', () => {
  it('flags developer and new-build marketing, not renovation or street names', () => {
    expect(newBuildLike({ summary: 'A stunning new build home by Persimmon, Help to Buy available' })).toBe(true)
    expect(newBuildLike({ title: 'Plot 194 - The Orchard at Loomcroft' })).toBe(true)
    expect(newBuildLike({ description: 'Show home open Thursday to Monday. Phase 2 now released.' })).toBe(true)
    expect(newBuildLike({ description: 'Neubauprojekt, Erstbezug 2027, schlüsselfertig' })).toBe(true)
    expect(newBuildLike({ summary: 'Villetta di nuova costruzione, classe A4' })).toBe(true)
    expect(newBuildLike({ summary: 'Newly refurbished Victorian terrace with a modern kitchen' })).toBe(false)
    expect(newBuildLike({ address: 'Orchard Close, Banbury', summary: 'A 1930s semi with a mature garden' } as never)).toBe(false)
    expect(newBuildLike({ description: 'Brand new boiler fitted 2024' })).toBe(false)
  })
})

async function syncHarness(hs: string, portal: 'rightmove' | 'subito', listings: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'place-area-'))
  dirs.push(dir)
  const { PropertySync } = await import('../property/sync.js')
  const { PropertySearchStore } = await import('../property/store.js')
  const { PropertyInventoryStore } = await import('../property/inventory.js')
  const store = new PropertySearchStore(join(dir, 'searches.json'))
  const inventory = new PropertyInventoryStore(join(dir, 'inv'))
  const layers = new Map<string, { features: Array<{ properties: Record<string, unknown> }> }>()
  const box = { type: 'Polygon', coordinates: [[[-10, 40], [20, 40], [20, 60], [-10, 60], [-10, 40]]] }
  const mapLayers = {
    upsert: (slug: string, geojson: unknown) => { layers.set(slug, geojson as never); return {} },
    getMeta: (slug: string) => (layers.has(slug) ? {} : undefined),
    getGeojson: (slug: string) => (slug === 'zone' ? box : null),
    list: () => [...layers.keys()].map((slug) => ({ slug, group: slug.split('/')[0], name: slug.split('/')[1] })),
    remove: (slug: string) => layers.delete(slug),
  }
  const client = {
    portal, currency: portal === 'subito' ? 'EUR' : 'GBP', count: async () => 0,
    newest: async () => ({ portal, total: listings.length, truncated: false, unsupported: [], listings }),
  }
  const sync = new PropertySync({ [portal]: client } as never, store, inventory, { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never, { isConfigured: () => false } as never, () => {}, new HighStreetIndex(hs))
  const s = store.create({ country: portal === 'subito' ? 'IT' : 'UK', layer: 'zone', portal, criteria: { maxHighStreetM: 400 } })
  await sync.fullSync(s.id)
  return layers.get('property/house')?.features.map((f) => f.properties) ?? []
}

describe('place filter and centroid coordinates', () => {
  it('a PLZ/geocode-style area row passes maxHighStreetM untested and carries no distance label', async () => {
    const hs = highStreets([[-0.9725, 51.4555]])
    // Two rows 5 km from the only high street: one exact (must drop), one centroid (must stay, unlabelled).
    const far = { lat: 51.50, lon: -0.9725 }
    const props = await syncHarness(hs, 'rightmove', [
      { portal: 'rightmove', id: 'exact', url: 'u1', currency: 'GBP', ...far, coordsPrecision: 'exact' },
      { portal: 'rightmove', id: 'area', url: 'u2', currency: 'GBP', ...far, coordsPrecision: 'area' },
    ])
    expect(props.map((p) => p.listingId)).toEqual(['area'])
    expect(props[0]!.highStreet).toBeUndefined()
  })

  it('a comune-centre area row (Subito, Wikicasa) is tested at the centre: a comune with no high street is out, one with a centre stays and says so', async () => {
    // One high street: Pinerolo's. Villar Perosa's comune point is 12 km away and has none.
    const hs = highStreets([[7.3339, 44.8869]])
    const props = await syncHarness(hs, 'subito', [
      { portal: 'subito', id: 'pinerolo', url: 'u1', currency: 'EUR', lat: 44.8862, lon: 7.3335, coordsPrecision: 'area' },
      { portal: 'subito', id: 'villar', url: 'u2', currency: 'EUR', lat: 44.9207, lon: 7.2489, coordsPrecision: 'area' },
      { portal: 'subito', id: 'house', url: 'u3', currency: 'EUR', lat: 44.8880, lon: 7.3350, coordsPrecision: 'exact' },
    ])
    expect(props.map((p) => p.listingId).sort()).toEqual(['house', 'pinerolo'])
    const byId = Object.fromEntries(props.map((p) => [p.listingId, p.highStreet]))
    expect(byId.pinerolo).toMatch(/^town centre \d+ m to shops$/)
    expect(byId.house).toMatch(/^\d+ m to shops$/)
  })
})

describe('auctionLike', () => {
  it('matches sale-by-auction wording in three languages on word boundaries only', async () => {
    const { auctionLike } = await import('../property/sync.js')
    expect(auctionLike({ title: 'Villa in vendita all\'asta', summary: '' } as never)).toBe(true)
    expect(auctionLike({ title: 'Casa indipendente', summary: 'Aste giudiziarie: lotto 3, aggiudicazione minima €80.000' } as never)).toBe(true)
    expect(auctionLike({ title: 'Zwangsversteigerung Einfamilienhaus', summary: '' } as never)).toBe(true)
    expect(auctionLike({ title: '3 bed semi', summary: 'For sale by auction on 30 October' } as never)).toBe(true)
    expect(auctionLike({ title: 'Fantastica villa con castagno secolare', summary: 'a due passi dal tribunale, zona Bastia' } as never)).toBe(false)
    expect(auctionLike({ title: 'Villa', summary: 'Auctioneer\'s office nearby' } as never)).toBe(false)
  })
})

describe('local-only criteria never trigger a re-pull', () => {
  it('changing maxHighStreetM keeps seenIds and the inventory; changing price drops them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'place-store-'))
    dirs.push(dir)
    const store = new PropertySearchStore(join(dir, 'searches.json'))
    const s = store.create({ country: 'UK', layer: 'zone', criteria: { maxPrice: 300000 } })
    store.recordPoll(s.id, { total: 1, listings: [{ portal: 'rightmove', id: 'a', url: 'u', currency: 'GBP' }] })
    store.update(s.id, { inventory: { syncedAt: 1, live: 1, total: 1 } as never })
    const fine = store.update(s.id, { criteria: { maxPrice: 300000, maxHighStreetM: 400 } })!
    expect(fine.seeded).toBe(true)
    expect(fine.seenIds).toEqual(['a'])
    expect(fine.inventory).toBeDefined()
    const excl = store.update(s.id, { criteria: { maxPrice: 300000, maxHighStreetM: 400, excludeHouseSubtypes: ['terraced'] } })!
    expect(excl.seeded).toBe(true)
    expect(excl.inventory).toBeDefined()
    const auctions = store.update(s.id, { criteria: { maxPrice: 300000, maxHighStreetM: 400, excludeHouseSubtypes: ['terraced'], excludeAuctions: true } })!
    expect(auctions.seeded).toBe(true)
    expect(auctions.inventory).toBeDefined()
    const coarse = store.update(s.id, { criteria: { maxPrice: 250000, maxHighStreetM: 400 } })!
    expect(coarse.seeded).toBe(false)
    expect(coarse.seenIds).toEqual([])
    expect(coarse.inventory).toBeUndefined()
  })
})
