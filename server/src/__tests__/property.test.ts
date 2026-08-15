import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePolyline, simplifyToLatLng, outerRings, ringsInCountry } from '../property/geo.js'
import { PropertySearchStore, PORTAL_BY_COUNTRY } from '../property/store.js'
import { postFilter } from '../property/sync.js'
import type { Listing } from '../property/types.js'

const dirs: string[] = []
const tmpStore = (): PropertySearchStore => {
  const dir = mkdtempSync(join(tmpdir(), 'property-test-'))
  dirs.push(dir)
  return new PropertySearchStore(join(dir, 'searches.json'))
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
})
