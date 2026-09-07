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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { PushServer } from '../push.js'
import type { SyncBus } from '../sync-bus.js'
import type { MapLayerStore } from '../map-layers/store.js'
import type { GoogleMapsClient } from '../gmaps/client.js'
import { ringsInCountry, pointInGeometry, type Geometry, type Ring } from './geo.js'
import { PORTAL_BY_COUNTRY, PROPERTY_KINDS, portalOf, type PropertyKind, type PropertySearch, type PropertySearchStore, type ReviewState } from './store.js'
import { fetchAll, type PropertyInventoryStore } from './inventory.js'
import { groupDuplicates } from './dedupe.js'
import type { Criteria, Listing, PortalClient, Portal } from './types.js'
import { nearestAirport } from './airport-distance.js'
import { needsAirportDistance, normaliseHouseType, notifyRejection, withoutAirportGate, type NotifyCriteria } from './notify-filter.js'

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
/** Pins per kind layer. The inventory is the whole portal (UK ~8k), so this is a safety net, not a budget. */
const MAX_PINS = 25_000
/**
 * How often each search's inventory is re-pulled exhaustively. The hourly skim
 * catches new stock in between; this is what notices removals and price cuts.
 */
const FULL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
// Interested-listing liveness probes per search per poll (one request each).
const LIVENESS_MAX_PROBES = 30
// Interested pins: green on the orange layer, distinct from every other Map layer colour.
const INTERESTED_COLOR = '#22c55e'
const LISTING_ICON = '🏠'
const INTERESTED_ICON = '🏡'
/** Notifications per poll per search — beyond this, one summary push. */
const MAX_ALERTS = 5
/**
 * When `notifyCriteria.maxAirportDriveMinutes` is set, the airport lookup has
 * to run BEFORE the gate can decide — at most this many candidates per poll
 * get looked up (2–4 Routes calls each); the rest stay on the map un-pushed.
 * A gate strict enough to want drive time shouldn't be passing more than this.
 */
