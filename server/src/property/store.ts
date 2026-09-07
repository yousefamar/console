// Saved property searches.
//
// One JSON file at ~/.config/console/property-searches.json. A search is a
// declarative `Criteria` plus a region (a map-layer slug whose polygon we query,
// clipped to the search's country) plus rolling state: which listing ids we've
// already seen, the last result snapshot, and a total-count history.
//
// `seenIds` is the alerting substrate — a listing is "new" iff its id isn't in
// there. That means a freshly-created search MUST be seeded silently on its
// first poll, or it fires hundreds of alerts for listings that have been up for
// months. See sync.ts.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Criteria, Listing, Portal } from './types.js'
import type { NotifyCriteria } from './notify-filter.js'

// Must exceed the largest inventory (UK ~8k) or the hourly trim evicts ids a
// full sync just marked seen, and they come back as "new".
const SEEN_LIMIT = 20000
// The map pins are drawn from `lastResults`, so this also caps how many pins a
// search can ever show — keep it at or above sync.ts's MAX_PINS. Bumped from
// 200 so a backfill's whole point (showing more of what's actually out there,
// not just the newest 50-a-poll) isn't immediately thrown away by this cap.
const RESULTS_LIMIT = 600
const HISTORY_LIMIT = 60

export type Country = 'UK' | 'DE' | 'IT'

export type ReviewState = 'interested' | 'dismissed' | 'none'

/**
 * A poll snapshot replaces `lastResults` wholesale (it IS "the newest N per
 * ring"), so an interested listing that has aged out of that window would
 * silently leave the map. Carry those forward — the snapshot's own copy wins
 * when the listing is still in it — and let the newest listings, not the
 * carried ones, absorb the RESULTS_LIMIT cap.
 */
export function withInterestedCarried(s: Pick<PropertySearch, 'interestedIds' | 'lastResults'>, snapshot: Listing[]): Listing[] {
  const interested = new Set(s.interestedIds ?? [])
  if (interested.size === 0) return snapshot.slice(0, RESULTS_LIMIT)
  const inSnapshot = new Set(snapshot.map((l) => l.id))
  const carried = (s.lastResults ?? []).filter((l) => interested.has(l.id) && !inSnapshot.has(l.id))
  return [...snapshot.slice(0, Math.max(0, RESULTS_LIMIT - carried.length)), ...carried]
}

/** Each portal covers exactly one of our three countries. */
export const PORTAL_BY_COUNTRY: Record<Country, Portal> = {
  UK: 'rightmove',
  DE: 'immoscout24',
  IT: 'immobiliare',
}

/**
 * What kind of property a search is after. Map layers are sliced by kind ONLY
 * (Yousef, 2026-09-07: "do not slice by country … do not slice by source
 * either. Only slice by type") — every search of a kind feeds one
 * `property/<kind>` layer; country and portal are popup fields.
 */
export type PropertyKind = 'house' | 'farmland'
export const PROPERTY_KINDS: readonly PropertyKind[] = ['house', 'farmland']

