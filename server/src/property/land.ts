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
export const MAX_PLAUSIBLE_M2 = 25 * ACRE_M2

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
 * paddocks, orchards, grazing — checked over title, summary, key features and
 * description (Yousef, 2026-09-07: "try some keywords as well"). Deliberately
 * NOT "garden", "land" or "plot" alone: every semi has a garden, "Scotland"
 * and "building plot" would match. Nor (since the first real UK pass,
 * 2026-09-08, 236 false promotions of 8,039) "woodland", bare "acre(s)",
 * "stable(s)" or "equestrian": estate agents write "woodland walks nearby",
 * "acres of countryside", "Acres Estate Agents", "converted stable block" and
 * "equestrian centre" about houses with a patio. Numbered acres are the size
 * parser's job; every keyword match is also checked for "nearby" context and
 * proper-name use by `hasLandKeyword`.
 */
export const FARMLAND_TEXT_RE =
  /\bpaddocks?\b|\borchards?\b|\bstable block and paddocks?\b|\bstables and paddocks?\b|\bequestrian (?:facilities|property|land|use)\b|\bsmallholding\b|\bsmall holding\b|\bpasture\b|\bgrazing\b|\bmenage\b|\bmanège\b|\bpolytunnels?\b|\bhalf an acre\b|\bquarter of an acre\b|\bthird of an acre\b|\bweide\b|\bwiese\b|obstwiese|obstgarten|streuobst|pferdehaltung|pferdestall|\bstallungen?\b|nebengebäude|\bgrundstück (?:von|mit) (?:über |ca\.? ?)?\d|\bfrutteto\b|\buliveto\b|\bvigneto\b|\bterreno agricolo\b|\bstalla\b|\bpascolo\b/i

/** A land word preceded by this within ~60 chars is somebody else's land. */
const NEARBY_BEFORE_RE =
  /(?:nearby|near|neighbour\w*|close to|close by|walks?|trails?|views?|view of|outlook|overlook\w*|backing onto|backs onto|adjacent|surround\w*|access to|distance|minutes|local|country park|park|the area|areas? of|acres of|opportunit\w+|amenit\w+|pursuits|centre|center|club|riding|routes?|explore|community|communal|public|shared|schools?|nestled within|estate of|development|beyond|open space|green spaces?|spaces? of)\W[^.\n]{0,60}$/i
/** …or followed by this within ~30 chars. */
const NEARBY_AFTER_RE =
  /^[^.\n]{0,30}?\b(?:walks?|trails?|nearby|close by|in the area|on the doorstep|centre|center|club|outlook|beyond|views?|of (?:open|public|green|communal|shared|beautiful|stunning|rolling|surrounding|countryside)|open space|countryside|parkland|heathland|primary|school|academy|nursery|plots)\b/i
/** Street names, house names and business names built from land words ("Orchard Close", "The Paddocks", "Acres Estate Agents"). */
const STREET_SUFFIX_RE = /^\s+(?:Close|Road|Rd|Street|St|Lane|Ln|Drive|Dr|Avenue|Ave|Way|Hill|Hills|Park|Court|Ct|Gardens|Green|View|Place|Pl|Crescent|Cres|Grove|Walk|Rise|Terrace|Mews|Row|End|Estate|Farm Road|Estate Agents|at\b|Country Park|Development|Primary|School|Academy|Nursery|Surgery|Church|Inn|Pub|Woods?|House|Cottage|Court)\b/
const HOUSE_NAME_BEFORE_RE = /\bThe\s+(?:Old\s+)?$/

/**
 * FARMLAND_TEXT_RE with context: true only for a match that is not a proper
 * name and not about the neighbourhood. Exported for tests.
 */
