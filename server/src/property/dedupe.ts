// Cross-portal duplicate detection for the kind layers.
//
// Most agents syndicate the same house to several portals, so once a country
// has more than one search (Rightmove + OnTheMarket + Zoopla…) the map would
// show the same front door two or three times. Portals give no shared id, so
// this matches on what they do share: a position and a price. Coordinates are
// exact on Rightmove/immobiliare and usually on the aggregators; IS24 sometimes
// snaps co-located listings to one marker, so the radius is generous.

export interface DedupeCandidate {
  lat: number
  lon: number
  price?: number
  bedrooms?: number
  /**
   * Where the row came from (search id). Two rows from the same source are
   * never the same house — the portal's own ids are the identity there — so
   * co-located flats in one block, or IS24's marker-snapped listings, stay
   * separate pins.
   */
  source?: string
  /** Coordinates are an area centroid, not the house — never a dedupe match. */
  fuzzy?: boolean
}

/** Same house if within this many metres… */
const RADIUS_M = 60
/** …and the prices agree to within this fraction (or this many currency units, whichever is larger). */
const PRICE_TOLERANCE = 0.015
const PRICE_TOLERANCE_ABS = 1500

const CELL_DEG = 0.002 // ~220 m at 50°N — neighbours are checked, so RADIUS_M just has to be < one cell

function metres(a: DedupeCandidate, b: DedupeCandidate): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function sameHouse(a: DedupeCandidate, b: DedupeCandidate): boolean {
  if (a.source != null && a.source === b.source) return false
  if (a.fuzzy || b.fuzzy) return false
  if (metres(a, b) > RADIUS_M) return false
  if (a.price != null && b.price != null) {
    const tol = Math.max(PRICE_TOLERANCE_ABS, PRICE_TOLERANCE * Math.max(a.price, b.price))
    if (Math.abs(a.price - b.price) > tol) return false
  } else if (a.bedrooms != null && b.bedrooms != null && a.bedrooms !== b.bedrooms) {
    // No price to compare on — fall back to bedrooms, which every portal has.
    return false
  }
  if (a.bedrooms != null && b.bedrooms != null && Math.abs(a.bedrooms - b.bedrooms) > 1) return false
  return true
}

/**
 * Group candidates that look like the same house. Order within a group is the
 * input order, so callers that want a preferred member first should sort
 * before calling. O(n) via a lat/lon grid; only neighbouring cells are compared.
 */
export function groupDuplicates<T extends DedupeCandidate>(items: T[]): T[][] {
  const cells = new Map<string, number[]>()
  const key = (lat: number, lon: number) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`
  items.forEach((it, i) => {
    const k = key(it.lat, it.lon)
    const bucket = cells.get(k)
    if (bucket) bucket.push(i)
    else cells.set(k, [i])
  })

  const groupOf = new Array<number>(items.length).fill(-1)
  const groups: T[][] = []
  items.forEach((it, i) => {
    if (groupOf[i] !== -1) return
    const g: T[] = [it]
    groupOf[i] = groups.length
    const clat = Math.floor(it.lat / CELL_DEG)
    const clon = Math.floor(it.lon / CELL_DEG)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const j of cells.get(`${clat + dy}:${clon + dx}`) ?? []) {
          if (j <= i || groupOf[j] !== -1) continue
          if (sameHouse(it, items[j]!)) {
            groupOf[j] = groups.length
            g.push(items[j]!)
          }
        }
      }
    }
    groups.push(g)
  })
  return groups
}