export interface PropertySearch {
  id: string
  label?: string
  country: Country
  /** Defaults to `house`. */
  kind?: PropertyKind
  /**
   * Which portal client runs this search. Defaults to the country's primary
   * portal (PORTAL_BY_COUNTRY); set explicitly for aggregators and specialist
   * sources so one country can have several searches feeding the same kind
   * layer. Cross-portal duplicates collapse at draw time (see dedupe in sync.ts).
   */
  portal?: Portal
  /** Map-layer slug supplying the search polygon (e.g. `where-to-move/livable-zone`). */
  layer: string
  /** Query at most this many of the layer's rings, largest first. */
  maxRings?: number
  /**
   * If set, a genuinely-new listing only gets pushed when it falls inside
   * this geofence — a push-noise filter, not a search filter. Listings
   * outside it still show up on the map and get merged into `lastResults` as
   * normal; they just don't buzz the phone. `null`/unset = notify on
   * everything, as before. Either a published map-layer slug (e.g.
   * `where-to-move/lhr-catchment`) or a raw geojson file path (e.g. a vault
   * isochrone under `data/iso/` that doesn't need its own visible Map-tab
   * layer) — see `PropertySync.geometriesForNotify` for how the two are told
   * apart.
   */
  notifyLayer?: string
  /**
   * `false` = poll + draw pins as normal, never push. The other two searches
   * stay useful as a map layer while only one country is allowed to buzz the
   * phone (Yousef, 2026-09-03: "only UK ones"). Unset = true.
   */
  notify?: boolean
  /**
   * "Only when it's really good" — a stricter gate evaluated locally on each
   * genuinely-new listing before it's pushed (after `notifyLayer`). Search
   * `criteria` decide what lands on the map; this decides what's worth a
   * notification. See notify-filter.ts for the strictness rule (unknown
   * fields fail). Unset = every fresh in-geofence listing notifies.
   */
  notifyCriteria?: NotifyCriteria
  /**
   * A second, stricter bar for listings OUTSIDE `notifyLayer`'s geofence
   * (Yousef, 2026-09-07: "anything outside the Heathrow catchment needs a much
   * higher bar"). Unlike `notifyCriteria` this is a SEARCH filter: an outside
   * listing that fails it never reaches `lastResults`/the map. Inside the
   * geofence the plain `criteria` apply. Same shape + strictness rule as the
   * notify gate (unknown fields fail); the airport-drive gate is ignored here
   * (no lookups for the whole snapshot). Requires `notifyLayer`; a verdict
   * (interested) still carries a listing regardless.
   */
  outsideCriteria?: NotifyCriteria
  criteria: Criteria
  enabled?: boolean
  createdAt: number

  // rolling state
  /** False until the first poll has recorded the existing listings. */
  seeded?: boolean
  lastCheckedAt?: number
  lastError?: string
  lastTotal?: number
  /** Criteria the portal couldn't apply on the last poll. */
  unsupported?: string[]
  /** Portal admitted it truncated the result set on the last poll. */
  truncated?: boolean
  seenIds?: string[]
  /**
   * Listing ids Yousef explicitly said no to — hidden from the map on every
   * future poll. Unlike `seenIds` (the alerting substrate, cleared whenever
   * criteria/layer/country change so an edit re-seeds instead of re-alerting),
   * this must survive those edits: a dismissal is about the listing, not
   * about whether the current query happens to still match it.
   */
  dismissedIds?: string[]
  /**
   * Listing ids Yousef marked "interested". Mutually exclusive with
   * `dismissedIds`. Like dismissals these survive criteria edits. An
   * interested listing is carried across polls even once it drops out of the
   * newest-per-ring snapshot, until a liveness probe says the portal removed
   * it (see PropertySync.pruneGone).
   */
  interestedIds?: string[]
  /** Most recent newest-first skim. The map is drawn from the inventory, not this. */
  lastResults?: Listing[]
  history?: Array<{ at: number; total: number }>
  /** Summary of the last exhaustive pull (the inventory itself lives in PropertyInventoryStore). */
  inventory?: {
    syncedAt: number
    /** Listings the portal returned on that pull. */
    live: number
    /** Ids marked removed since (still stored, hidden from the map). */
    removed: number
    /** The portal's own total across rings — a gap vs `live` means a cap we couldn't split past. */
    total: number
    truncated: boolean
    queries: number
    durationMs: number
    error?: string
  }
}

export type CreatePropertySearchInput = Pick<PropertySearch, 'country' | 'layer'> &
  Partial<Pick<PropertySearch, 'label' | 'kind' | 'portal' | 'maxRings' | 'criteria' | 'enabled' | 'notifyLayer' | 'notify' | 'notifyCriteria' | 'outsideCriteria'>>

export class PropertySearchStore {
  private items: PropertySearch[] = []
  private loaded = false

  constructor(private readonly file: string) {}

  list(): PropertySearch[] {
    this.load()
    return this.items.slice()
  }

  get(id: string): PropertySearch | undefined {
    this.load()
    return this.items.find((s) => s.id === id)
  }

