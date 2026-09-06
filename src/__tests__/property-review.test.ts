import { describe, it, expect } from 'vitest'
import { countUnreviewedListings, isPropertyLayer } from '@/map/property-review'

const fc = (props: Array<Record<string, unknown>>) => ({
  type: 'FeatureCollection',
  features: props.map((properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties })),
})

describe('countUnreviewedListings', () => {
  it('counts property pins without a verdict, across searches, ignoring interested ones', () => {
    const layerData = {
      'property/uk-abc': fc([{ listingId: '1' }, { listingId: '2', review: 'interested' }, { listingId: '3' }]),
      'property/de-def': fc([{ listingId: '4' }]),
      'where-to-move/livable-zone': fc([{ listingId: 'not-a-property-layer' }]),
      'flights/arcs': fc([{ name: 'x' }]),
    }
    expect(countUnreviewedListings(layerData)).toBe(3)
  })

  it('tolerates missing/odd layer payloads and pins without a listingId', () => {
    expect(countUnreviewedListings({})).toBe(0)
    expect(countUnreviewedListings({ 'property/x': null, 'property/y': { type: 'Feature' }, 'property/z': fc([{ price: '£1' }]) })).toBe(0)
  })

  it('isPropertyLayer matches the hub prefix only', () => {
    expect(isPropertyLayer('property/uk-1')).toBe(true)
    expect(isPropertyLayer('properties/x')).toBe(false)
  })
})
