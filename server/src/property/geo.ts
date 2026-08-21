// Polygon plumbing shared by all three portal clients.
//
// Every portal takes an arbitrary search polygon, so our Valhalla drive-time
// isochrones can be queried directly instead of the portals' own town/postcode
// identifiers. They just disagree on the wire format:
//   Rightmove  — Google encoded polyline, closed ring, ~90 vertices
//   ImmoScout24 — Google encoded polyline (unclosed is fine)
//   immobiliare — plain "lat,lng;lat,lng;…", ≤200 vertices (URL-length capped)

/** GeoJSON ring: [lng, lat] pairs. */
export type Ring = Array<[number, number]>

export interface Geometry {
  type: string
  coordinates: unknown
}

/** Google encoded polyline, precision 5, (lat,lng) order. */
export function encodePolyline(latLngs: Array<[number, number]>): string {
  let out = ''
  let plat = 0
  let plng = 0
  const chunk = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1
    let s = ''
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63)
      v >>>= 5
    }
    return s + String.fromCharCode(v + 63)
  }
  for (const [lat, lng] of latLngs) {
    const ilat = Math.round(lat * 1e5)
    const ilng = Math.round(lng * 1e5)
    out += chunk(ilat - plat) + chunk(ilng - plng)
    plat = ilat
    plng = ilng
  }
  return out
}

/** Ramer-Douglas-Peucker. Tolerance is in degrees — only used to hit a vertex cap. */
function rdp(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts
  const [ax, ay] = pts[0]!
  const [bx, by] = pts[pts.length - 1]!
  let maxD = -1
  let idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i]!
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= tol) return [pts[0]!, pts[pts.length - 1]!]
  return [...rdp(pts.slice(0, idx + 1), tol).slice(0, -1), ...rdp(pts.slice(idx), tol)]
}

/** Simplify a ring down to at most `maxVertices`, as [lat, lng] pairs. */
export function simplifyToLatLng(ring: Ring, maxVertices: number, close: boolean): Array<[number, number]> {
  let pts: Array<[number, number]> = ring.map(([lng, lat]) => [lat, lng])
  const ensureClosed = (): void => {
    const a = pts[0]!
    const b = pts[pts.length - 1]!
    if (close && (a[0] !== b[0] || a[1] !== b[1])) pts.push([a[0], a[1]])
    if (!close && a[0] === b[0] && a[1] === b[1] && pts.length > 1) pts.pop()
  }
  ensureClosed()
  let tol = 0
  while (pts.length > maxVertices) {
    tol = tol === 0 ? 0.0005 : tol * 1.6
    pts = rdp(pts, tol)
    ensureClosed()
    if (tol > 5) break
  }
  return pts
}

/** Every outer ring of a Polygon/MultiPolygon, largest first. */
export function outerRings(geometry: Geometry): Ring[] {
  const polys = (geometry.type === 'MultiPolygon'
    ? (geometry.coordinates as Ring[][])
    : [geometry.coordinates as Ring[]]) as Ring[][]
  return polys
    .map((p) => p[0]!)
    .filter((r) => Array.isArray(r) && r.length >= 4)
    .map((ring) => ({ ring, area: Math.abs(shoelace(ring)) }))
    .sort((a, b) => b.area - a.area)
    .map((r) => r.ring)
}

function shoelace(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  }
  return a / 2
}

export function ringBbox(ring: Ring): [number, number, number, number] {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const [lng, lat] of ring) {
    if (lng < w) w = lng
    if (lng > e) e = lng
    if (lat < s) s = lat
    if (lat > n) n = lat
  }
  return [w, s, e, n]
}

/**
 * Keep only the rings that fall inside a country's rough bbox. Each portal is
 * single-country, so the other lobes of a multi-country livable zone are dead
 * weight — and querying them wastes the portal's per-query result cap.
 */
const COUNTRY_BBOX: Record<string, [number, number, number, number]> = {
  // [west, south, east, north]
  UK: [-9, 49, 2.2, 61],
  DE: [5.8, 47.2, 15.1, 55.1],
  IT: [6.6, 35.4, 18.6, 47.1],
}

export function ringsInCountry(geometry: Geometry, country: keyof typeof COUNTRY_BBOX): Ring[] {
  const box = COUNTRY_BBOX[country]
  if (!box) throw new Error(`unknown country ${country}`)
  const [bw, bs, be, bn] = box
  return outerRings(geometry).filter((ring) => {
    const [w, s, e, n] = ringBbox(ring)
    // Overlap test, not containment — a ring straddling the border still has
    // listings on our side, and the portal itself clips to its own country.
    return e > bw && w < be && n > bs && s < bn
  })
}

/** Standard ray-casting point-in-polygon test. `ring` and `point` are [lng, lat]. */
function pointInRing(point: [number, number], ring: Ring): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** True if the point falls inside any outer ring of the geometry (holes ignored — none of our polygons have any). */
export function pointInGeometry(point: [number, number], geometry: Geometry): boolean {
  return outerRings(geometry).some((ring) => pointInRing(point, ring))
}

/** Clamp a ring's coordinates into a country bbox — trims cross-border lobes. */
export function clampRingToCountry(ring: Ring, country: keyof typeof COUNTRY_BBOX): Ring {
  const box = COUNTRY_BBOX[country]
  if (!box) return ring
  const [bw, bs, be, bn] = box
  return ring.map(([lng, lat]) => [
    Math.min(Math.max(lng, bw), be),
    Math.min(Math.max(lat, bs), bn),
  ] as [number, number])
}
