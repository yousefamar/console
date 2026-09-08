// Where a listing sits, not what it is: distance to a real high street, and
// the new-build-estate tell in the text.
//
// Yousef, 2026-09-08 (^brisk-owl): the suburbia he hates is "rows and rows of
// houses where the only way to get to a high street is by car", and his bar is
// a high street within ~5 minutes on foot. That is a property of the PLACE,
// which no portal filters on, so it runs locally at draw time like the zone
// clip. The high-street points come from the vault's OSM shop pipeline
// (`build-high-streets.mjs` → `data/high-streets.geojson`: one point per
// ~100 m cell whose 300 m neighbourhood holds ≥ 10 shops/cafés). Distance is
// straight-line to the nearest such point — a proxy for walking time that
// errs generous (rivers, railways), tuned by the threshold, not the metric.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { haversineKm } from './geo.js'
import type { Listing } from './types.js'

/** ~5 min on foot, straight-line, to the centre of a 300 m high-street cell. */
export const DEFAULT_MAX_HIGH_STREET_M = 400

interface HighStreetPoint {
  lon: number
  lat: number
  shops: number
}

/**
 * Nearest-high-street lookups over a grid hash. Reloads when the file's mtime
 * changes (the vault rebuilds it in place), so the hub never needs a restart
 * for new shop data. Missing file = no index = the filter passes everything
 * and pins carry no distance.
 */
export class HighStreetIndex {
  private cells = new Map<string, HighStreetPoint[]>()
  private loadedMtime = -1
  private count = 0
  private readonly memo = new Map<string, number>()
  /** Grid cell size in degrees of latitude (~1.1 km); lon cells scaled per row. */
  private readonly cell = 0.01

  constructor(private readonly file: string, private readonly log: (msg: string) => void = () => {}) {}

  /** Points loaded (0 = no data). */
  size(): number {
    this.refresh()
    return this.count
  }

  /** Metres to the nearest high-street cell centre, or null with no data. */
  nearestM(lat: number, lon: number): number | null {
    this.refresh()
    if (!this.count) return null
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`
    const hit = this.memo.get(key)
    if (hit != null) return hit
    let best = Number.POSITIVE_INFINITY
    // Search the 3×3 neighbourhood of grid cells, widening once if empty —
    // anything beyond ~3 km is "not walkable" whatever the exact figure.
    for (let ring = 1; ring <= 3 && best === Number.POSITIVE_INFINITY; ring++) {
      const [cx, cy] = this.cellOf(lat, lon)
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          const pts = this.cells.get(`${cx + dx},${cy + dy}`)
          if (!pts) continue
          for (const p of pts) {
            const d = haversineKm([lon, lat], [p.lon, p.lat]) * 1000
            if (d < best) best = d
          }
        }
      }
    }
    const m = best === Number.POSITIVE_INFINITY ? 5000 : Math.round(best)
    this.memo.set(key, m)
    return m
  }

  private cellOf(lat: number, lon: number): [number, number] {
    const dLon = this.cell / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
    return [Math.floor(lon / dLon), Math.floor(lat / this.cell)]
  }

  private refresh(): void {
    let mtime = -1
    try {
      if (existsSync(this.file)) mtime = statSync(this.file).mtimeMs
    } catch {
      mtime = -1
    }
    if (mtime === this.loadedMtime) return
    this.loadedMtime = mtime
    this.cells = new Map()
    this.memo.clear()
    this.count = 0
    if (mtime < 0) return
    try {
      const gj = JSON.parse(readFileSync(this.file, 'utf8')) as { features?: Array<{ geometry?: { coordinates?: [number, number] }; properties?: { shops?: number } }> }
      for (const f of gj.features ?? []) {
        const c = f.geometry?.coordinates
        if (!c) continue
        const p: HighStreetPoint = { lon: c[0], lat: c[1], shops: f.properties?.shops ?? 0 }
        const [cx, cy] = this.cellOf(p.lat, p.lon)
        const key = `${cx},${cy}`
        const arr = this.cells.get(key)
        if (arr) arr.push(p)
        else this.cells.set(key, [p])
        this.count++
      }
      this.log(`[property-place] loaded ${this.count} high-street cells from ${this.file}`)
    } catch (e) {
      this.log(`[property-place] failed to read ${this.file}: ${(e as Error).message}`)
    }
  }
}

/**
 * Developer / new-build-estate wording. Deliberately the marketing tells
 * (developer names, "show home", "help to buy", "plot 12", "phase 2") and
 * not "modern" or the street type — a 1930s semi on "Orchard Close" is not an
 * estate, and a Victorian terrace can be "newly refurbished".
 */
export const NEW_BUILD_RE =
  /\b(new[- ]?build|newly[- ]built|brand[- ]new (?:home|house|development)|new (?:home|homes) development|show ?home|help to buy|deposit unlock|part[- ]exchange|first homes scheme|(?:plot|unit) \d{1,4}\b|phase \d|the (?:orchard|meadows|paddocks|grange|willows|gables|copse|spinney) at\b|barratt|persimmon|taylor wimpey|bellway|redrow|david wilson homes|bloor homes|crest nicholson|vistry|countryside (?:homes|partnerships)|linden homes|miller homes|keepmoat|avant homes|cala homes|st\.? modwen|bovis|charles church|strata homes|story homes|tilia homes|neubau(?:projekt|gebiet|vorhaben)?\b|erstbezug|schlüsselfertig|bauträger|nuova costruzione|in costruzione|cantiere|classe energetica a4 nuovo)\b/i

export function newBuildLike(l: Pick<Listing, 'title' | 'summary' | 'keyFeatures' | 'description' | 'propertyType'>): boolean {
  return NEW_BUILD_RE.test(`${l.propertyType ?? ''}\n${l.title ?? ''}\n${l.summary ?? ''}\n${(l.keyFeatures ?? []).join('\n')}\n${l.description ?? ''}`)
}