  create(input: CreatePropertySearchInput): PropertySearch {
    this.load()
    const search: PropertySearch = {
      label: input.label,
      country: input.country,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.portal !== undefined ? { portal: input.portal } : {}),
      layer: input.layer,
      maxRings: input.maxRings,
      criteria: input.criteria ?? {},
      enabled: input.enabled ?? true,
      ...(input.notifyLayer !== undefined ? { notifyLayer: input.notifyLayer } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      ...(input.notifyCriteria !== undefined ? { notifyCriteria: input.notifyCriteria } : {}),
      ...(input.outsideCriteria !== undefined ? { outsideCriteria: input.outsideCriteria } : {}),
      id: `ps_${randomBytes(5).toString('hex')}`,
      createdAt: Date.now(),
      seeded: false,
    }
    this.items.push(search)
    this.save()
    return search
  }

  update(id: string, patch: Partial<Omit<PropertySearch, 'id' | 'createdAt'>>): PropertySearch | undefined {
    this.load()
    const idx = this.items.findIndex((s) => s.id === id)
    if (idx < 0) return undefined
    const before = this.items[idx]!
    const next = { ...before, ...patch }
    // Changing the criteria or region invalidates the seen set — the old ids
    // describe a different query, so re-seed rather than alert on the delta.
    const requeried =
      (patch.criteria && JSON.stringify(patch.criteria) !== JSON.stringify(before.criteria)) ||
      (patch.layer && patch.layer !== before.layer) ||
      (patch.country && patch.country !== before.country) ||
      (patch.portal && patch.portal !== (before.portal ?? PORTAL_BY_COUNTRY[before.country]))
    if (requeried && patch.seeded === undefined) {
      next.seeded = false
      next.seenIds = []
      // The inventory describes the old query too — PropertySync drops it and
      // schedules a fresh full pull when it sees this flag.
      next.inventory = undefined
    }
    this.items[idx] = next
    this.save()
    return next
  }

