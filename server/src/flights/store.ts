// Flight watchlist persistence.
//
// One JSON file at ~/.config/console/flight-watchlists.json. Each entry
// captures a query (explore-anywhere or fixed-route) plus rolling state
// (last best price, recent history points, last result snapshot for UI).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { RegionKey, SearchSegment, TripDuration } from './serpapi.js'

const HISTORY_LIMIT = 30
const RESULTS_LIMIT = 20

export type WatchlistKind = 'explore' | 'route'

/**
 * One row in `lastResults`. Fat record so the SPA never needs to re-query —
 * route polls populate the time/segment/flight-number fields; explore polls
 * populate the destination/window fields. `raw` keeps the SerpApi payload
 * for forward compatibility with fields we haven't typed yet.
 */
export interface WatchlistResult {
  /** Primary display string (destination name for explore, route for fixed) */
  label: string
  priceMajor: number

  // --- Common date/time ---
  /** Outbound date (route) OR window start (explore) — YYYY-MM-DD */
  startDate?: string
  /** Return date (route, if round-trip) OR window end (explore) — YYYY-MM-DD */
  endDate?: string
  /** Local-time departure of first segment — "YYYY-MM-DD HH:MM" (route only) */
  departureTime?: string
  /** Local-time arrival of last segment (route only) */
  arrivalTime?: string

  // --- Route-specific (point-to-point) ---
  stops?: number
  airlines?: string[]
  flightNumbers?: string[]
  /** "LHR → MXP" or "LHR → CDG → MXP" */
  route?: string
  totalDurationMin?: number
  segments?: SearchSegment[]

  // --- Explore-specific (anywhere/region) ---
  /** Destination IATA airport code */
  airport?: string
  country?: string
  /** Google's destination kgmid for drill-down */
  kgmid?: string
  /** Direct flight available in the window? */
  nonstop?: boolean
  /** Google Flights deep link for this destination + dates */
  link?: string

  /** Raw SerpApi payload for fields we haven't typed yet */
  raw?: unknown
}

export interface Watchlist {
  id: string
  label?: string
  kind: WatchlistKind
  origin: string
  currency: string
  /** Notify when best price ≤ this (major units) */
  maxPriceMajor?: number
  /** Notify on any new low even above threshold. Default true. */
  notifyOnDrop?: boolean
  createdAt: number

  // explore-specific
  region?: RegionKey
  arrivalAreaId?: string
  destination?: string
  month?: number
  duration?: TripDuration

  // route-specific
  outboundDate?: string
  returnDate?: string
  travelClass?: 1 | 2 | 3 | 4
  adults?: number

  // rolling state
  lastCheckedAt?: number
  lastError?: string
  lastPriceMajor?: number
  history?: Array<{ at: number; priceMajor: number }>
  lastResults?: WatchlistResult[]
}

export type CreateWatchlistInput = Omit<
  Watchlist,
  'id' | 'createdAt' | 'lastCheckedAt' | 'lastError' | 'lastPriceMajor' | 'history' | 'lastResults' | 'currency'
> & { currency?: string }

export class WatchlistStore {
  private items: Watchlist[] = []
  private loaded = false

  constructor(private readonly file: string) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8')) as { watchlists?: Watchlist[] }
        this.items = data.watchlists ?? []
      }
    } catch (e) {
      console.error(`[flight-store] failed to load ${this.file}:`, e)
      this.items = []
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ watchlists: this.items }, null, 2), 'utf8')
  }

  list(): Watchlist[] {
    this.load()
    return this.items.slice()
  }

  get(id: string): Watchlist | undefined {
    this.load()
    return this.items.find((w) => w.id === id)
  }

  create(input: CreateWatchlistInput): Watchlist {
    this.load()
    const id = `wl_${randomBytes(5).toString('hex')}`
    const wl: Watchlist = {
      ...input,
      id,
      currency: input.currency ?? 'GBP',
      notifyOnDrop: input.notifyOnDrop ?? true,
      createdAt: Date.now(),
    }
    this.items.push(wl)
    this.save()
    return wl
  }

  update(id: string, patch: Partial<Omit<Watchlist, 'id' | 'createdAt'>>): Watchlist | undefined {
    this.load()
    const idx = this.items.findIndex((w) => w.id === id)
    if (idx < 0) return undefined
    this.items[idx] = { ...this.items[idx]!, ...patch }
    this.save()
    return this.items[idx]
  }

  remove(id: string): boolean {
    this.load()
    const before = this.items.length
    this.items = this.items.filter((w) => w.id !== id)
    if (this.items.length === before) return false
    this.save()
    return true
  }

  /**
   * Record a poll result. Returns the previous best price (or undefined)
   * so the caller can decide whether to push a notification.
   */
  recordPoll(id: string, opts: {
    priceMajor: number | undefined
    results: WatchlistResult[]
    error?: string
  }): { previous?: number; current: Watchlist } | undefined {
    this.load()
    const wl = this.items.find((w) => w.id === id)
    if (!wl) return undefined
    const previous = wl.lastPriceMajor
    wl.lastCheckedAt = Date.now()
    wl.lastError = opts.error
    if (typeof opts.priceMajor === 'number') {
      wl.lastPriceMajor = opts.priceMajor
      const history = wl.history ?? []
      history.push({ at: wl.lastCheckedAt, priceMajor: opts.priceMajor })
      wl.history = history.slice(-HISTORY_LIMIT)
    }
    wl.lastResults = opts.results.slice(0, RESULTS_LIMIT)
    this.save()
    return { previous, current: wl }
  }
}