const DRIVE_GATE_MAX_LOOKUPS = 10

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
    private readonly inventory: PropertyInventoryStore,
    private readonly push: PushServer,
    private readonly bus: SyncBus,
    private readonly mapLayers: MapLayerStore,
    private readonly gmaps: GoogleMapsClient,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    this.log('[property-sync] starting (1h interval)')
    this.migrateLayers()
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
    const client = this.clients[portalOf(s)]
    const rings = this.rings(s.layer, s.country, s.maxRings)
    const r = await client.newest(rings, s.criteria, BACKFILL_LIMIT)
    const listings = this.applyOutsideBar(s, this.clipToLayer(s.layer, postFilter(r.listings, s.criteria, r.unsupported)))
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
    return this.review(id, listingId, dismissed ? 'dismissed' : 'none')
  }

  /** Yousef's verdict on a listing — repaints the pin (or removes it) at once. */
  review(id: string, listingId: string, state: ReviewState): PropertySearch | undefined {
    const s = this.searches.review(id, listingId, state)
    if (!s) return undefined
    this.updateLayer(s)
    this.bus.broadcast('property', 'updated', s)
    return s
  }

  /**
   * Interested listings outlive the newest-per-ring snapshot, so the snapshot
   * can't tell us when the portal drops one — ask the portal directly for each
   * interested listing the poll did NOT re-surface. `null` (WAF/network) keeps
   * the pin; only a definite "gone" removes it. Capped per poll so a large
   * shortlist can't turn the hourly tick into a scrape.
   */
  async pruneGone(id: string, snapshotIds: Set<string>): Promise<string[]> {
    const s = this.searches.get(id)
    if (!s?.interestedIds?.length) return []
    const client = this.clients[portalOf(s)]
    if (!client.isLive) return []
    const byId = new Map<string, Listing>(this.inventory.get(id).entries.map((l) => [l.id, l]))
    for (const l of s.lastResults ?? []) if (!byId.has(l.id)) byId.set(l.id, l)
    const gone: string[] = []
    let probes = 0
    for (const listingId of s.interestedIds) {
      if (snapshotIds.has(listingId)) continue
      const listing = byId.get(listingId)
      if (!listing) continue
      if (probes++ >= LIVENESS_MAX_PROBES) break
      const live = await client.isLive(listing, s.criteria)
      if (live === false) gone.push(listingId)
    }
    if (!gone.length) return []
    let current: PropertySearch | undefined
    for (const listingId of gone) current = this.searches.removeListing(id, listingId)
    this.inventory.markRemoved(id, gone)
    this.log(`[property-sync] ${id}: ${gone.length} interested listing(s) gone from the portal, removed: ${gone.join(', ')}`)
    if (current) {
      this.updateLayer(current)
      this.bus.broadcast('property', 'updated', current)
    }
    return gone
  }

  /**
   * Force a re-seed without a criteria/layer/country change — use after
   * correcting the *content* of a map layer a search already points at (the
   * slug is unchanged, so `store.update()`'s requeried check never fires on
   * its own). Next poll records the newly-in-scope listings silently instead
   * of notifying on all of them as if they'd just appeared.
   */
  reseed(id: string): PropertySearch | undefined {
    const s = this.searches.reseed(id)
    if (!s) return undefined
    this.bus.broadcast('property', 'updated', s)
    return s
  }

  /**
   * Exhaustive pull: everything the portal holds in the polygon for the
   * search's coarse criteria, into the inventory. Marks what the portal no
   * longer returns as removed, never notifies (the hourly skim owns "new"),
   * and redraws the kind layer. Runs every FULL_SYNC_INTERVAL_MS from tick(),
   * or on demand (`con map property sync <id>`).
   */
  async fullSync(id: string): Promise<PropertySearch | undefined> {
    const s = this.searches.get(id)
    if (!s) return undefined
    const client = this.clients[portalOf(s)]
    const started = Date.now()
    this.log(`[property-sync] ${s.id} full sync starting`)
    try {
      const rings = this.rings(s.layer, s.country, s.maxRings)
      const r = await fetchAll(client, rings, s.criteria)
      const snap = this.inventory.upsert(s.id, r.listings, { full: true })
      const live = snap.entries.filter((e) => e.removedAt == null).length
      const summary = {
        syncedAt: Date.now(),
        live,
        removed: snap.entries.length - live,
        total: r.total,
        truncated: r.truncated,
        queries: r.queries,
        durationMs: Date.now() - started,
      }
      const updated = this.searches.recordInventory(s.id, summary, r.listings.map((l) => l.id))
      if (updated && r.unsupported.length) this.searches.update(s.id, { unsupported: r.unsupported })
      this.log(
        `[property-sync] ${s.id} full sync: ${live} live (portal total ${r.total}${r.truncated ? ', TRUNCATED' : ''}), ${summary.removed} removed, ${r.queries} queries, ${Math.round(summary.durationMs / 1000)}s`,
      )
    } catch (e) {
      const error = (e as Error).message
      this.log(`[property-sync] ${s.id} full sync failed: ${error}`)
      const prev = s.inventory
      this.searches.update(s.id, {
        inventory: { syncedAt: prev?.syncedAt ?? 0, live: prev?.live ?? 0, removed: prev?.removed ?? 0, total: prev?.total ?? 0, truncated: prev?.truncated ?? false, queries: 0, durationMs: Date.now() - started, error },
      })
    }
    const current = this.searches.get(id)
    if (current) {
      this.updateLayer(current)
      this.bus.broadcast('property', 'updated', current)
    }
    return current
  }

  inventoryOf(id: string): ReturnType<PropertyInventoryStore['get']> {
    return this.inventory.get(id)
  }

  /** Edit a search; a coarse (criteria/layer/country) change also drops its inventory. */
  update(id: string, patch: Partial<Omit<PropertySearch, 'id' | 'createdAt'>>): PropertySearch | undefined {
    const before = this.searches.get(id)
    const s = this.searches.update(id, patch)
    if (!s) return undefined
    if (before?.inventory && !s.inventory) this.inventory.clear(id)
    this.updateLayer(s)
    this.bus.broadcast('property', 'updated', s)
    return s
  }

  /** Delete a search and everything it contributed to its kind layer. */
  remove(id: string): boolean {
    const s = this.searches.get(id)
    if (!s) return false
    this.searches.remove(id)
    this.inventory.clear(id)
    this.updateKindLayer(kindOf(s))
    this.bus.broadcast('property', 'deleted', { id })
    return true
  }

  /** Ad-hoc count for a candidate criteria set, without saving anything. */
  async count(country: keyof typeof PORTAL_BY_COUNTRY, layer: string, criteria: Criteria, maxRings?: number, portal?: Portal): Promise<number> {
    const rings = this.rings(layer, country, maxRings)
    return this.clients[portal ?? PORTAL_BY_COUNTRY[country]].count(rings, criteria)
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
      // Full pulls after the skims, so a slow one never delays "what's new".
      for (const s of this.searches.list()) {
        if (s.enabled === false) continue
        const last = s.inventory?.syncedAt ?? 0
        if (Date.now() - last < FULL_SYNC_INTERVAL_MS) continue
        await this.fullSync(s.id)
      }
    } finally {
      this.running = false
    }
  }

  private async pollSearch(s: PropertySearch): Promise<void> {
    const client = this.clients[portalOf(s)]
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
      // The inventory takes the coarse rows (fine filters re-run at draw time);
      // a skim only adds/refreshes — it can't know what's gone.
      this.inventory.upsert(s.id, r.listings, { full: false })
      listings = sortNewestFirst(this.applyOutsideBar(s, this.clipToLayer(s.layer, postFilter(r.listings, s.criteria, r.unsupported))))
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
    // A poll that returned nothing tells us nothing about liveness — don't probe.
    if (listings.length) await this.pruneGone(s.id, new Set(listings.map((l) => l.id)))
    if (update.seeding) {
      this.log(`[property-sync] ${s.id} seeded with ${listings.length} existing listings (no alerts)`)
      return
    }
    if (update.fresh.length) await this.notify(update.current, update.fresh)
  }

  /**
   * Look up + persist nearest-airport drive/transit time for listings that
   * are about to get their own individual notification (≤MAX_ALERTS — the
   * >MAX_ALERTS summary push shows no single listing's detail, so there's
   * nothing to attach it to). Silently skipped if Google Maps isn't
   * configured; a per-listing failure just leaves that one without a figure
   * rather than blocking the notification.
   */
  private async attachAirportDistances(s: PropertySearch, fresh: Listing[]): Promise<void> {
    if (!this.gmaps.isConfigured() || fresh.length > MAX_ALERTS) return
    await this.lookupAirportDistances(s, fresh)
  }

  private async lookupAirportDistances(s: PropertySearch, fresh: Listing[]): Promise<void> {
    if (!this.gmaps.isConfigured()) return
    let changed = false
    for (const l of fresh) {
      if (l.nearestAirport) continue
      if (l.lat == null || l.lon == null) continue
      try {
        const dist = await nearestAirport(this.gmaps, { lat: l.lat, lon: l.lon }, s.country)
        if (!dist) continue
        const nearestAirportField = {
          iata: dist.airport.iata,
          name: dist.airport.name,
          driveMinutes: dist.driveMinutes,
          transitMinutes: dist.transitMinutes,
        }
        l.nearestAirport = nearestAirportField
        this.searches.setNearestAirport(s.id, l.id, nearestAirportField)
        this.inventory.setNearestAirport(s.id, l.id, nearestAirportField)
        changed = true
      } catch (e) {
        this.log(`[property-sync] airport distance failed for ${l.id}: ${(e as Error).message}`)
      }
    }
    if (changed) {
      const current = this.searches.get(s.id)
      if (current) this.updateLayer(current)
    }
  }

  /** Every Polygon/MultiPolygon geometry in a map layer, FeatureCollection or bare Feature/Geometry. */
  private geometriesOf(layer: string): Geometry[] {
    const gj = this.mapLayers.getGeojson(layer) as
      | { type?: string; features?: Array<{ geometry?: Geometry }>; geometry?: Geometry }
      | null
    if (!gj) return []
    return gj.type === 'FeatureCollection'
      ? (gj.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => !!g)
      : gj.type === 'Feature'
        ? gj.geometry
          ? [gj.geometry]
          : []
        : [gj as unknown as Geometry]
  }

  /** Resolve a search's polygon from the map-layer store. */
  private rings(layer: string, country: keyof typeof PORTAL_BY_COUNTRY, maxRings?: number): Ring[] {
    const rings = this.geometriesOf(layer).flatMap((g) => ringsInCountry(g, country))
    if (rings.length === 0) throw new Error(`layer '${layer}' has no rings in ${country}`)
    return maxRings && maxRings > 0 ? rings.slice(0, maxRings) : rings
  }

  /**
   * `s.notifyLayer` resolves against a published map layer OR a raw geojson
   * file path — the latter so a one-off geofence (e.g. a single airport's
   * isochrone, already sitting in the vault's data/iso/ from the isochrone
   * pipeline) doesn't have to be re-published as a visible Map-tab layer just
   * to be usable here. A layer slug is a bare `group/name` (no leading slash,
   * no `~`, no file extension); anything else is treated as a path.
   */
  private geometriesForNotify(ref: string): Geometry[] {
    const looksLikePath = ref.startsWith('/') || ref.startsWith('~') || /\.(geo)?json$/i.test(ref)
    if (!looksLikePath) return this.geometriesOf(ref)
    try {
      const raw = readFileSync(ref.startsWith('~') ? join(homedir(), ref.slice(1)) : ref, 'utf8')
      const gj = JSON.parse(raw) as { type?: string; features?: Array<{ geometry?: Geometry }>; geometry?: Geometry }
      return gj.type === 'FeatureCollection'
        ? (gj.features ?? []).map((f) => f.geometry).filter((g): g is Geometry => !!g)
        : gj.type === 'Feature'
          ? gj.geometry
            ? [gj.geometry]
            : []
          : [gj as unknown as Geometry]
    } catch (e) {
      this.log(`[property-sync] failed to read notify geofence file '${ref}': ${(e as Error).message}`)
      return []
    }
  }

  /**
   * A push-noise filter, not a search filter — narrows fresh listings to the
   * ones inside `s.notifyLayer`'s polygon before deciding whether/how to
   * notify. Listings outside it were already merged into `lastResults` and
   * drawn on the map by the caller; this only decides whether the phone buzzes.
   * No `notifyLayer` set → notify on everything, as before.
   */
  private filterForNotify(s: PropertySearch, fresh: Listing[]): Listing[] {
    return applyNotifyGate(this.filterByGeofence(s, fresh), s.notifyCriteria && withoutAirportGate(s.notifyCriteria))
  }

  /**
   * The portal query is only an approximation of the layer: portals take outer
   * rings only (no holes), and some clip or simplify further. So every listing
   * that comes back is re-tested against the real geometry, holes included.
   * Listings without coordinates can't be tested and are kept.
   */
  private clipToLayer(layer: string, listings: Listing[]): Listing[] {
    const geometries = this.geometriesOf(layer)
    if (!geometries.length) return listings
    return listings.filter((l) => {
      if (l.lat == null || l.lon == null) return true
      const point: [number, number] = [l.lon, l.lat]
      return geometries.some((g) => pointInGeometry(point, g))
    })
  }

  /**
   * The two-tier bar: inside `notifyLayer` the search criteria are enough;
   * outside it a listing must ALSO pass `outsideCriteria`. No geofence or no
   * outside gate → pass-through. Uses the lookup-free part of the gate — this
   * runs over the whole snapshot every poll, not over a handful of fresh hits.
   */
  private applyOutsideBar(s: PropertySearch, listings: Listing[]): Listing[] {
    if (!s.outsideCriteria || !s.notifyLayer) return listings
    const geometries = this.geometriesForNotify(s.notifyLayer)
    if (!geometries.length) return listings
    const gate = withoutAirportGate(s.outsideCriteria)
    return listings.filter((l) => {
      if (l.lat != null && l.lon != null) {
        const point: [number, number] = [l.lon, l.lat]
        if (geometries.some((g) => pointInGeometry(point, g))) return true
      }
      return notifyRejection(l, gate) === null
    })
  }

  private filterByGeofence(s: PropertySearch, fresh: Listing[]): Listing[] {
    if (!s.notifyLayer) return fresh
    const geometries = this.geometriesForNotify(s.notifyLayer)
    if (!geometries.length) {
      this.log(`[property-sync] ${s.id}: notifyLayer '${s.notifyLayer}' not found or empty — notifying on everything`)
      return fresh
    }
    return fresh.filter((l) => {
      if (l.lat == null || l.lon == null) return false
      const point: [number, number] = [l.lon, l.lat]
      return geometries.some((g) => pointInGeometry(point, g))
    })
  }

  /**
   * The airport-drive gate is the one gate that needs a network lookup, so it
   * runs last, on the survivors of everything else, and only for a bounded
   * number of candidates per poll.
   */
  private async filterByAirportDrive(s: PropertySearch, fresh: Listing[]): Promise<Listing[]> {
    if (!needsAirportDistance(s.notifyCriteria)) return fresh
    const candidates = fresh.slice(0, DRIVE_GATE_MAX_LOOKUPS)
    if (fresh.length > candidates.length) {
      this.log(`[property-sync] ${s.id}: ${fresh.length} candidates for the airport-drive gate, looking up the newest ${candidates.length}`)
    }
    await this.lookupAirportDistances(s, candidates)
    return applyNotifyGate(candidates, { maxAirportDriveMinutes: s.notifyCriteria!.maxAirportDriveMinutes })
  }

  /** A search changed — redraw the kind layer it feeds. */
  private updateLayer(s: PropertySearch): void {
    this.updateKindLayer(kindOf(s))
  }

  /**
   * One pin layer per KIND (`property/house`, `property/farmland`), fed by
   * every search of that kind across all countries — Yousef wants to toggle
   * "houses", not "UK houses on Rightmove". Country and portal ride along as
   * popup fields. Pins come from the inventory (the whole portal), with the
   * fine filters, the zone clip and the outside-geofence bar applied at draw
   * time so a criteria tweak redraws without a re-pull.
   */
  private updateKindLayer(kind: PropertyKind): void {
    const slug = `${LAYER_GROUP}/${kind}`
    // Every fine-filtered listing of this kind, across searches and portals,
    // BEFORE verdicts — duplicates are grouped first so a verdict on one copy
    // covers the others.
    type Candidate = { lat: number; lon: number; price?: number; bedrooms?: number; source: string; l: Listing; s: PropertySearch; primary: boolean; dismissed: boolean; interested: boolean }
    const candidates: Candidate[] = []
    for (const s of this.searches.list()) {
      if (kindOf(s) !== kind) continue
      const dismissed = new Set(s.dismissedIds ?? [])
      const interested = new Set(s.interestedIds ?? [])
      const primary = portalOf(s) === PORTAL_BY_COUNTRY[s.country]
      const pool = this.inventory.live(s.id)
      // A search that has never been pulled in full still shows its skims.
      const source: Listing[] = pool.length ? pool : (s.lastResults ?? [])
      const kept = this.applyOutsideBar(s, this.clipToLayer(s.layer, postFilter(source, s.criteria, s.unsupported ?? [])))
      for (const l of kept) {
        if (l.lat == null || l.lon == null) continue
        candidates.push({ lat: l.lat, lon: l.lon, price: l.price, bedrooms: l.bedrooms, source: s.id, l, s, primary, dismissed: dismissed.has(l.id), interested: interested.has(l.id) })
      }
    }
    // Primary-portal copies first so they win the "which one do we draw" call.
    candidates.sort((a, b) => Number(b.primary) - Number(a.primary))

    const features: unknown[] = []
    for (const group of groupDuplicates(candidates)) {
      if (group.some((c) => c.dismissed)) continue
      const top = group[0]!
      const { l, s } = top
      const isInterested = group.some((c) => c.interested)
      const alsoOn = [...new Set(group.slice(1).map((c) => c.l.portal))]
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
        properties: {
          price: l.price != null ? formatPrice(l.price, l.currency) : undefined,
          address: l.address ?? l.title,
          beds: l.bedrooms,
          area: l.floorArea,
          plot: l.plotArea,
          listed: l.listedAt?.slice(0, 10),
          country: s.country,
          portal: l.portal,
          alsoOn: alsoOn.length ? alsoOn.join(', ') : undefined,
          airport: l.nearestAirport
            ? `${l.nearestAirport.driveMinutes}min drive${l.nearestAirport.transitMinutes != null ? ` / ${l.nearestAirport.transitMinutes}min transit` : ''} to ${l.nearestAirport.iata}`
            : undefined,
          url: l.url,
          // Extra detail for the SPA's property panel (not shown in the popup).
          title: l.title,
          baths: l.bathrooms,
          summary: l.summary,
          agent: l.agent,
          image: l.image,
          // Needed for the review actions, not shown in the popup.
          listingId: l.id,
          searchId: s.id,
          // House glyphs, not dots (Yousef, 2026-09-07): `_icon` is the
          // renderer's per-feature emoji hook (`em:<emoji>`, drawn on demand).
          // An emoji can't be recoloured, so "interested" is a different house —
          // 🏡 with its green garden reads as the good one. `_color` stays for
          // renderers that draw points as circles (Android) and the label layer.
          _icon: isInterested ? INTERESTED_ICON : LISTING_ICON,
          // Yousef's verdict; unreviewed pins carry neither key.
          ...(isInterested ? { review: 'interested', _color: INTERESTED_COLOR } : {}),
        },
      })
    }
    // Skip only when there's genuinely never been anything to draw. A dismiss
    // that empties an already-populated layer must still write through.
    if (features.length === 0 && !this.mapLayers.getMeta(slug)) return
    const geojson = { type: 'FeatureCollection', features: features.slice(0, MAX_PINS) }
    try {
      this.mapLayers.upsert(slug, geojson, {
        style: { color: LAYER_COLOR, size: 5, panel: true, popup: ['price', 'address', 'beds', 'area', 'plot', 'listed', 'country', 'portal', 'alsoOn', 'airport', 'url'] },
        fit: false,
        updatedBy: 'property',
      })
      this.bus.broadcast('map-layers', 'delta', { layers: this.mapLayers.list() })
    } catch (e) {
      this.log(`[property-sync] layer update failed for ${slug}: ${(e as Error).message}`)
    }
  }

  /**
   * Layers used to be one per search (`property/<label>-<id>`). Drop those and
   * draw the kind layers once, so a restart on the new code leaves no ghosts.
   */
  private migrateLayers(): void {
    const kinds = new Set<string>(PROPERTY_KINDS)
    let removed = 0
    for (const layer of this.mapLayers.list()) {
      if (layer.group === LAYER_GROUP && !kinds.has(layer.name)) {
        this.mapLayers.remove(layer.slug)
        removed++
      }
    }
    if (removed) this.log(`[property-sync] removed ${removed} legacy per-search layer(s)`)
    for (const kind of PROPERTY_KINDS) this.updateKindLayer(kind)
    if (removed) this.bus.broadcast('map-layers', 'delta', { layers: this.mapLayers.list() })
  }

  private async notify(s: PropertySearch, allFresh: Listing[]): Promise<void> {
    if (s.notify === false) {
      this.log(`[property-sync] ${s.id}: ${allFresh.length} new, notifications off for this search`)
      return
    }
    const fresh = await this.filterByAirportDrive(s, this.filterForNotify(s, allFresh))
    if (fresh.length === 0) {
      if (allFresh.length) {
        this.log(`[property-sync] ${s.id}: ${allFresh.length} new but 0 pass the notify gate (geofence + notifyCriteria), no push`)
      }
      return
    }
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
    // Compute before pushing, per Yousef: "before showing it" the nearest
    // airport's real drive + typical-morning transit time should already be
    // on the notification, not a follow-up.
    await this.attachAirportDistances(s, fresh)
    for (const l of fresh) {
      this.push.broadcast({
        type: 'calendar',
        title: `🏠 ${describe(l)}`,
        body: `${label}${l.address ? ` — ${l.address}` : ''}${airportSuffix(l)}`,
        pane: 'map',
        // One specific listing → open its real page directly. The map pane
        // has no "select this exact pin" deep-link today, so without this a
        // tap just lands on a generic map view with no indication of why.
        url: l.url,
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
    // Always local, whatever the portal filtered: portal type filters are
    // coarse and this is an exclusion, so it costs nothing to re-check.
    if (c.excludeHouseSubtypes?.length) {
      const types = normaliseHouseType(l.propertyType)
      if (types.some((t) => c.excludeHouseSubtypes!.includes(t))) return false
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
 * The "really good" gate — drops fresh listings that fail any set field of
 * `notifyCriteria`. Pure; pass-through when no criteria are set.
 */
export function applyNotifyGate(listings: Listing[], nc: NotifyCriteria | undefined): Listing[] {
  if (!nc) return listings
  return listings.filter((l) => notifyRejection(l, nc) === null)
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

function kindOf(s: PropertySearch): PropertyKind {
  return s.kind ?? 'house'
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

function airportSuffix(l: Listing): string {
  const a = l.nearestAirport
  if (!a) return ''
  const transit = a.transitMinutes != null ? ` / ${a.transitMinutes}min transit` : ''
  return ` — ${a.driveMinutes}min drive${transit} to ${a.iata}`
}