export function hasLandKeyword(text: string): boolean {
  const re = new RegExp(FARMLAND_TEXT_RE.source, 'gi')
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0
    const before = text.slice(Math.max(0, start - 80), start)
    const after = text.slice(start + m[0].length, start + m[0].length + 60)
    const capitalised = /^[A-Z]/.test(m[0])
    if (capitalised && (STREET_SUFFIX_RE.test(after) || HOUSE_NAME_BEFORE_RE.test(before))) continue
    if (NEARBY_BEFORE_RE.test(before) || NEARBY_AFTER_RE.test(after)) continue
    return true
  }
  return false
}

const FARMLAND_TYPE_RE =
  /smallholding|small holding|equestrian|farm\s?house|\bfarm\b|\bcroft\b|bauernhaus|resthof|hofstelle|landhaus|reiterhof|\brustico\b|casale|podere|cascina|masseria|agricol/i

function typeWordInTitle(title: string): boolean {
  const re = new RegExp(FARMLAND_TYPE_RE.source, 'gi')
  for (const m of title.matchAll(re)) {
    const start = m.index ?? 0
    const after = title.slice(start + m[0].length, start + m[0].length + 40)
    const before = title.slice(Math.max(0, start - 40), start)
    if (STREET_SUFFIX_RE.test(after) || HOUSE_NAME_BEFORE_RE.test(before)) continue
    // "Willow Farm, Choppington" — a house called X Farm is a name, not a type, unless the title says more.
    if (/^\s*,/.test(after) && /\b[A-Z][a-z]+\s+$/.test(before) && /^farm$/i.test(m[0])) continue
    return true
  }
  return false
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}
const FRACTIONS: Record<string, number> = {
  half: 0.5, 'a half': 0.5, 'one half': 0.5, third: 1 / 3, 'a third': 1 / 3, 'one third': 1 / 3, 'two thirds': 2 / 3,
  quarter: 0.25, 'a quarter': 0.25, 'one quarter': 0.25, 'three quarters': 0.75, 'three-quarters': 0.75,
}

/**
 * Land size from prose. Takes the LARGEST plausible figure — descriptions
 * often mention the paddock and the whole plot separately. Ignores the
 * house's own floor area (sq ft / "square metres of accommodation") and any
 * figure that is about the neighbourhood ("300 hectares of country park").
 * Reads word fractions too ("one third of an acre", "half an acre").
 * Exported for tests.
 */
export function plotAreaFromText(text: string): number | undefined {
  let best: number | undefined
  const consider = (m2: number, index: number, after: string): void => {
    // Prose only: a ≤€300k house "within 215 acres" is describing its surroundings (parks, estates).
    if (m2 < 150 || m2 > MAX_PLAUSIBLE_M2) return
    const before = text.slice(Math.max(0, index - 80), index)
    if (NEARBY_BEFORE_RE.test(before) || NEARBY_AFTER_RE.test(after)) return
    if (best == null || m2 > best) best = m2
  }
  const num = (s: string): number => Number(s.replace(/,/g, ''))
  const afterOf = (m: RegExpMatchArray): string => text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60)
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:-|to|–)?\s*(\d+(?:[.,]\d+)?)?\s*(acres?|ac\b)/gi)) {
    // "the 20 Acres and Humford Woods" — a capitalised unit joined to another proper noun is a place name.
    if (/^Acres?$/.test(m[3]!) && /^\s+(?:and|&)\s+[A-Z]/.test(afterOf(m))) continue
    const a = num(m[1]!)
    const b = m[2] ? num(m[2]) : a
    consider(Math.max(a, b) * ACRE_M2, m.index ?? 0, afterOf(m))
  }
  // "2 hectares", "1.5 ha" — a space before "ha" is required or postcodes ("WV14 8HA") read as hectares.
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)(?:\s*hectares?\b|\s+ha\b)/gi)) consider(num(m[1]!) * HECTARE_M2, m.index ?? 0, afterOf(m))
  for (const m of text.matchAll(/(?:plot|garden|grounds|land)[^.\n]{0,40}?(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*m\b|sqm\b|m²|m2\b|square met(?:re|er)s?)/gi)) consider(num(m[1]!), m.index ?? 0, afterOf(m))
  // "one third of an acre", "half an acre", "three quarters of an acre", "two acres"
  for (const m of text.matchAll(/\b(a half|one half|half|a third|one third|third|two thirds|a quarter|one quarter|quarter|three[- ]quarters)\s+(?:of\s+)?an?\s+acre\b/gi)) {
    consider((FRACTIONS[m[1]!.toLowerCase().replace(/-/g, ' ')] ?? 0) * ACRE_M2, m.index ?? 0, afterOf(m))
  }
  for (const m of text.matchAll(/(?<!\bof\s)\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+acres?\b/gi)) {
    consider((WORD_NUMBERS[m[1]!.toLowerCase()] ?? 0) * ACRE_M2, m.index ?? 0, afterOf(m))
  }
  // "0.07 of an acre", "0.26 of an acre"
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s+of\s+an\s+acre\b/gi)) consider(Number(m[1]) * ACRE_M2, m.index ?? 0, afterOf(m))
  return best != null ? Math.round(best) : undefined
}


