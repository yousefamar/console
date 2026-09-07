// Exhaustive portal pulls + the per-search inventory they land in.
//
// The hourly poll only skims the newest ~50 listings per polygon ring, so the
// map used to show a sliver of what the portals actually hold (UK: 84 pins of
// ~8,000 matches). `fetchAll` walks every page of every ring; where a portal
// silently caps a single query (Rightmove ~1,000 rows, immobiliare's
// `isResultsLimitReached`, IS24 past page 50) it halves the price range and
// recurses until each band fits. Results are COARSE — only the criteria the
// portal applied server-side — so the fine filters (plot, keywords, auction…)
// can be re-applied at layer-build time without another pull.

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Ring } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

/** Never split a band narrower than this — below it the portal's own cap wins. */
const MIN_BAND_WIDTH = 5_000
/** Top of the price range when the criteria leave it open. */
const OPEN_MAX_PRICE = 10_000_000

export interface FetchAllResult {
  listings: Listing[]
  /** Sum of the portal's own per-ring counts (before dedupe across rings). */
  total: number
  /** A band hit the portal cap even at MIN_BAND_WIDTH — some rows are unreachable. */
  truncated: boolean
  unsupported: string[]
  /** Portal queries issued, for the log. */
  queries: number
}

/**
 * Every listing the portal holds inside `rings` for `criteria`. Rings are
 * fetched one at a time so a cap on one ring only splits that ring.
 */
export async function fetchAll(client: PortalClient, rings: Ring[], criteria: Criteria): Promise<FetchAllResult> {
  const seen = new Map<string, Listing>()
  let total = 0
  let truncated = false
  let unsupported: string[] = []
  let queries = 0

  const pull = async (ring: Ring, band: Criteria, depth: number): Promise<void> => {
    queries++
    const r: SearchResult = await client.newest([ring], band, Number.POSITIVE_INFINITY)
    unsupported = r.unsupported
    if (depth === 0) total += r.total
    if (!r.truncated) {
      for (const l of r.listings) seen.set(l.id, l)
      return
    }
    const lo = band.minPrice ?? 0
    const hi = band.maxPrice ?? OPEN_MAX_PRICE
    if (hi - lo < MIN_BAND_WIDTH) {
      for (const l of r.listings) seen.set(l.id, l)
      truncated = true
      return
    }
    // Keep what this query did return (it's valid, just incomplete), then
    // re-query both halves. Boundary overlap is harmless — dedupe by id.
    for (const l of r.listings) seen.set(l.id, l)
    const mid = Math.round((lo + hi) / 2 / 1000) * 1000
    await pull(ring, { ...band, minPrice: lo, maxPrice: mid }, depth + 1)
    await pull(ring, { ...band, minPrice: mid, maxPrice: hi }, depth + 1)
  }

  for (const ring of rings) await pull(ring, criteria, 0)
  return { listings: [...seen.values()], total, truncated, unsupported, queries }
}

export interface InventoryEntry extends Listing {
  firstSeenAt: number
  lastSeenAt: number
  /** Set when a full sync no longer returned this id; cleared if it comes back. */
  removedAt?: number
}

export interface InventorySnapshot {
  searchId: string
  /** Last exhaustive sync — the moment `removedAt` marks are trustworthy from. */
  syncedAt?: number
  entries: InventoryEntry[]
}

/**
 * One JSON file per search under `dir`. Everything the portal ever returned
 * for the search's coarse criteria, with first/last-seen stamps; a full sync
 * marks what it didn't return as removed rather than deleting it, so a
 * listing that flickers off and on keeps its history.
 */
export class PropertyInventoryStore {
  private readonly cache = new Map<string, InventorySnapshot>()

  constructor(private readonly dir: string) {}

  get(searchId: string): InventorySnapshot {
    const cached = this.cache.get(searchId)
    if (cached) return cached
    let snap: InventorySnapshot = { searchId, entries: [] }
    const file = this.fileFor(searchId)
    if (existsSync(file)) {
      try {
        snap = JSON.parse(readFileSync(file, 'utf8')) as InventorySnapshot
      } catch (e) {
        console.error(`[property-inventory] failed to load ${file}:`, e)
      }
    }
    this.cache.set(searchId, snap)
    return snap
  }

  /** Listings currently believed to be on the portal. */
  live(searchId: string): InventoryEntry[] {
    return this.get(searchId).entries.filter((e) => e.removedAt == null)
  }

  /**
   * Merge listings in. `full: true` means `listings` is the portal's complete
   * answer, so anything not in it is marked removed; `false` (an hourly
   * newest-first skim) only ever adds or refreshes.
   */
  upsert(searchId: string, listings: Listing[], opts: { full: boolean; now?: number }): InventorySnapshot {
    const now = opts.now ?? Date.now()
    const snap = this.get(searchId)
    const byId = new Map(snap.entries.map((e) => [e.id, e]))
    const returned = new Set<string>()
    for (const l of listings) {
      returned.add(l.id)
      const prev = byId.get(l.id)
      if (prev) {
        // Keep enrichments the portal doesn't send back (nearestAirport).
        byId.set(l.id, { ...prev, ...l, nearestAirport: l.nearestAirport ?? prev.nearestAirport, firstSeenAt: prev.firstSeenAt, lastSeenAt: now, removedAt: undefined })
      } else {
        byId.set(l.id, { ...l, firstSeenAt: now, lastSeenAt: now })
      }
    }
    if (opts.full) {
      for (const e of byId.values()) {
        if (!returned.has(e.id) && e.removedAt == null) e.removedAt = now
      }
      snap.syncedAt = now
    }
    snap.entries = [...byId.values()]
    this.save(snap)
    return snap
  }

  /** A liveness probe said the portal dropped these. */
  markRemoved(searchId: string, ids: string[], now = Date.now()): void {
    const snap = this.get(searchId)
    const gone = new Set(ids)
    let changed = false
    for (const e of snap.entries) {
      if (gone.has(e.id) && e.removedAt == null) { e.removedAt = now; changed = true }
    }
    if (changed) this.save(snap)
  }

  setNearestAirport(searchId: string, listingId: string, nearestAirport: Listing['nearestAirport']): void {
    const snap = this.get(searchId)
    const e = snap.entries.find((x) => x.id === listingId)
    if (!e) return
    e.nearestAirport = nearestAirport
    this.save(snap)
  }

  /** Forget everything for a search (criteria changed under it, or it was deleted). */
  clear(searchId: string): void {
    this.cache.delete(searchId)
    const file = this.fileFor(searchId)
    if (existsSync(file)) unlinkSync(file)
  }

  private fileFor(searchId: string): string {
    return join(this.dir, `${searchId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)
  }

  private save(snap: InventorySnapshot): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(snap.searchId)
    writeFileSync(`${file}.tmp`, JSON.stringify(snap))
    // Rename is atomic; a crash mid-write can't leave a truncated inventory.
    renameSync(`${file}.tmp`, file)
  }
}
