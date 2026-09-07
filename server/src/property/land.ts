// Land: parsing plot sizes out of prose, and deciding whether a listing is a
// smallholding for the farmland layer.

import type { Listing } from './types.js'
import type { PropertyKind } from './store.js'

/** "Tenure: Freehold", "FREEHOLD", "Share of Freehold", "Leasehold (99 years)" → a normalised token. */
export function normaliseTenure(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const t = raw.toLowerCase()
  if (/share\s*of\s*freehold|share_of_freehold|flying\s*freehold/.test(t)) return 'share-of-freehold'
  if (/commonhold/.test(t)) return 'commonhold'
  if (/leasehold/.test(t)) return 'leasehold'
  if (/freehold/.test(t)) return 'freehold'
  if (/feudal|absolute ownership|heritable|ownership/.test(t)) return 'freehold' // Scottish outright ownership
  return t.trim() || undefined
}

export const ACRE_M2 = 4046.86
export const HECTARE_M2 = 10_000

/**
 * Plot size from which a house counts as a smallholding and moves to the
 * `property/farmland` layer. Yousef, 2026-09-07: "enough for a food forest /
 * permaculture garden, not becoming a full-on farmer" — first 2,000 m², then
 * lowered the same evening to 1,000 m² (a quarter acre) because UK
 * house-with-land ≤ £300k barely exists above that. No upper cap (the price
 * already caps it); the target is house-with-land, not working farms.
 */
export const FARMLAND_MIN_PLOT_M2 = 1000

/**
 * Words that mean "there is land here" even when nobody wrote a number —
 * paddocks, orchards, stables — checked over title, summary, key features and
 * description (Yousef, 2026-09-07: "try some keywords as well"). Deliberately
 * NOT "garden", "land" or "plot" alone: every semi has a garden, "Scotland"
 * and "building plot" would match.
 */
export const FARMLAND_TEXT_RE =
  /\bpaddocks?\b|\borchards?\b|\bstables?\b|\bstable block\b|\bequestrian\b|\bsmallholding\b|\bsmall holding\b|\bwoodland\b|\bpasture\b|\bgrazing\b|\bmenage\b|\bmanège\b|\bpolytunnel\b|\bhalf an acre\b|\bquarter of an acre\b|\bthird of an acre\b|\bacre\b|\bacres\b|\bhectares?\b|\bweide\b|\bwiese\b|obstwiese|obstgarten|streuobst|pferdehaltung|pferdestall|\bstallungen?\b|nebengebäude|\bgrundstück (?:von|mit) (?:über |ca\.? ?)?\d|\bfrutteto\b|\buliveto\b|\bvigneto\b|\bterreno agricolo\b|\bstalla\b|\bpascolo\b/i

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
  const text = [l.title ?? '', l.summary ?? '', ...(l.keyFeatures ?? []), l.description ?? ''].join('\n')
  const plot = l.plotArea ?? plotAreaFromText(text)
  if (plot != null && plot >= FARMLAND_MIN_PLOT_M2) return 'farmland'
  // A stated plot BELOW the floor is the author telling us the size — believe
  // it over a keyword ("orchard" in a 300 m² garden is a fruit tree).
  if (plot == null && FARMLAND_TEXT_RE.test(text)) return 'farmland'
  return 'house'
}
