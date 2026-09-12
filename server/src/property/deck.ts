// The review deck — the map's unreviewed pins as swipeable cards.
//
// A card is one drawn pin's listing with the detail the popup leaves out
// (description, key features, tenure, raw price) so the phone can show a
// Tinder-style card without a second request per listing. The SET is exactly
// what `PropertySync.reviewable()` draws, minus anything already judged:
// interested listings are decided, dismissed ones are gone, so the deck is
// the triage queue and nothing else.

import type { PropertyKind, PropertySearch } from './store.js'
import type { Listing, Portal } from './types.js'

/** Descriptions run to several thousand chars; the card sheet needs the gist, the portal page has the rest. */
export const DECK_DESCRIPTION_MAX = 2000
export const DECK_DEFAULT_LIMIT = 30
export const DECK_MAX_LIMIT = 200

export interface DeckCard {
  listingId: string
  searchId: string
  kind: PropertyKind
  tier?: string
  portal: Portal
  /** Portals that also list this house (cross-portal duplicates grouped onto the primary copy). */
  alsoOn: Portal[]
  country: PropertySearch['country']
  url: string
  title?: string
  address?: string
  /** Major units, raw — the client formats per currency. */
  price?: number
  currency: string
  bedrooms?: number
  bathrooms?: number
  /** m² */
  floorArea?: number
  /** m² */
  plotArea?: number
  propertyType?: string
  tenure?: string
  listedAt?: string
  agent?: string
  image?: string
  summary?: string
  keyFeatures?: string[]
  description?: string
  /** `fixerLike()` — needs work. */
  fixer: boolean
  /** "320 m to shops", as on the pin. */
  highStreet?: string
  /** "42min drive / 70min transit to LHR", as on the pin. */
  airport?: string
  lat: number
  lon: number
}

export interface DeckCardInput {
  listing: Listing
  search: PropertySearch
  kind: PropertyKind
  tier?: string
  fixer: boolean
  alsoOn: Portal[]
  highStreet?: string
  airport?: string
}

export function toDeckCard(i: DeckCardInput): DeckCard {
  const { listing: l, search: s } = i
  const description = l.description && l.description.length > DECK_DESCRIPTION_MAX ? l.description.slice(0, DECK_DESCRIPTION_MAX - 1).trimEnd() + '…' : l.description
  return {
    listingId: l.id,
    searchId: s.id,
    kind: i.kind,
    ...(i.tier ? { tier: i.tier } : {}),
    portal: l.portal,
    alsoOn: i.alsoOn,
    country: s.country,
    url: l.url,
    title: l.title,
    address: l.address,
    price: l.price,
    currency: l.currency,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    floorArea: l.floorArea,
    plotArea: l.plotArea,
    propertyType: l.propertyType,
    tenure: l.tenure,
    listedAt: l.listedAt,
    agent: l.agent,
    image: l.image,
    summary: l.summary,
    keyFeatures: l.keyFeatures,
    description,
    fixer: i.fixer,
    highStreet: i.highStreet,
    airport: i.airport,
    lat: l.lat!,
    lon: l.lon!,
  }
}

/** Newest first; rows with no listing date (immobiliare never exposes one) go last, in stable order. */
export function sortDeck<T extends { listedAt?: string }>(cards: T[]): T[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const da = a.c.listedAt ?? ''
      const db = b.c.listedAt ?? ''
      if (da !== db) return db.localeCompare(da)
      return a.i - b.i
    })
    .map((x) => x.c)
}

export function clampDeckLimit(raw: string | null): number {
  const n = parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return DECK_DEFAULT_LIMIT
  return Math.min(n, DECK_MAX_LIMIT)
}
