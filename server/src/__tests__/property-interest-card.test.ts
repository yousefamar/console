import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoteStore } from '../notes.js'
import { BoardOps } from '../kanban/board-ops.js'
import { parseBoard } from '../kanban/board.js'
import { PropertySearchStore } from '../property/store.js'
import { PropertyInventoryStore } from '../property/inventory.js'
import { PropertySync } from '../property/sync.js'
import { buildInterestCard, fileInterestCard, findInterestCard, listingUrlKey } from '../property/interest-card.js'
import type { Listing } from '../property/types.js'
import type { PropertySearch } from '../property/store.js'

const listing = (over: Partial<Listing> = {}): Listing => ({
  portal: 'rightmove', id: '93068658', url: 'https://www.rightmove.co.uk/properties/93068658', currency: 'GBP',
  price: 285000, bedrooms: 3, propertyType: 'Detached', tenure: 'freehold', address: 'High Street, Tonbridge, TN9', ...over,
})
const search = (over: Partial<PropertySearch> = {}): PropertySearch => ({ id: 'ps_abc', country: 'UK', layer: 'where-to-move/livable-zone', criteria: {}, ...over } as PropertySearch)

describe('listingUrlKey', () => {
  it('strips fragment, query and trailing slash so a hand-pasted URL matches the stored one', () => {
    expect(listingUrlKey('https://www.rightmove.co.uk/properties/93068658#/')).toBe('https://www.rightmove.co.uk/properties/93068658')
    expect(listingUrlKey('https://www.rightmove.co.uk/properties/93068658#/?channel=COM_BUY')).toBe('https://www.rightmove.co.uk/properties/93068658')
    expect(listingUrlKey('https://www.immobiliare.it/annunci/123/')).toBe('https://www.immobiliare.it/annunci/123')
  })
})

describe('buildInterestCard', () => {
  it("uses Yousef's own phrasing and carries the facts + the vetting pointer as detail", () => {
    const card = buildInterestCard(listing(), search({ kind: 'house', tier: 'gold' }))
    expect(card.text).toBe("What's the catch? https://www.rightmove.co.uk/properties/93068658")
    expect(card.detail[0]).toBe('Marked interested on the map: £285,000 · 3 bed detached · freehold · High Street, Tonbridge, TN9 — house-gold search ps_abc (UK, rightmove 93068658).')
    expect(card.detail[1]).toContain('listing-vetting.md')
    expect(card.detail[1]).toContain('research/listings/rightmove-93068658.md')
    expect(card.detail[1]).toContain('con map property inventory ps_abc')
  })

  it('omits what the portal never said and prints euros for EUR portals', () => {
    const card = buildInterestCard(listing({ portal: 'subito', id: '77', url: 'https://www.subito.it/x/77.htm', currency: 'EUR', price: 120000, bedrooms: undefined, propertyType: undefined, tenure: undefined, address: undefined, title: 'Casa indipendente' }), search({ country: 'IT' }))
    expect(card.detail[0]).toBe('Marked interested on the map: €120,000 · Casa indipendente — house search ps_abc (IT, subito 77).')
  })
})

describe('findInterestCard', () => {
  const columns = [
    { title: 'In Progress', cards: [{ text: "What's the catch? https://www.rightmove.co.uk/properties/93068658#/", detail: [], blockId: 'gold-kiwi' }] },
    { title: 'Done', cards: [{ text: 'Vetted', detail: ['Marked interested: https://www.immobiliare.it/annunci/123/ …'], blockId: 'old-one' }] },
  ]

  it('finds a hand-filed card by URL despite the pasted fragment', () => {
    expect(findInterestCard(columns, 'https://www.rightmove.co.uk/properties/93068658')?.card.blockId).toBe('gold-kiwi')
  })

  it('matches detail lines and Done cards too — one vetting per listing, ever', () => {
    expect(findInterestCard(columns, 'https://www.immobiliare.it/annunci/123')?.column).toBe('Done')
  })

  it('returns nothing for an unseen listing, including an id that is a prefix of a carded one', () => {
    expect(findInterestCard(columns, 'https://www.rightmove.co.uk/properties/1')).toBeUndefined()
    expect(findInterestCard(columns, 'https://www.rightmove.co.uk/properties/9')).toBeUndefined()
    expect(findInterestCard(columns, 'https://www.rightmove.co.uk/properties/9306865')).toBeUndefined()
  })
})

