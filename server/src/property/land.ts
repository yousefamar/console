// Land: parsing plot sizes out of prose, and deciding whether a listing is a
// smallholding for the farmland layer.

import type { Listing } from './types.js'
import type { PropertyKind } from './store.js'

export const ACRE_M2 = 4046.86
export const HECTARE_M2 = 10_000

/**
 * Plot size from which a house counts as a smallholding and moves to the
 * `property/farmland` layer. PLACEHOLDER — Yousef has not yet given the
 * minimum land size (asked 2026-09-07); 2,000 m² ≈ half an acre.
 */
export const FARMLAND_MIN_PLOT_M2 = 2000

const FARMLAND_TYPE_RE =
  /smallholding|small holding|equestrian|farm\s?house|\bfarm\b|\bcroft\b|bauernhaus|resthof|hofstelle|landhaus|reiterhof|\brustico\b|casale|podere|cascina|masseria|agricol/i

/**
 * Land size from prose. Takes the LARGEST plausible figure — descriptions
 * often mention the paddock and the whole plot separately. Ignores the
 * house's own floor area (sq ft / "square metres of accommodation").
 * Exported for tests.
 */
export function plotAreaFromText(text: string): number | undefined {
  let best: number | undefined
  const consider = (m2: number): void => {
    if (m2 < 150 || m2 > 500 * ACRE_M2) return
    if (best == null || m2 > best) best = m2
  }
  const num = (s: string): number => Number(s.replace(/,/g, ''))
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:-|to|–)?\s*(\d+(?:[.,]\d+)?)?\s*(acres?|ac\b)/gi)) {
    const a = num(m[1]!)
    const b = m[2] ? num(m[2]) : a
    consider(Math.max(a, b) * ACRE_M2)
  }
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(hectares?|ha\b)/gi)) consider(num(m[1]!) * HECTARE_M2)
  for (const m of text.matchAll(/(?:plot|garden|grounds|land)[^.\n]{0,40}?(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*m\b|sqm\b|m²|m2\b|square met(?:re|er)s?)/gi)) consider(num(m[1]!))
  return best != null ? Math.round(best) : undefined
}


/**
 * Which layer a listing belongs on. A search declared `farmland` is farmland;
 * otherwise a house is promoted when its type says so, its plot is at least
 * FARMLAND_MIN_PLOT_M2, or its text claims that much land. "House + land
 * only": rows with no bedrooms at all are bare land and never promoted here —
 * the house searches don't return them, and the farmland clients drop them.
 */
export function listingKind(l: Pick<Listing, 'propertyType' | 'title' | 'plotArea' | 'summary' | 'keyFeatures' | 'description' | 'bedrooms'>, searchKind: PropertyKind): PropertyKind {
  if (searchKind === 'farmland') return 'farmland'
  if (FARMLAND_TYPE_RE.test(`${l.propertyType ?? ''} ${l.title ?? ''}`)) return 'farmland'
  const plot = l.plotArea ?? plotAreaFromText([l.summary ?? '', ...(l.keyFeatures ?? []), l.description ?? ''].join('\n'))
  if (plot != null && plot >= FARMLAND_MIN_PLOT_M2) return 'farmland'
  return 'house'
}
