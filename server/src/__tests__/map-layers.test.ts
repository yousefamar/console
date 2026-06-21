import { describe, it, expect } from 'vitest'
import { inspectGeojson } from '../map-layers/store.js'

describe('inspectGeojson', () => {
  it('computes bbox + count + geometry types for a FeatureCollection', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-0.9, 51.4] }, properties: {} },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [8.6, 50.1] }, properties: {} },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-2, 49], [3, 55]] }, properties: {} },
      ],
    }
    const r = inspectGeojson(fc)
    expect(r.featureCount).toBe(3)
    expect(r.geometryTypes.sort()).toEqual(['LineString', 'Point'])
    expect(r.bbox).toEqual([-2, 49, 8.6, 55]) // [w, s, e, n]
  })

  it('walks nested polygon coordinates', () => {
    const poly = {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]] },
      properties: {},
    }
    const r = inspectGeojson(poly)
    expect(r.featureCount).toBe(1)
    expect(r.geometryTypes).toEqual(['Polygon'])
    expect(r.bbox).toEqual([0, 0, 10, 10])
  })

  it('returns null bbox for empty / geometry-less input', () => {
    expect(inspectGeojson({ type: 'FeatureCollection', features: [] }).bbox).toBeNull()
  })
})
