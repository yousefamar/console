// Property search poller.
//
// Every tick, each enabled search asks its portal for the NEWEST listings in
// its polygon, diffs the ids against what we've already seen, pushes a
// notification per genuinely-new hit, and refreshes a `property/*` map layer.
//
// Two things matter more than anything else here:
//   1. Silent seeding. A brand-new search's first poll records existing ids
//      without notifying — otherwise creating a search carpet-bombs the phone.
//   2. Post-filtering. Each portal expresses a different subset of `Criteria`;
//      whatever it reports as `unsupported` we enforce locally, so a search
//      means the same thing in all three countries.

import type { PushServer } from '../push.js'
import type { SyncBus } from '../sync-bus.js'
import type { MapLayerStore } from '../map-layers/store.js'
import { ringsInCountry, type Geometry, type Ring } from './geo.js'
import { PORTAL_BY_COUNTRY, type PropertySearch, type PropertySearchStore } from './store.js'
import type { Criteria, Listing, PortalClient, Portal } from './types.js'

const LAYER_COLOR = '#f97316' // orange — distinct from the flight cyan
const LAYER_GROUP = 'property'
/** Newest-first listings pulled per poll. Enough to catch a busy day, not the world. */
const FETCH_LIMIT = 50
/**
 * One-off backfill limit — far beyond FETCH_LIMIT, deliberately not "unlimited":
 * each client already stops at its own real ceiling (Rightmove index>1000,
 * IS24 page>=50, immobiliare isResultsLimitReached/maxPages), so this just has
 * to be large enough to never be the thing that cuts a backfill short.
 */
const BACKFILL_LIMIT = 5000
/** Pins kept on the map per search — keep at or below store.ts's RESULTS_LIMIT. */
const MAX_PINS = 600
/** Notifications per poll per search — beyond this, one summary push. */
const MAX_ALERTS = 5

