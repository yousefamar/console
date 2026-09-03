// "Only when it's really good" — a stricter gate applied to genuinely-new
// listings BEFORE they buzz the phone. Distinct from a search's `criteria`
// (what the portal is asked for → what lands on the map) and from
// `notifyLayer` (WHERE a listing must be to notify): this is WHAT a listing
// must be. Everything here is evaluated locally against the listing itself,
// so it works identically on all three portals and on fields the portal
// can't filter server-side.
//
// Strictness rule: a field the gate asks about but the listing doesn't
// expose FAILS the gate (unlike `postFilter`, which passes unknowns). A
// notification is a claim that this one is worth a look — "unknown" is not
// evidence of that. Consequence worth knowing: Rightmove never exposes plot
// area, so `minPlotArea` here would silence a UK search entirely.

import type { Listing } from './types.js'

export interface NotifyCriteria {
  maxPrice?: number
  minBedrooms?: number
  /** m² — see the strictness rule above before setting this on a UK search. */
  minPlotArea?: number
  minFloorArea?: number
  /**
   * Allowed house types, in the portable `Criteria.houseSubtypes` vocabulary
   * (`detached | semi-detached | terraced | bungalow | villa | farmhouse | land`).
   * Matched against the listing's own `propertyType` text via
   * `normaliseHouseType`; a type that can't be classified fails.
   */
  houseSubtypes?: string[]
  /** Any-of, case-insensitive, over title + summary + address. */
  keywords?: string[]
  /**
   * Real drive time to the nearest airport in the country's static list
   * (`airport-distance.ts`). Needs the lookup to have run — PropertySync
   * computes it for the candidates that survive the other gates first.
   */
  maxAirportDriveMinutes?: number
}

export type HouseType = 'detached' | 'semi-detached' | 'terraced' | 'bungalow' | 'villa' | 'farmhouse' | 'land'

/**
 * Portal `propertyType` text → the portable vocabulary, or null when it says
 * nothing about attachment ("House", "Not Specified", "Town House").
 * Rightmove strings seen live: "Detached", "Detached Bungalow", "Detached
 * Villa", "Link Detached House", "Semi-Detached", "Semi-Detached Bungalow",
 * "Semi-detached Villa", "Bungalow", "Terraced Bungalow", "Cottage", "Villa".
 * A "Detached Bungalow" is both — it passes a gate naming either.
 */
export function normaliseHouseType(propertyType: string | undefined): HouseType[] {
  const t = (propertyType ?? '').toLowerCase()
  if (!t) return []
  const out = new Set<HouseType>()
  const semi = /semi[- ]?detached|doppelhaus|reihenend|bifamiliare/.test(t)
  const terraced = /terrace|end of terrace|mid terrace|reihenhaus|a schiera|townhouse|town house/.test(t)
  if (semi) out.add('semi-detached')
  if (terraced) out.add('terraced')
  if (!semi && !terraced && /detached|einfamilienhaus|freistehend|indipendente|unifamiliare/.test(t)) out.add('detached')
  if (/bungalow/.test(t)) out.add('bungalow')
  if (/villa/.test(t)) out.add('villa')
  if (/farm|cottage|bauernhaus|rustico|casale|cascina|masseria|smallholding|barn/.test(t)) out.add('farmhouse')
  if (/\bland\b|plot|grundst|terreno/.test(t)) out.add('land')
  return [...out]
}

/** Which gate a listing fails, or null when it passes every set field. */
export function notifyRejection(l: Listing, nc: NotifyCriteria): string | null {
  if (nc.maxPrice != null && (l.price == null || l.price > nc.maxPrice)) return 'price'
  if (nc.minBedrooms != null && (l.bedrooms == null || l.bedrooms < nc.minBedrooms)) return 'bedrooms'
  if (nc.minPlotArea != null && (l.plotArea == null || l.plotArea < nc.minPlotArea)) return 'plot'
  if (nc.minFloorArea != null && (l.floorArea == null || l.floorArea < nc.minFloorArea)) return 'floorArea'
  if (nc.houseSubtypes?.length) {
    const types = normaliseHouseType(l.propertyType)
    const wanted = new Set(nc.houseSubtypes.map((s) => s.toLowerCase()))
    // A semi is never "detached" even if its text also says bungalow/villa —
    // the attachment class is the whole point of asking.
    if (types.includes('semi-detached') && !wanted.has('semi-detached')) return 'houseType'
    if (types.includes('terraced') && !wanted.has('terraced')) return 'houseType'
    if (!types.some((t) => wanted.has(t))) return 'houseType'
  }
  if (nc.keywords?.length) {
    const hay = `${l.title ?? ''} ${l.summary ?? ''} ${l.address ?? ''}`.toLowerCase()
    if (!nc.keywords.some((k) => hay.includes(k.toLowerCase()))) return 'keywords'
  }
  if (nc.maxAirportDriveMinutes != null) {
    const d = l.nearestAirport?.driveMinutes
    if (d == null || d > nc.maxAirportDriveMinutes) return 'airportDrive'
  }
  return null
}

export function passesNotifyCriteria(l: Listing, nc: NotifyCriteria | undefined): boolean {
  return !nc || notifyRejection(l, nc) === null
}

/** True when the gate needs `nearestAirport` populated before it can decide. */
export function needsAirportDistance(nc: NotifyCriteria | undefined): boolean {
  return nc?.maxAirportDriveMinutes != null
}

/** Every gate other than the airport one — what can be decided before any lookup. */
export function withoutAirportGate(nc: NotifyCriteria): NotifyCriteria {
  const { maxAirportDriveMinutes: _drop, ...rest } = nc
  return rest
}