/**
 * Which layer a listing belongs on. A search declared `farmland` is farmland;
 * otherwise a house is promoted when its type says so, its plot is at least
 * FARMLAND_MIN_PLOT_M2, or its text claims that much land. "House + land
 * only": rows with no bedrooms at all are bare land and never promoted here —
 * the house searches don't return them, and the farmland clients drop them.
 */
/** Portals with no structured plot field — any stored plotArea there was parsed out of prose and is re-derived here under the current rules. */
const PROSE_PLOT_PORTALS = new Set(['rightmove', 'onthemarket'])

export function listingKind(l: Pick<Listing, 'propertyType' | 'title' | 'plotArea' | 'summary' | 'keyFeatures' | 'description' | 'bedrooms'> & { portal?: string }, searchKind: PropertyKind): PropertyKind {
  // A plot search is the only way onto the plot layer, and never off it: a
  // "Plot with planning permission for a 4-bed house" is a plot, not a house.
  if (searchKind === 'plot') return 'plot'
  if (searchKind === 'farmland') return 'farmland'
  if (FARMLAND_TYPE_RE.test(l.propertyType ?? '')) return 'farmland'
  // In the title the same words are often a street or house name ("Pitts Farm Road", "Willow Farm Close").
  if (typeWordInTitle(l.title ?? '')) return 'farmland'
  const text = [l.title ?? '', l.summary ?? '', ...(l.keyFeatures ?? []), l.description ?? ''].join('\n')
  // A portal's own plot field is trusted at any size (a 12 ha rustico at €250k is real); only prose gets the plausibility cap.
  const stated = l.plotArea != null && !(l.portal && PROSE_PLOT_PORTALS.has(l.portal)) ? l.plotArea : undefined
  const plot = stated ?? plotAreaFromText(text)
  if (plot != null && plot >= FARMLAND_MIN_PLOT_M2) return 'farmland'
  // A stated plot BELOW the floor is the author telling us the size — believe
  // it over a keyword ("orchard" in a 300 m² garden is a fruit tree).
  if (plot == null && hasLandKeyword(text)) return 'farmland'
  return 'house'
}

type ListingText = Pick<Listing, 'title' | 'summary' | 'keyFeatures' | 'description'>
const textOf = (l: ListingText): string => [l.title ?? '', l.summary ?? '', ...(l.keyFeatures ?? []), l.description ?? ''].join('\n')

/**
 * Sentences that talk about planning the seller does NOT have: "subject to
 * planning", "planning potential", "lapsed/refused/no planning", holiday-let
 * consents (occupancy-restricted, not a home). Dropped before the positive
 * test so "Planning Potential Subject to planning permission (Local Plan)"
 * cannot pass on its own words.
 */
