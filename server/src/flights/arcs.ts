// Turn flight legs into a GeoJSON layer of great-circle arcs for the Map tab.
//
// Each leg becomes:
//   • a curved LineString (spherical interpolation, so it bows like a real
//     flight path rather than a straight rhumb line), and
//   • a midpoint Point carrying a `_label` ("£54 · 16 Jul") for on-map text.
//
// Pure + unit-tested (server/src/__tests__/flights-arcs.test.ts). No I/O —
// the route writes the result through MapLayerStore.

import { airportCoord } from './airports.js'

export interface FlightLeg {
  from: string
  to: string
  /** Price in major units (e.g. 54 → £54). */
  price?: number
  currency?: string
  /** ISO date YYYY-MM-DD (departure). */
  date?: string
  /** Flight number / carrier, shown in the popup. */
  flight?: string
  /** Override the auto-generated midpoint label. */
  label?: string
  /** Per-arc colour (hex). Falls back to the layer default. */
  color?: string
}

type Pt = [number, number] // [lon, lat]

const DEG = Math.PI / 180

/**
 * Dramatic visual arc — a quadratic Bézier that bows out perpendicular to the
 * route (left of travel), scaled by distance. Unlike a great circle (which is
 * nearly straight for short European hops), this gives the "curving off the
 * page" flight-map look at any zoom. `curvature` ≈ bow as a fraction of span;
 * capped so long-haul arcs don't loop off the world.
 */
export function bezierArc(a: Pt, b: Pt, steps = 96, curvature = 0.32): Pt[] {
  const [ax, ay] = a
  const [bx, by] = b
  const dx = bx - ax
  const dy = by - ay
  const dist = Math.hypot(dx, dy)
  if (dist === 0) return [a, b]
  // Perpendicular (left of A→B), unit-normalised.
  const px = -dy / dist
  const py = dx / dist
  const off = Math.min(dist * curvature, 22) // degrees; cap for very long legs
  const cx = (ax + bx) / 2 + px * off
  const cy = (ay + by) / 2 + py * off
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    out.push([
      u * u * ax + 2 * u * t * cx + t * t * bx,
      u * u * ay + 2 * u * t * cy + t * t * by,
    ])
  }
  return out
}

/**
 * Great-circle arc between two [lon,lat] points as `steps`+1 interpolated
 * coordinates. Falls back to a straight 2-point line for coincident endpoints.
 */
export function greatCircleArc(a: Pt, b: Pt, steps = 64): Pt[] {
  const lon1 = a[0] * DEG, lat1 = a[1] * DEG
  const lon2 = b[0] * DEG, lat2 = b[1] * DEG

  // Angular distance (haversine) between the two points.
  const dLat = lat2 - lat1
  const dLon = lon2 - lon1
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  if (d === 0 || !Number.isFinite(d)) return [a, b]

  const sinD = Math.sin(d)
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const A = Math.sin((1 - f) * d) / sinD
    const B = Math.sin(f * d) / sinD
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2)
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2)
    const z = A * Math.sin(lat1) + B * Math.sin(lat2)
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y))
    const lon = Math.atan2(y, x)
    out.push([lon / DEG, lat / DEG])
  }
  return out
}

export function formatPrice(major: number, currency = 'GBP'): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : ''
  return symbol ? `${symbol}${Math.round(major)}` : `${Math.round(major)} ${currency}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function prettyDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return iso
  return `${parseInt(m[3]!, 10)} ${MONTHS[parseInt(m[2]!, 10) - 1] ?? m[2]}`
}

export interface LegsToGeoJSONResult {
  geojson: {
    type: 'FeatureCollection'
    features: Array<Record<string, unknown>>
  }
  /** Legs dropped because an airport code wasn't in the table. */
  skipped: string[]
}

/** Build the arc + label FeatureCollection. `defaultColor` colours arcs with no per-leg colour. */
export function legsToGeoJSON(legs: FlightLeg[], defaultColor = '#22d3ee'): LegsToGeoJSONResult {
  const features: Array<Record<string, unknown>> = []
  const skipped: string[] = []

  for (const leg of legs) {
    const from = airportCoord(leg.from)
    const to = airportCoord(leg.to)
    if (!from || !to) {
      skipped.push(`${leg.from}→${leg.to}`)
      continue
    }
    const arc = bezierArc([from.lon, from.lat], [to.lon, to.lat])
    const route = `${leg.from.toUpperCase()} → ${leg.to.toUpperCase()}`
    const priceStr = leg.price != null ? formatPrice(leg.price, leg.currency) : ''
    const dateStr = leg.date ? prettyDate(leg.date) : ''
    const label = leg.label ?? [priceStr, dateStr].filter(Boolean).join(' · ')
    const color = leg.color ?? defaultColor

    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: arc },
      properties: {
        name: route,
        route,
        ...(priceStr ? { price: priceStr } : {}),
        ...(dateStr ? { date: dateStr } : {}),
        ...(leg.flight ? { flight: leg.flight } : {}),
        _color: color,
      },
    })

    const mid = arc[Math.floor(arc.length / 2)]!
    if (label) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: mid },
        properties: { name: route, _label: label, _color: color },
      })
    }
  }

  return { geojson: { type: 'FeatureCollection', features }, skipped }
}