  /** Record the outcome of an exhaustive pull (see PropertySync.fullSync). */
  recordInventory(id: string, summary: NonNullable<PropertySearch['inventory']>, ids: string[]): PropertySearch | undefined {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s) return undefined
    s.inventory = summary
    if (!summary.error) {
      // Everything the portal holds is now known — none of it may ever alert as "new".
      const seen = new Set(s.seenIds ?? [])
      for (const id of ids) seen.add(id)
      s.seenIds = [...seen].slice(-SEEN_LIMIT)
      s.seeded = true
    }
    this.save()
    return s
  }

  /**
   * Force a re-seed without changing criteria/layer/country — for when the
   * *content* of the referenced map layer changed underneath an unchanged
   * slug (e.g. the polygon it points at was corrected/redrawn), which
   * `update()`'s requeried check can't detect since the layer field itself
   * didn't change. Without this, every listing newly in-scope after such a
   * fix reads as "genuinely new" against the stale seenIds and can trigger a
   * real notification burst instead of silently re-seeding.
   */
  reseed(id: string): PropertySearch | undefined {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s) return undefined
    s.seeded = false
    s.seenIds = []
    this.save()
    return s
  }

  /** Hide a listing from this search's map layer, permanently (until undismiss). */
  dismiss(id: string, listingId: string, dismissed = true): PropertySearch | undefined {
    return this.review(id, listingId, dismissed ? 'dismissed' : 'none')
  }

  /**
   * Yousef's verdict on one listing. `interested` and `dismissed` are
   * mutually exclusive; `none` clears both (back to unreviewed). Opening a
   * listing never changes this — only an explicit verdict does.
   */
  review(id: string, listingId: string, state: ReviewState): PropertySearch | undefined {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s) return undefined
    const dismissed = new Set(s.dismissedIds ?? [])
    const interested = new Set(s.interestedIds ?? [])
    dismissed.delete(listingId)
    interested.delete(listingId)
    if (state === 'dismissed') dismissed.add(listingId)
    if (state === 'interested') interested.add(listingId)
    s.dismissedIds = [...dismissed]
    s.interestedIds = [...interested]
    this.save()
    return s
  }

  /**
   * The portal no longer has this listing: drop it from the snapshot and from
   * the interested set (a verdict on a vanished listing is moot). Dismissals
   * are left alone — if the id ever resurfaces it should stay hidden.
   */
  removeListing(id: string, listingId: string): PropertySearch | undefined {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s) return undefined
    s.lastResults = (s.lastResults ?? []).filter((l) => l.id !== listingId)
    s.interestedIds = (s.interestedIds ?? []).filter((x) => x !== listingId)
    this.save()
    return s
  }

  /**
   * Attach a computed nearest-airport distance to one listing already in
   * `lastResults`, so it's on the map pin (updateLayer reads from
   * `lastResults`) as well as whatever notification triggered the lookup.
   * No-ops if the listing isn't there (e.g. evicted past RESULTS_LIMIT
   * between the poll and the lookup finishing).
   */
  setNearestAirport(id: string, listingId: string, nearestAirport: Listing['nearestAirport']): void {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s?.lastResults) return
    const l = s.lastResults.find((r) => r.id === listingId)
    if (!l) return
    l.nearestAirport = nearestAirport
    this.save()
  }

  remove(id: string): boolean {
    this.load()
    const before = this.items.length
    this.items = this.items.filter((s) => s.id !== id)
    if (this.items.length === before) return false
    this.save()
    return true
  }

  /**
   * Record a poll. Returns the listings that weren't in `seenIds` before, and
   * whether this poll was the seeding one (in which case the caller must not
   * notify about them).
   */
  recordPoll(
    id: string,
    poll: { total?: number; listings: Listing[]; truncated?: boolean; unsupported?: string[]; error?: string },
  ): { current: PropertySearch; fresh: Listing[]; seeding: boolean } | undefined {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s) return undefined

    const seeding = !s.seeded
    const seen = new Set(s.seenIds ?? [])
    const fresh = poll.error ? [] : poll.listings.filter((l) => !seen.has(l.id))

    s.lastCheckedAt = Date.now()
    s.lastError = poll.error
    s.truncated = poll.truncated
    s.unsupported = poll.unsupported?.length ? poll.unsupported : undefined

    if (!poll.error) {
      for (const l of poll.listings) seen.add(l.id)
      // Newest ids are appended last, so trimming from the front evicts the
      // oldest — those listings are long gone and can't "reappear" as new.
      s.seenIds = [...seen].slice(-SEEN_LIMIT)
      s.seeded = true
      if (typeof poll.total === 'number') {
        s.lastTotal = poll.total
        const history = s.history ?? []
        history.push({ at: s.lastCheckedAt, total: poll.total })
        s.history = history.slice(-HISTORY_LIMIT)
      }
      if (poll.listings.length) s.lastResults = withInterestedCarried(s, poll.listings)
    }

    this.save()
    return { current: s, fresh, seeding }
  }

  /**
   * Merge a deeper one-off pull into `lastResults`, silently — a backfill is
   * catching up on stock that predates this search, not a "what's new since
   * last check" event, so every id it touches is marked seen and nothing is
   * ever reported as fresh. Existing pins survive even if the backfill
   * (bounded by BACKFILL_LIMIT, not truly exhaustive) doesn't happen to
   * re-surface them.
   */
  recordBackfill(id: string, listings: Listing[]): PropertySearch | undefined {
    this.load()
    const s = this.items.find((x) => x.id === id)
    if (!s) return undefined

    const byId = new Map((s.lastResults ?? []).map((l) => [l.id, l]))
    for (const l of listings) byId.set(l.id, l)
    s.lastResults = [...byId.values()].slice(0, RESULTS_LIMIT)

    const seen = new Set(s.seenIds ?? [])
    for (const l of listings) seen.add(l.id)
    s.seenIds = [...seen].slice(-SEEN_LIMIT)
    s.seeded = true
    s.lastCheckedAt = Date.now()

    this.save()
    return s
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as { searches?: PropertySearch[] }
        this.items = data.searches ?? []
      }
    } catch (e) {
      console.error(`[property-store] failed to load ${this.file}:`, e)
      this.items = []
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ searches: this.items }, null, 2), 'utf8')
  }
}

/** The client a search runs on: its explicit portal, else the country's primary one. */
export function portalOf(s: Pick<PropertySearch, 'portal' | 'country'>): Portal {
  return s.portal ?? PORTAL_BY_COUNTRY[s.country]
}
