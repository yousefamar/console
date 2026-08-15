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

const SEEN_LIMIT = 4000
const RESULTS_LIMIT = 40
const HISTORY_LIMIT = 60

export type Country = 'UK' | 'DE' | 'IT'

/** Each portal covers exactly one of our three countries. */
export const PORTAL_BY_COUNTRY: Record<Country, Portal> = {
  UK: 'rightmove',
  DE: 'immoscout24',
  IT: 'immobiliare',
}

export interface PropertySearch {
  id: string
  label?: string
  country: Country
  /** Map-layer slug supplying the search polygon (e.g. `where-to-move/livable-zone`). */
  layer: string
  /** Query at most this many of the layer's rings, largest first. */
  maxRings?: number
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
  /** Most recent hits, newest first — what the SPA renders. */
  lastResults?: Listing[]
  history?: Array<{ at: number; total: number }>
}

export type CreatePropertySearchInput = Pick<PropertySearch, 'country' | 'layer'> &
  Partial<Pick<PropertySearch, 'label' | 'maxRings' | 'criteria' | 'enabled'>>

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
      layer: input.layer,
      maxRings: input.maxRings,
      criteria: input.criteria ?? {},
      enabled: input.enabled ?? true,
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
      (patch.country && patch.country !== before.country)
    if (requeried && patch.seeded === undefined) {
      next.seeded = false
      next.seenIds = []
    }
    this.items[idx] = next
    this.save()
    return next
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
      if (poll.listings.length) s.lastResults = poll.listings.slice(0, RESULTS_LIMIT)
    }

    this.save()
    return { current: s, fresh, seeding }
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