export class PropertySync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  // Hourly. "I want to be the first to know" — but portal listings appear in
  // batches during agent working hours, and all three are free public servers
  // we're being a polite guest on.
  private readonly INTERVAL_MS = 60 * 60 * 1000

  constructor(
    private readonly clients: Record<Portal, PortalClient>,
    private readonly searches: PropertySearchStore,
    private readonly push: PushServer,
    private readonly bus: SyncBus,
    private readonly mapLayers: MapLayerStore,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.log('[property-sync] starting (1h interval)')
    setTimeout(() => {
      this.tick().catch((e) => this.log(`[property-sync] initial tick failed: ${e}`))
    }, 30_000)
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log(`[property-sync] tick failed: ${e}`))
    }, this.INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Poll one search now (route handler entry point). */
  async pollOne(id: string): Promise<PropertySearch | undefined> {
    const s = this.searches.get(id)
    if (!s) return undefined
    await this.pollSearch(s)
    return this.searches.get(id)
  }

  /**
   * One-off deeper pull past the hourly poll's FETCH_LIMIT — for catching up a
   * search on stock that already existed before it was created (or before
   * criteria widened its ring coverage), not for routine use. Always merges
   * silently: never notifies, however many "new" ids it turns up.
   */
  async backfill(id: string): Promise<PropertySearch | undefined> {
    const s = this.searches.get(id)
    if (!s) return undefined
    const client = this.clients[PORTAL_BY_COUNTRY[s.country]]
    const rings = this.rings(s.layer, s.country, s.maxRings)
    const r = await client.newest(rings, s.criteria, BACKFILL_LIMIT)
    const listings = postFilter(r.listings, s.criteria, r.unsupported)
    const updated = this.searches.recordBackfill(id, listings)
    if (!updated) return undefined
    this.bus.broadcast('property', 'polled', updated)
    this.updateLayer(updated)
    this.log(`[property-sync] ${id} backfilled: ${listings.length} listings merged (portal reports ${r.total} total)`)
    return updated
  }

  /**
   * Hide (or restore) a listing on this search's map. Refreshes the layer
   * immediately rather than waiting for the next hourly poll, since the point
   * is to make the pin disappear the moment Yousef says no to it.
   */
  dismiss(id: string, listingId: string, dismissed = true): PropertySearch | undefined {
    const s = this.searches.dismiss(id, listingId, dismissed)
    if (!s) return undefined
    this.updateLayer(s)
    this.bus.broadcast('property', 'updated', s)
    return s
  }

  /** Ad-hoc count for a candidate criteria set, without saving anything. */
  async count(country: keyof typeof PORTAL_BY_COUNTRY, layer: string, criteria: Criteria, maxRings?: number): Promise<number> {
    const rings = this.rings(layer, country, maxRings)
    return this.clients[PORTAL_BY_COUNTRY[country]].count(rings, criteria)
  }

  broadcastChange(op: 'created' | 'updated' | 'deleted', data: unknown): void {
    this.bus.broadcast('property', op, data)
  }

  // ---- internals ----

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const s of this.searches.list()) {
        if (s.enabled === false) continue
        try {
          await this.pollSearch(s)
        } catch (e) {
          this.log(`[property-sync] ${s.id} failed: ${(e as Error).message}`)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async pollSearch(s: PropertySearch): Promise<void> {
    const client = this.clients[PORTAL_BY_COUNTRY[s.country]]
    let listings: Listing[] = []
    let total: number | undefined
    let truncated = false
    let unsupported: string[] = []
    let error: string | undefined

    try {
      const rings = this.rings(s.layer, s.country, s.maxRings)
      const r = await client.newest(rings, s.criteria, FETCH_LIMIT)
      total = r.total
      truncated = r.truncated
      unsupported = r.unsupported
      listings = sortNewestFirst(postFilter(r.listings, s.criteria, r.unsupported))
    } catch (e) {
      error = (e as Error).message
    }

    const update = this.searches.recordPoll(s.id, { total, listings, truncated, unsupported, error })
    if (!update) return
    this.bus.broadcast('property', 'polled', update.current)
    this.updateLayer(update.current)

    if (error) {
      this.log(`[property-sync] ${s.id} error: ${error}`)
      return
    }
    if (update.seeding) {
      this.log(`[property-sync] ${s.id} seeded with ${listings.length} existing listings (no alerts)`)
      return
    }
    if (update.fresh.length) this.notify(update.current, update.fresh)
  }

  /** Resolve a search's polygon from the map-layer store. */
  private rings(layer: string, country: keyof typeof PORTAL_BY_COUNTRY, maxRings?: number): Ring[] {
    const gj = this.mapLayers.getGeojson(layer) as
      | { type?: string; features?: Array<{ geometry?: Geometry }>; geometry?: Geometry }
      | null
    if (!gj) throw new Error(`map layer '${layer}' not found`)
    const geometries: Geometry[] =
      gj.type === 'FeatureCollection'
        ? (gj.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => !!g)
        : gj.type === 'Feature'
          ? gj.geometry
            ? [gj.geometry]
            : []
          : [gj as unknown as Geometry]

    const rings = geometries.flatMap((g) => ringsInCountry(g, country))
    if (rings.length === 0) throw new Error(`layer '${layer}' has no rings in ${country}`)
    return maxRings && maxRings > 0 ? rings.slice(0, maxRings) : rings
  }

  /** One pin layer per search, so each toggles independently on the Map tab. */
  private updateLayer(s: PropertySearch): void {
    const dismissed = new Set(s.dismissedIds ?? [])
    const listings = (s.lastResults ?? [])
      .filter((l) => l.lat != null && l.lon != null && !dismissed.has(l.id))
      .slice(0, MAX_PINS)
    // Skip only when there's genuinely never been anything to draw (a
    // brand-new search's very first poll can be empty before any listing
    // exists). A dismiss that empties an already-populated layer must still
    // write through — otherwise the last-hidden pin would stick around stale.
    if (listings.length === 0 && !this.mapLayers.getMeta(`${LAYER_GROUP}/${slugFor(s)}`)) return
    const geojson = {
      type: 'FeatureCollection',
      features: listings.map((l) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
        properties: {
          price: l.price != null ? formatPrice(l.price, l.currency) : undefined,
          address: l.address ?? l.title,
          beds: l.bedrooms,
          area: l.floorArea,
          plot: l.plotArea,
          listed: l.listedAt?.slice(0, 10),
          url: l.url,
          // Extra detail for the SPA's property panel (not shown in the popup).
          title: l.title,
          baths: l.bathrooms,
          summary: l.summary,
          agent: l.agent,
          image: l.image,
          portal: l.portal,
          // Needed for the "not interested" dismiss action, not shown in the popup.
          listingId: l.id,
          searchId: s.id,
        },
      })),
    }
    try {
      this.mapLayers.upsert(`${LAYER_GROUP}/${slugFor(s)}`, geojson, {
        style: { color: LAYER_COLOR, size: 5, panel: true, popup: ['price', 'address', 'beds', 'area', 'plot', 'listed', 'url'] },
        fit: false,
        updatedBy: 'property',
      })
      this.bus.broadcast('map-layers', 'delta', { layers: this.mapLayers.list() })
    } catch (e) {
      this.log(`[property-sync] layer update failed for ${s.id}: ${(e as Error).message}`)
    }
  }

  private notify(s: PropertySearch, fresh: Listing[]): void {
    const label = s.label || `${s.country} ${s.criteria.channel === 'rent' ? 'rentals' : 'houses'}`
    if (fresh.length > MAX_ALERTS) {
      this.push.broadcast({
        type: 'calendar',
        title: `🏠 ${fresh.length} new · ${label}`,
        body: fresh
          .slice(0, 3)
          .map((l) => describe(l))
          .join(' · '),
        pane: 'map',
        id: `property-${s.id}`,
      })
      this.log(`[property-sync] notify (${fresh.length} new): ${s.id}`)
      return
    }
    for (const l of fresh) {
      this.push.broadcast({
        type: 'calendar',
        title: `🏠 ${describe(l)}`,
        body: `${label}${l.address ? ` — ${l.address}` : ''}`,
        pane: 'map',
        id: `property-${s.id}-${l.id}`,
      })
    }
    this.log(`[property-sync] notify (${fresh.length} new): ${s.id}`)
  }
}