describe('fileInterestCard through a real board + PropertySync.review', () => {
  const BOARD = `---
kanban-plugin: board
---

## Backlog

## In Progress

- [ ] What's the catch? https://www.rightmove.co.uk/properties/93068658#/ @home-gold-kiwi-fork ^gold-kiwi

## Under Review

## Done
`
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'interest-card-'))
    mkdirSync(join(dir, 'projects', 'home'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'home', 'board.md'), BOARD)
    const ops = new BoardOps(new NoteStore(dir))
    const store = new PropertySearchStore(join(dir, 'searches.json'))
    const inventory = new PropertyInventoryStore(join(dir, 'inv'))
    const mapLayers = { upsert: () => ({}), getMeta: () => undefined, getGeojson: () => null, list: () => [] }
    const sync = new PropertySync({} as never, store, inventory, { broadcast: () => {} } as never, { broadcast: () => {} } as never, mapLayers as never, { isConfigured: () => false } as never, () => {})
    const filed: string[] = []
    sync.onInterested = async (l, s) => {
      const r = await fileInterestCard(ops, l, s)
      filed.push(`${r.filed ? 'filed' : 'exists'}:${r.column}`)
    }
    const board = () => parseBoard(readFileSync(join(dir, 'projects', 'home', 'board.md'), 'utf-8'))
    return { dir, store, inventory, sync, filed, board }
  }

  it('adds the card at the top of In Progress, assigned to home, with the facts as detail', async () => {
    const { dir, store, sync, filed, board } = setup()
    const s = store.create({ country: 'UK', layer: 'l', kind: 'house' })
    store.recordPoll(s.id, { listings: [listing({ id: '555', url: 'https://www.rightmove.co.uk/properties/555', lat: 1, lon: 1 })] })
    sync.review(s.id, '555', 'interested')
    await new Promise((r) => setTimeout(r, 20))
    expect(filed).toEqual(['filed:In Progress'])
    const col = board().columns.find((c) => c.title === 'In Progress')!
    expect(col.cards).toHaveLength(2)
    expect(col.cards[0]!.text).toBe("What's the catch? https://www.rightmove.co.uk/properties/555")
    expect(col.cards[0]!.agentKey).toBe('home')
    expect(col.cards[0]!.blockId).toBeNull() // the watcher stamps + dispatches it
    expect(col.cards[0]!.lines[1]).toContain('£285,000 · 3 bed detached · freehold')
    expect(col.cards[0]!.lines[2]).toContain('research/listings/rightmove-555.md')
    expect(col.cards[1]!.blockId).toBe('gold-kiwi')
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not re-file for a listing Yousef already carded by hand (URL pasted with #/)', async () => {
    const { dir, store, sync, filed, board } = setup()
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: [listing({ id: '93068658', lat: 1, lon: 1 })] })
    sync.review(s.id, '93068658', 'interested')
    await new Promise((r) => setTimeout(r, 20))
    expect(filed).toEqual(['exists:In Progress'])
    expect(board().columns.find((c) => c.title === 'In Progress')!.cards).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('prefers the enriched inventory row over the poll snapshot', async () => {
    const { dir, store, inventory, sync, filed, board } = setup()
    const s = store.create({ country: 'UK', layer: 'l' })
    store.recordPoll(s.id, { listings: [listing({ id: '9', url: 'https://www.rightmove.co.uk/properties/9', lat: 1, lon: 1, tenure: undefined })] })
    inventory.upsert(s.id, [listing({ id: '9', url: 'https://www.rightmove.co.uk/properties/9', lat: 1, lon: 1, tenure: 'leasehold', plotArea: 950 })], { full: false })
    sync.review(s.id, '9', 'interested')
    await new Promise((r) => setTimeout(r, 20))
    expect(filed).toEqual(['filed:In Progress'])
    expect(board().columns.find((c) => c.title === 'In Progress')!.cards[0]!.lines[1]).toContain('leasehold · 950 m² plot')
    rmSync(dir, { recursive: true, force: true })
  })
})
