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
import type { MapLayerStore } from '../map-layers/store.js'
import type { SerpApiClient } from './serpapi.js'
import type { Watchlist, WatchlistResult, WatchlistStore } from './store.js'
import { legsToGeoJSON, type FlightLeg } from './arcs.js'

// Sci-fi cyan for the live-offers arcs on the Map tab.
const OFFERS_COLOR = '#22d3ee'
const OFFERS_SLUG = 'flights/offers'
// Cap arcs per explore watchlist so a big "anywhere" result doesn't carpet the map.
const MAX_EXPLORE_ARCS = 8

export class FlightSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  // Once daily. Flight prices for trips weeks/months out don't move
  // hour-to-hour, and SerpApi has a hard monthly request cap — hourly polling
  // burned ~720 requests/month per watchlist. Daily catches every meaningful
  // move at ~30/month. Manual refresh (pollOne) is always available for
  // on-demand checks.
  private readonly INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h

  constructor(
    private readonly serpApi: SerpApiClient,
    private readonly watchlists: WatchlistStore,
    private readonly push: PushServer,
    private readonly bus: SyncBus,
    private readonly mapLayers: MapLayerStore,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.log('[flight-sync] starting (24h interval)')
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
    // Same free precheck as the loop — a manual run shouldn't burn a 429 email.
    const left = await this.serpApi.searchesLeft()
    if (left !== null && left <= 0) {
      this.log('[flight-sync] manual run skipped — SerpApi quota exhausted')
      return wl // leave cached results intact
    }
    await this.pollWatchlist(wl)
    this.updateOffersLayer()
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
      // Free quota precheck — never fire search requests against a dead quota
      // (that's what spams the "out of searches" emails). null = unknown → try.
      const left = await this.serpApi.searchesLeft()
      if (left !== null && left <= 0) {
        this.log('[flight-sync] skipping poll — SerpApi quota exhausted (0 left)')
        this.updateOffersLayer() // refresh arcs from cached results
        return
      }
      for (const wl of this.watchlists.list()) {
        try {
          await this.pollWatchlist(wl)
        } catch (e) {
          this.log(`[flight-sync] ${wl.id} failed: ${(e as Error).message}`)
        }
      }
      this.updateOffersLayer()
    } finally {
      this.running = false
    }
  }

  /**
   * Rebuild the `flights/offers` map layer from every watchlist's latest
   * results — origin→destination arcs for routes, origin→each-cheap-destination
   * arcs for explore watchlists. This is the live "good flights on offer" view;
   * it refreshes whenever the poller (or a manual run) updates results.
   *
   * Guard: with zero watchlists there's nothing to manage, so we leave the
   * layer untouched (a manually-seeded `flights/offers` survives until the
   * first real watchlist exists).
   */
  private updateOffersLayer(): void {
    const wls = this.watchlists.list()
    if (wls.length === 0) return

    const legs: FlightLeg[] = []
    for (const wl of wls) {
      const results = wl.lastResults ?? []
      if (results.length === 0) continue
      if (wl.destination) {
        // Specific origin→destination monitor (e.g. LHR→FRA): one arc, best fare.
        const best = results[0]
        const price = wl.lastPriceMajor ?? best?.priceMajor
        const date = wl.kind === 'route' ? wl.outboundDate : best?.startDate
        if (price != null) legs.push({ from: wl.origin, to: wl.destination, price, currency: wl.currency, date })
      } else {
        // Region/anywhere discovery: fan out to the cheapest destinations.
        for (const r of results.slice(0, MAX_EXPLORE_ARCS)) {
          if (!r.airport) continue
          legs.push({ from: wl.origin, to: r.airport, price: r.priceMajor, currency: wl.currency, date: r.startDate })
        }
      }
    }

    // No real legs yet (e.g. quota exhausted, nothing polled): leave the layer
    // as-is rather than blanking it — keeps the last-good board (or the seed)
    // on screen. Removal is explicit (`con map flights clear`).
    if (legs.length === 0) return

    try {
      const { geojson } = legsToGeoJSON(legs, OFFERS_COLOR)
      this.mapLayers.upsert(OFFERS_SLUG, geojson, {
        style: { animated: true, lineColor: OFFERS_COLOR, lineWidth: 2, color: OFFERS_COLOR, size: 3, popup: ['route', 'price', 'date'] },
        fit: false,
        updatedBy: 'flights',
      })
      this.bus.broadcast('map-layers', 'delta', { layers: this.mapLayers.list() })
    } catch (e) {
      this.log(`[flight-sync] offers layer update failed: ${(e as Error).message}`)
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