/**
 * Enforce locally whatever the portal couldn't. Only the fields the portal
 * actually reported as unsupported — re-checking a server-side filter would
 * drop rows whose value the listing simply doesn't expose.
 */
export function postFilter(listings: Listing[], c: Criteria, unsupported: string[]): Listing[] {
  const missing = new Set(unsupported)
  return listings.filter((l) => {
    if (missing.has('minFloorArea') && c.minFloorArea != null && l.floorArea != null && l.floorArea < c.minFloorArea) {
      return false
    }
    if (missing.has('maxFloorArea') && c.maxFloorArea != null && l.floorArea != null && l.floorArea > c.maxFloorArea) {
      return false
    }
    if (missing.has('minPlotArea') && c.minPlotArea != null && l.plotArea != null && l.plotArea < c.minPlotArea) {
      return false
    }
    if (missing.has('maxPlotArea') && c.maxPlotArea != null && l.plotArea != null && l.plotArea > c.maxPlotArea) {
      return false
    }
    if (missing.has('minBathrooms') && c.minBathrooms != null && l.bathrooms != null && l.bathrooms < c.minBathrooms) {
      return false
    }
    if (missing.has('excludeSchemes') && c.excludeSchemes && matchesAny(l, SCHEME_TERMS)) return false
    if (missing.has('excludeAuctions') && c.excludeAuctions && matchesAny(l, AUCTION_TERMS)) return false
    // "Price on request" listings have no price field at all on any portal —
    // IS24 sends price.value: 0 for these (verified: the live page shows "Auf
    // Anfrage", not a data error), and normalise() already reads 0 as absent.
    if (missing.has('excludePriceOnRequest') && c.excludePriceOnRequest && l.price == null) return false
    if (missing.has('keywords') && c.keywords?.length) {
      const hay = `${l.title ?? ''} ${l.summary ?? ''} ${l.address ?? ''}`.toLowerCase()
      if (!c.keywords.some((k) => hay.includes(k.toLowerCase()))) return false
    }
    return true
  })
}

/**
 * Auctions and schemes are separate axes — an auction isn't inherently
 * undesirable (just a faster, cash-ready completion process), so it's a
 * distinct opt-out from retirement/shared-ownership stock.
 */
const AUCTION_TERMS = ['auction', 'for sale by tender', 'zwangsversteigerung', 'asta']
const SCHEME_TERMS = ['shared ownership', 'shared equity', 'part buy', 'retirement', 'over 55', 'over 60']

function matchesAny(l: Listing, terms: string[]): boolean {
  const hay = `${l.title ?? ''} ${l.summary ?? ''} ${l.propertyType ?? ''}`.toLowerCase()
  return terms.some((t) => hay.includes(t))
}

function sortNewestFirst(listings: Listing[]): Listing[] {
  return listings.slice().sort((a, b) => (b.listedAt ?? '').localeCompare(a.listedAt ?? ''))
}

function slugFor(s: PropertySearch): string {
  const base = (s.label || s.country).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base || s.country.toLowerCase()}-${s.id.slice(3)}`
}

function describe(l: Listing): string {
  const price = l.price != null ? formatPrice(l.price, l.currency) : '?'
  const beds = l.bedrooms != null ? ` ${l.bedrooms}bed` : ''
  const plot = l.plotArea != null ? ` ${l.plotArea}m² plot` : ''
  return `${price}${beds}${plot}`
}

function formatPrice(major: number, currency: string): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : ''
  const n = Math.round(major).toLocaleString('en-GB')
  return symbol ? `${symbol}${n}` : `${n} ${currency}`
}