const PLANNING_NEGATIVE_RE =
  /\bsubject to\b|\bstpp\b|\b(?:planning|development)\s+potential\b|\bpotential\s+(?:for|to)\b|\bscope\s+(?:for|to)\b|\bmay\s+be\s+suitable\b|\b(?:lapsed|expired|previous(?:ly)?|refused|withdrawn|no|without|pre-?)\s+(?:\w+\s+)?planning\b|\bholiday\b|\bpre-?app(?:lication)?\b/i
const PLANNING_POSITIVE_RE =
  /\b(?:full|detailed|outline|outlined)\s+planning\b|\bplanning\s+(?:permission|consent|approval)\s+(?:in\s+principle|granted|approved|obtained|secured|in\s+place|exists|has\s+been|was\s+granted|for\s+(?:a|an|the|one|two|three|four|five|six|\d)\b)|\bpermission\s+in\s+principle\b|\bwith\s+(?:the\s+benefit\s+of\s+)?(?:full\s+|outline\s+|detailed\s+)?planning\b|\bbenefit(?:ing|s)?\s+(?:from|of)\s+(?:full\s+|outline\s+|detailed\s+)?planning\b|\bplanning\s+ref(?:erence)?\b|\bconsented\s+(?:site|plot|scheme|development)\b|\bapproved\s+plans?\b|\b(?:PP|PIP)\s+(?:granted|for)\b/i

/**
 * Does this land listing carry planning consent for a dwelling? Fail-CLOSED:
 * the plot layer is "bare land with planning permission" (Yousef, 2026-09-11),
 * so a paddock, a strip sold at auction for £2k or a site "with potential" is
 * not drawn until its text says the permission exists. Rightmove land
 * summaries state it up front ("Plot with Planning Permission – …", "planning
 * permission for a 4 bed detached house"), so pre-enrichment rows still pass.
 */
export function planningLike(l: ListingText): boolean {
  return textOf(l)
    .split(/[.;\n]|\*\*|\s[-–]\s/)
    .some((sentence) => !PLANNING_NEGATIVE_RE.test(sentence) && PLANNING_POSITIVE_RE.test(sentence))
}

/**
 * Estate-agent phrasing for a house that needs work. Calibrated on the live
 * UK inventory (15,035 rows, 2026-09-11): 1,439 hits with this set minus the
 * three that were noise — "blank canvas" is a garden-landscaping cliché,
 * "structural defects" is the new-build warranty boilerplate, "subsidence" is
 * the material-information "History of subsidence: No" line. German and
 * Italian equivalents included so DE/IT pins flag the same way.
 */
export const FIXER_RE =
  /\b(?:in need of|requires?|requiring|needs?|needing|would benefit from|ready for|ripe for|awaiting)\s+(?:some\s+|complete\s+|full\s+|total\s+|general\s+|extensive\s+|significant\s+|considerable\s+|cosmetic\s+|a\s+(?:programme|program|scheme|degree|level|little|lot)\s+of\s+)?(?:modernis|moderniz|renovat|refurbish|updating|upgrading|improvement|repair|attention|TLC\b|work\b)|\b(?:renovation|refurbishment|modernisation|modernization|improvement)\s+(?:project|opportunity)|\bproject\s+(?:property|house|home)\b|\bdoer[- ]?upper|\bfixer[- ]?upper|\bun-?modernised|\bcash\s+(?:buyers?|purchasers?)\s+only|\bstructural\s+(?:issues|movement|repairs?)|\bsuspected\s+subsidence|\bfire[- ]damaged|\bderelict|\bdilapidated|\bsanierungsbed(?:ü|ue)rftig|\brenovierungsbed(?:ü|ue)rftig|\bsanierungsobjekt|\bmodernisierungsbedarf|\bhandwerker(?:haus|objekt)?\b|\bf(?:ü|ue)r\s+handwerker\b|\bda\s+ristrutturare\b|\bda\s+rinnovare\b|\bda\s+sistemare\b|\bda\s+riattare\b|\ballo\s+stato\s+grezzo\b|\bal\s+grezzo\b/i

export function fixerLike(l: ListingText): boolean {
  return FIXER_RE.test(textOf(l))
}
