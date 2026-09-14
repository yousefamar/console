// "What's the catch?" — marking a listing interested files a vetting card on
// the home board, the card Yousef had been writing by hand for every house he
// liked (^trim-bass, ^cosy-pony, ^gold-kiwi). The text keeps his exact
// phrasing so hand-filed and auto-filed cards look the same and dedupe
// against each other by listing URL.

import type { Listing } from './types.js'
import type { PropertySearch } from './store.js'

export interface InterestCard {
  text: string
  detail: string[]
}

/** Vault path (relative to the home project dir) of the vetting procedure the card points at. */
export const VETTING_DOC = 'listing-vetting.md'

/**
 * A portal URL reduced to what identifies the listing: no fragment/query, no
 * trailing slash, lower-cased. Hand-filed cards paste `…/properties/93068658#/`,
 * the client stores `…/properties/93068658`; both must match.
 */
export function listingUrlKey(url: string): string {
  return url.split(/[#?]/)[0]!.replace(/\/+$/, '').toLowerCase()
}

/**
 * A card already about this listing, in ANY column — one vetting per listing,
 * ever; a Done card is the answer, not a reason to ask again. Matches the URL
 * key against the card text and its detail lines.
 */
export function findInterestCard<C extends { text: string; detail: string[]; blockId: string | null }>(
  columns: Array<{ title: string; cards: C[] }>,
  url: string,
): { column: string; card: C } | undefined {
  const key = listingUrlKey(url)
  if (!key) return undefined
  // Boundary after the key: `…/properties/9` must not match `…/properties/93068658`.
  const re = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_-])`, 'i')
  for (const col of columns) {
    for (const card of col.cards) {
      if (re.test([card.text, ...card.detail].join('\n'))) return { column: col.title, card }
    }
  }
  return undefined
}

/** The slice of BoardOps this needs — keeps the module testable against the real class or a stub. */
export interface InterestBoard {
  show(project: string): Promise<{ columns: Array<{ title: string; cards: Array<{ text: string; detail: string[]; blockId: string | null }> }> }>
  add(project: string, text: string, opts: { column?: string; agentKey?: string; detail?: string[]; top?: boolean }): Promise<{ column: string; blockId: string | null }>
}

export interface InterestCardTarget {
  project: string
  owner: string
  column: string
}

/** Default target: the home board, In Progress (dispatched at once), owned by the Home agent. */
export const DEFAULT_INTEREST_TARGET: InterestCardTarget = { project: 'home', owner: 'home', column: 'In Progress' }

/**
 * File the vetting card for a newly-interested listing, unless the board
 * already has one for that URL. Returns what happened, for the hub log.
 */
export async function fileInterestCard(board: InterestBoard, l: Listing, s: PropertySearch, target: InterestCardTarget = DEFAULT_INTEREST_TARGET): Promise<{ filed: false; column: string; blockId: string | null } | { filed: true; column: string; blockId: string | null }> {
  const { columns } = await board.show(target.project)
  const existing = findInterestCard(columns, l.url)
  if (existing) return { filed: false, column: existing.column, blockId: existing.card.blockId }
  const { text, detail } = buildInterestCard(l, s)
  const card = await board.add(target.project, text, { column: target.column, agentKey: target.owner, detail, top: true })
  return { filed: true, column: card.column, blockId: card.blockId }
}

export function buildInterestCard(l: Listing, s: PropertySearch): InterestCard {
  const facts = [
    priceText(l),
    typeText(l),
    l.tenure,
    l.plotArea != null ? `${Math.round(l.plotArea)} m² plot` : undefined,
    l.floorArea != null ? `${Math.round(l.floorArea)} m² floor` : undefined,
    l.address ?? l.title,
  ].filter((x): x is string => Boolean(x))
  const where = `${s.kind ?? 'house'}${s.tier ? `-${s.tier}` : ''} search ${s.id} (${s.country}, ${l.portal} ${l.id})`
  return {
    text: `What's the catch? ${l.url}`,
    detail: [
      `Marked interested on the map: ${facts.join(' · ')} — ${where}.`,
      `Vet it per \`${VETTING_DOC}\` (stored row: \`con map property inventory ${s.id} | jq '.entries[] | select(.id=="${l.id}")'\`); report to \`research/listings/${l.portal}-${l.id}.md\`, verdict + catches as \`- \` bullets on this card.`,
    ],
  }
}

function priceText(l: Listing): string | undefined {
  if (l.price == null) return undefined
  const symbol = l.currency === 'GBP' ? '£' : l.currency === 'EUR' ? '€' : ''
  const n = Math.round(l.price).toLocaleString('en-GB')
  return symbol ? `${symbol}${n}` : `${n} ${l.currency}`
}

function typeText(l: Listing): string | undefined {
  const beds = l.bedrooms != null ? `${l.bedrooms} bed` : undefined
  const type = l.propertyType?.trim() || undefined
  if (beds && type) return `${beds} ${type.toLowerCase()}`
  return beds ?? type
}
