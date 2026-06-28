import { describe, it, expect } from 'vitest'
import { greatCircleArc, bezierArc, legsToGeoJSON, formatPrice, prettyDate } from '../flights/arcs.js'

describe('bezierArc', () => {
  it('hits both endpoints and bows off the straight line', () => {
    const a: [number, number] = [-0.4543, 51.47] // LHR
    const b: [number, number] = [8.7281, 45.6306] // MXP
    const arc = bezierArc(a, b, 48)
    expect(arc).toHaveLength(49)
    expect(arc[0]![0]).toBeCloseTo(a[0], 6)
    expect(arc[48]![1]).toBeCloseTo(b[1], 6)
    // Midpoint is displaced from the straight-line midpoint (the bow).
    const straight: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const mid = arc[24]!
    const disp = Math.hypot(mid[0] - straight[0], mid[1] - straight[1])
    expect(disp).toBeGreaterThan(0.5)
  })

  it('handles coincident endpoints without NaN', () => {
    const a: [number, number] = [5, 50]
    expect(bezierArc(a, a, 10)).toEqual([a, a])
  })
})

describe('greatCircleArc', () => {
  it('starts and ends at the endpoints, with steps+1 points', () => {
    const a: [number, number] = [-0.4543, 51.47] // LHR
    const b: [number, number] = [8.7281, 45.6306] // MXP
    const arc = greatCircleArc(a, b, 32)
    expect(arc).toHaveLength(33)
    expect(arc[0]![0]).toBeCloseTo(a[0], 4)
    expect(arc[0]![1]).toBeCloseTo(a[1], 4)
    expect(arc[32]![0]).toBeCloseTo(b[0], 4)
    expect(arc[32]![1]).toBeCloseTo(b[1], 4)
  })

  it('bows north of the straight-line midpoint (great circle, not rhumb)', () => {
    const a: [number, number] = [-0.4543, 51.47]
    const b: [number, number] = [8.7281, 45.6306]
    const arc = greatCircleArc(a, b, 64)
    const mid = arc[32]!
    const straightMidLat = (a[1] + b[1]) / 2
    // Northern-hemisphere east-west-ish great circle bows poleward.
    expect(mid[1]).toBeGreaterThan(straightMidLat)
  })

  it('handles coincident endpoints without NaN', () => {
    const a: [number, number] = [5, 50]
    const arc = greatCircleArc(a, a, 10)
    expect(arc).toEqual([a, a])
  })
})

describe('legsToGeoJSON', () => {
  it('emits an arc + a midpoint label per known leg', () => {
    const { geojson, skipped } = legsToGeoJSON([
      { from: 'LHR', to: 'AMS', price: 73, currency: 'GBP', date: '2026-07-04' },
    ])
    expect(skipped).toEqual([])
    const lines = geojson.features.filter((f: any) => f.geometry.type === 'LineString')
    const labels = geojson.features.filter((f: any) => f.geometry.type === 'Point')
    expect(lines).toHaveLength(1)
    expect(labels).toHaveLength(1)
    expect((lines[0] as any).properties.route).toBe('LHR → AMS')
    expect((lines[0] as any).properties.price).toBe('£73')
    expect((labels[0] as any).properties._label).toBe('£73 · 4 Jul')
  })

  it('skips legs with an unknown airport, keeps the rest', () => {
    const { geojson, skipped } = legsToGeoJSON([
      { from: 'LHR', to: 'ZZZ' },
      { from: 'LHR', to: 'MXP', price: 126 },
    ])
    expect(skipped).toEqual(['LHR→ZZZ'])
    const lines = geojson.features.filter((f: any) => f.geometry.type === 'LineString')
    expect(lines).toHaveLength(1)
    expect((lines[0] as any).properties.route).toBe('LHR → MXP')
  })

  it('respects per-leg colour + custom label', () => {
    const { geojson } = legsToGeoJSON([
      { from: 'LIN', to: 'FRA', price: 22, color: '#ff0000', label: 'steal' },
    ])
    const line = geojson.features.find((f: any) => f.geometry.type === 'LineString') as any
    const label = geojson.features.find((f: any) => f.geometry.type === 'Point') as any
    expect(line.properties._color).toBe('#ff0000')
    expect(label.properties._label).toBe('steal')
  })
})

describe('formatters', () => {
  it('formatPrice picks the right symbol', () => {
    expect(formatPrice(54, 'GBP')).toBe('£54')
    expect(formatPrice(54, 'EUR')).toBe('€54')
    expect(formatPrice(54, 'JPY')).toBe('54 JPY')
  })
  it('prettyDate shortens ISO', () => {
    expect(prettyDate('2026-07-16')).toBe('16 Jul')
  })
})
