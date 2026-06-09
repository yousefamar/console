// Flight watchlist poller.
//
// One tick every INTERVAL_MS walks every watchlist, queries SerpApi, diffs
// the new best price against the last seen one, persists the new state, and
// fires a push notification (+ syncBus event) when the price drops below
// the user's threshold or sets a new low.
//
// Designed to short-circuit cleanly when the SerpApi key isn't configured —
// the boot path must not throw in that case.

import type { PushServer } from '../push.js'
import type { SyncBus } from '../sync-bus.js'
import type { SerpApiClient } from './serpapi.js'
import type { Watchlist, WatchlistResult, WatchlistStore } from './store.js'

export class FlightSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly INTERVAL_MS = 60 * 60 * 1000 // 1h baseline

  constructor(
    private readonly serpApi: SerpApiClient,
    private readonly watchlists: WatchlistStore,
    private readonly push: PushServer,
    private readonly bus: SyncBus,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.log('[flight-sync] starting (1h interval)')
    // Defer first tick so boot stays snappy.
    setTimeout(() => {
      this.tick().catch((e) => this.log(`[flight-sync] initial tick failed: ${e}`))
    }, 10_000)
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log(`[flight-sync] tick failed: ${e}`))
    }, this.INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Manually poll a single watchlist (route handler entry point). */
  async pollOne(id: string): Promise<Watchlist | undefined> {
    const wl = this.watchlists.get(id)
    if (!wl) return undefined
    await this.pollWatchlist(wl)
    return this.watchlists.get(id)
  }

  /** Re-broadcast on the sync bus so any open SPA reacts to a CRUD edit. */
  broadcastChange(op: 'created' | 'updated' | 'deleted', data: unknown): void {
    this.bus.broadcast('flights', op, data)
  }

  // ---- internals ----

  private async tick(): Promise<void> {
    if (this.running) return
    if (!this.serpApi.isConfigured()) return // silent skip
    this.running = true
    try {
      for (const wl of this.watchlists.list()) {
        try {
          await this.pollWatchlist(wl)
        } catch (e) {
          this.log(`[flight-sync] ${wl.id} failed: ${(e as Error).message}`)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async pollWatchlist(wl: Watchlist): Promise<void> {
    let priceMajor: number | undefined
    let results: WatchlistResult[] = []
    let error: string | undefined

    try {
      if (wl.kind === 'explore') {
        const r = await this.serpApi.explore({
          departureId: wl.origin,
          arrivalId: wl.destination,
          region: wl.region,
          arrivalAreaId: wl.arrivalAreaId,
          month: wl.month,
          duration: wl.duration,
          currency: wl.currency,
        })
        results = r.destinations.map((d) => ({
          label: d.country ? `${d.name}, ${d.country}` : d.name,
          priceMajor: d.priceMajor,
          startDate: d.startDate,
          endDate: d.endDate,
          airport: d.airport,
          country: d.country,
          kgmid: d.kgmid,
          nonstop: d.nonstop,
          link: d.link,
          raw: d.raw,
        }))
        priceMajor = results[0]?.priceMajor
      } else {
        if (!wl.outboundDate) throw new Error('route watchlist missing outboundDate')
        if (!wl.destination) throw new Error('route watchlist missing destination')
        const r = await this.serpApi.search({
          departureId: wl.origin,
          arrivalId: wl.destination,
          outboundDate: wl.outboundDate,
          returnDate: wl.returnDate,
          travelClass: wl.travelClass,
          adults: wl.adults,
          currency: wl.currency,
        })
        const all = [...r.best, ...r.other]
        results = all.map((f) => ({
          label: `${f.outboundRoute || `${wl.origin}→${wl.destination}`} · ${f.stops === 0 ? 'direct' : `${f.stops} stop`}`,
          priceMajor: f.priceMajor,
          startDate: wl.outboundDate,
          endDate: wl.returnDate,
          departureTime: f.departureTime,
          arrivalTime: f.arrivalTime,
          stops: f.stops,
          airlines: f.airlines,
          flightNumbers: f.flightNumbers,
          route: f.outboundRoute,
          totalDurationMin: f.totalDurationMin,
          segments: f.segments,
          raw: f.raw,
        }))
        priceMajor = results[0]?.priceMajor
      }
    } catch (e) {
      error = (e as Error).message
    }

    const update = this.watchlists.recordPoll(wl.id, { priceMajor, results, error })
    if (!update) return
    this.bus.broadcast('flights', 'polled', update.current)

    if (typeof priceMajor === 'number') {
      this.maybeNotify(update.current, update.previous, priceMajor)
    }
  }

  private maybeNotify(wl: Watchlist, previous: number | undefined, current: number): void {
    const cur = current
    const prev = previous
    const cur$ = formatPrice(cur, wl.currency)
    const prev$ = prev != null ? formatPrice(prev, wl.currency) : null
    const label = wl.label || describeWatchlist(wl)

    // Below user threshold — always notify.
    if (typeof wl.maxPriceMajor === 'number' && cur <= wl.maxPriceMajor) {
      if (prev == null || cur < prev) {
        this.push.broadcast({
          type: 'calendar',
          title: `✈ ${cur$} ${label}`,
          body: prev$ ? `Was ${prev$}` : `Under £${wl.maxPriceMajor} threshold`,
          pane: 'calendar',
          id: `flight-${wl.id}`,
        })
        this.log(`[flight-sync] notify (under threshold): ${wl.id} ${cur$}`)
        return
      }
    }

    // New low even above threshold.
    if (wl.notifyOnDrop !== false && prev != null && cur < prev) {
      this.push.broadcast({
        type: 'calendar',
        title: `✈ ${cur$} ${label}`,
        body: `Down from ${prev$}`,
        pane: 'calendar',
        id: `flight-${wl.id}`,
      })
      this.log(`[flight-sync] notify (new low): ${wl.id} ${cur$}`)
    }
  }
}

function formatPrice(major: number, currency: string): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : ''
  if (symbol) return `${symbol}${Math.round(major)}`
  return `${Math.round(major)} ${currency}`
}

function describeWatchlist(wl: Watchlist): string {
  if (wl.kind === 'explore') {
    const where = wl.destination || wl.region || (wl.arrivalAreaId ? 'area' : 'anywhere')
    const when = wl.month && wl.month > 0 ? monthName(wl.month) : 'next 6mo'
    return `${wl.origin} → ${where} · ${when}`
  }
  return `${wl.origin} → ${wl.destination} · ${wl.outboundDate}${wl.returnDate ? ` ↩ ${wl.returnDate}` : ''}`
}

function monthName(m: number): string {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] || `M${m}`
}
