// kleinanzeigen.de client (Germany — the private-seller classifieds channel).
// Protocol notes: ~/sync/brain/root/projects/home/kleinanzeigen-api.md
//
// Why: ~75% of PRIVATE-seller houses on Kleinanzeigen are not on ImmoScout24
// (Marburg sample, 2026-09-07) — the biggest German source the hub lacks.
//
// Why it is dangerous: Akamai Bot Manager in front, and Kleinanzeigen's own
// hair-trigger IP-RANGE block behind it — "IP-Bereich vorübergehend gesperrt"
// (HTTP 403 on EVERY path) after ~6 plain requests in 2 min or 4 headless page
// loads in 30 s. The block hits the whole home connection, and the IPv6 range
// stayed blocked for hours after the IPv4 one lifted. Cadence matters more
// than fingerprint, so this client is built around pacing, not evasion:
//
//   PACING CONTRACT. Every request of any kind (search page, location lookup,
//   ad page) goes through one serialised gate: at least `minIntervalMs`
//   (default 25 s) between any two requests, IPv4 only (Node https with
//   `family: 4` — never the global fetch, which happily picks the AAAA record),
//   browser-like headers, no parallelism, no retries. At most
//   `maxRequestsPerRun` (default 120) requests in any rolling `runWindowMs`
//   (default 1 h) — when that is spent `newest()` returns what it has with
//   `truncated: true` and `count()`/`detail()` throw `kleinanzeigen: BUDGET`.
//   A 403/429 or a body that looks like the block page throws
//   `kleinanzeigen: BLOCKED …` and arms a back-off (`blockBackoffMs`, default
//   30 min) during which every call throws the same without touching the
//   network; the hub's loops treat a throw as "stop calling me". Nothing is
//   logged per page — the hub logs the summary.
//
// Geography: the site only knows "location id + radius" (5/10/20/30/50/100/
// 150/200 km), no polygon. Each search ring is covered by ONE circle centred
// on the nearest known town — the radius that reaches the ring's farthest
// vertex, rounded up to the next allowed value — because the zone's DE rings
// ARE 60-min isochrones around the candidate towns, so a town sits near each
// big ring's centre and one r100 covers it; the small transit-pocket rings
// fall to the nearest town at r50–r100. Location ids come from the site's own
// autocomplete (`/s-ort-empfehlungen.json`), resolved lazily through the same
// paced gate and cached on disk for good. The hub clips every row to the real
// polygon (`coordsPrecision: 'area'` → 6 km slack).
//
// Coordinates: the result card carries only "PLZ Ort"; lat/lon is on the ad
// page (`og:latitude`, a PLZ centroid). So rows come back WITHOUT coordinates
// until `detail()` runs — the hub's enrich loop fills them in, one paced
// request each — except where the card's PLZ is one this client has already
// seen on an ad page (a small on-disk PLZ → centroid memo grows with use).
//
// Server-side filters we do send are FAIL-CLOSED: `grundstuecksflaeche_d` and
// `zimmer_d` silently drop ads that don't state a plot size / room count
// (same trap as Rightmove's minSize). We send them anyway — at 25 s a page,
// the un-filtered Marburg r20 set is 9 pages vs 1–2 with them, and the block
// risk argues for the fewest requests, not the widest net.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import https from 'node:https'
import zlib from 'node:zlib'
import { parseHTML } from 'linkedom'
import type { Ring } from './geo.js'
import { haversineKm } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

const ORIGIN = 'https://www.kleinanzeigen.de'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
/** Häuser zum Kauf. */
const CATEGORY = 'c208'
/** Rows per SRP page (plus 1–2 duplicated "TOP" articles — deduped on data-adid). */
export const PAGE = 25
/** The SRP is capped at 50 pages → 1,250 rows per query; `truncated` past that. */
const MAX_PAGES = 50
/** Radii the UI offers. `r20` verified live; anything else is rounded UP to one of these. */
export const RADII_KM = [5, 10, 20, 30, 50, 100, 150, 200] as const
export const MAX_RADIUS_KM = 200
/** Zimmer counts living rooms too: a 2-bed house is a 3-Zimmer-Haus. */
const ROOM_OFFSET = 1
const DEFAULT_MIN_INTERVAL_MS = 25_000
const DEFAULT_MAX_REQUESTS_PER_RUN = 120
const DEFAULT_RUN_WINDOW_MS = 60 * 60 * 1000
const DEFAULT_BLOCK_BACKOFF_MS = 30 * 60 * 1000
/** A completed (un-truncated) query's rows are reusable for a smaller radius of the same town for this long. */
const RESULT_REUSE_MS = 60 * 60 * 1000
/** A failed location lookup is retried after this long. */
const LOOKUP_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CACHE_FILE = join(homedir(), '.cache', 'console', 'kleinanzeigen-locations.json')
const SUMMARY_CHARS = 400

/** Kleinanzeigen's own block page (403) — and Akamai's generic denial, which precedes it. */
const BLOCK_RE = /IP-Bereich vorübergehend gesperrt|IP-Bereich vor&uuml;bergehend gesperrt|<title>\s*Access Denied\s*<\/title>|Reference&#32;#\d|unsicheren Versuchen/i

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Locations

export interface SeedLocation {
  name: string
  /** Bundesland, to pick the right "Fürth" from the autocomplete. */
  state: string
  lat: number
  lon: number
  /** Verified id, when known. Others resolve lazily. */
  id?: number
}

/**
 * The candidate towns that define the livable zone (`data/town-amenities-
 * trimmed.json`, DE rows; Kerkrade is Dutch and dropped) plus the large cities
 * nearest the zone's small transit-pocket rings, so those don't have to be
 * covered from 60 km away. Only Marburg's id was verified by hand (api note);
 * the rest resolve through `/s-ort-empfehlungen.json` on first use.
 */
export const SEED_LOCATIONS: SeedLocation[] = [
  { name: 'Marburg', state: 'Hessen', lat: 50.8090106, lon: 8.7704695, id: 4825 },
  { name: 'Celle', state: 'Niedersachsen', lat: 52.624056, lon: 10.081052 },
  { name: 'Ingolstadt', state: 'Bayern', lat: 48.7630165, lon: 11.4250395 },
  { name: 'Paderborn', state: 'Nordrhein-Westfalen', lat: 51.7177044, lon: 8.752653 },
  { name: 'Arnsberg', state: 'Nordrhein-Westfalen', lat: 51.4002384, lon: 8.0605908 },
  { name: 'Wiesbaden', state: 'Hessen', lat: 50.0820384, lon: 8.2416556 },
  { name: 'Mainz', state: 'Rheinland-Pfalz', lat: 49.9995205, lon: 8.2736253 },
  { name: 'Darmstadt', state: 'Hessen', lat: 49.872775, lon: 8.651177 },
  { name: 'Aschaffenburg', state: 'Bayern', lat: 49.9738133, lon: 9.1446665 },
  { name: 'Heidelberg', state: 'Baden-Württemberg', lat: 49.4093582, lon: 8.694724 },
  { name: 'Mannheim', state: 'Baden-Württemberg', lat: 49.4892913, lon: 8.4673098 },
  { name: 'Koblenz', state: 'Rheinland-Pfalz', lat: 50.3533278, lon: 7.5943951 },
  { name: 'Fulda', state: 'Hessen', lat: 50.5514658, lon: 9.6762161 },
  { name: 'Würzburg', state: 'Bayern', lat: 49.7933723, lon: 9.9309779 },
  { name: 'Karlsruhe', state: 'Baden-Württemberg', lat: 49.0068705, lon: 8.4034195 },
  { name: 'Bonn', state: 'Nordrhein-Westfalen', lat: 50.7352621, lon: 7.1024635 },
  { name: 'Kassel', state: 'Hessen', lat: 51.3157833, lon: 9.4978479 },
  { name: 'Trier', state: 'Rheinland-Pfalz', lat: 49.7596208, lon: 6.6441878 },
  { name: 'Schwäbisch Hall', state: 'Baden-Württemberg', lat: 49.1124305, lon: 9.7371246 },
  { name: 'Fürth', state: 'Bayern', lat: 49.4772475, lon: 10.9893626 },
  { name: 'Bamberg', state: 'Bayern', lat: 49.8916044, lon: 10.8868478 },
  { name: 'Ansbach', state: 'Bayern', lat: 49.3028611, lon: 10.5722288 },
  { name: 'Göttingen', state: 'Niedersachsen', lat: 51.5328328, lon: 9.9351811 },
  { name: 'Aachen', state: 'Nordrhein-Westfalen', lat: 50.776351, lon: 6.083862 },
  { name: 'Tübingen', state: 'Baden-Württemberg', lat: 48.5203263, lon: 9.053596 },
  { name: 'Ulm', state: 'Baden-Württemberg', lat: 48.3984968, lon: 9.9912458 },
  { name: 'Freiburg', state: 'Baden-Württemberg', lat: 47.9960901, lon: 7.8494005 },
  { name: 'Münster', state: 'Nordrhein-Westfalen', lat: 51.9625101, lon: 7.6251879 },
  { name: 'Bielefeld', state: 'Nordrhein-Westfalen', lat: 52.0191005, lon: 8.531007 },
  { name: 'Regensburg', state: 'Bayern', lat: 49.0195333, lon: 12.0974869 },
  { name: 'Lörrach', state: 'Baden-Württemberg', lat: 47.6120896, lon: 7.6607218 },
  { name: 'Goslar', state: 'Niedersachsen', lat: 51.9059936, lon: 10.4266284 },
  { name: 'Erlangen', state: 'Bayern', lat: 49.5977469, lon: 11.0037372 },
  { name: 'Oldenburg', state: 'Niedersachsen', lat: 53.1389753, lon: 8.2146017 },
  { name: 'Landshut', state: 'Bayern', lat: 48.536217, lon: 12.1516551 },
  { name: 'Freising', state: 'Bayern', lat: 48.4008273, lon: 11.7439565 },
  // Cities nearest the transit-pocket slivers (not candidate towns themselves).
  { name: 'Hannover', state: 'Niedersachsen', lat: 52.3744779, lon: 9.7385532 },
  { name: 'Bremen', state: 'Bremen', lat: 53.0758196, lon: 8.8071646 },
  { name: 'Düsseldorf', state: 'Nordrhein-Westfalen', lat: 51.2254018, lon: 6.7763137 },
  { name: 'Mönchengladbach', state: 'Nordrhein-Westfalen', lat: 51.1946532, lon: 6.4353894 },
  { name: 'Wuppertal', state: 'Nordrhein-Westfalen', lat: 51.264018, lon: 7.1780374 },
  { name: 'Halle (Saale)', state: 'Sachsen-Anhalt', lat: 51.4825041, lon: 11.9705452 },
  { name: 'Wolfsburg', state: 'Niedersachsen', lat: 52.4205588, lon: 10.7861682 },
  { name: 'Augsburg', state: 'Bayern', lat: 48.3668041, lon: 10.8986971 },
  { name: 'Offenburg', state: 'Baden-Württemberg', lat: 48.4716556, lon: 7.944394 },
  { name: 'Stuttgart', state: 'Baden-Württemberg', lat: 48.7784485, lon: 9.1800132 },
]

interface LocationCacheEntry {
  id: number | null
  /** The autocomplete label we picked, for auditing ("Marburg - Hessen"). */
  label?: string
  at: number
}

interface CacheFile {
  locations: Record<string, LocationCacheEntry>
  /** PLZ → [lat, lon] learnt from ad pages' og:latitude/longitude. */
  plz: Record<string, [number, number]>
}

/** One query to run: a resolved location and a radius from RADII_KM. */
export interface Query {
  location: SeedLocation & { id: number }
  radiusKm: number
}

/** Round a radius up to the next value the UI offers (capped at 200). */
export function snapRadius(km: number): number {
  return RADII_KM.find((r) => r >= km) ?? MAX_RADIUS_KM
}

/**
 * The seed town from which a single circle covers the whole ring with the
 * smallest radius, and that radius (before snapping). Slivers far from every
 * town still resolve — to the nearest town with a big radius — because the
 * hub clips to the real polygon anyway.
 */
export function coverRing(ring: Ring, locations: readonly SeedLocation[]): { location: SeedLocation; radiusKm: number } | null {
  let best: { location: SeedLocation; radiusKm: number } | null = null
  for (const location of locations) {
    const centre: [number, number] = [location.lon, location.lat]
    let r = 0
    for (const p of ring) {
      const d = haversineKm(centre, p)
      if (d > r) r = d
      if (best && r >= best.radiusKm) break
    }
    if (!best || r < best.radiusKm) best = { location, radiusKm: r }
  }
  return best
}

/**
 * Turn rings into the fewest queries: one snapped circle per ring, deduped by
 * location, keeping only the largest radius per town (a smaller circle on the
 * same centre is inside it). Locations without an id yet come back in
 * `unresolved` for the client to look up.
 */
export function planQueries(rings: Ring[], locations: readonly SeedLocation[]): Array<{ location: SeedLocation; radiusKm: number }> {
  const byName = new Map<string, { location: SeedLocation; radiusKm: number }>()
  for (const ring of rings) {
    const c = coverRing(ring, locations)
    if (!c) continue
    const radiusKm = snapRadius(c.radiusKm)
    const prev = byName.get(c.location.name)
    if (!prev || radiusKm > prev.radiusKm) byName.set(c.location.name, { location: c.location, radiusKm })
  }
  return [...byName.values()]
}

/** URL slug for the location segment ("Schwäbisch Hall" → "schwaebisch-hall"). Cosmetic; `l<id>` is authoritative. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Pick the location id out of an autocomplete response
 * (`{"_0":"Deutschland","_4825":"Marburg - Hessen","_27814":"Wehrda - Marburg"}`).
 * Exact name match first, preferring the entry whose parent is the expected
 * Bundesland (two Fürths); then a prefix match either way ("Freiburg" for
 * "Freiburg im Breisgau"). Never the country root (`_0`).
 */
export function pickLocation(response: Record<string, string>, seed: Pick<SeedLocation, 'name' | 'state'>): { id: number; label: string } | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const want = norm(seed.name)
  const entries = Object.entries(response)
    .map(([k, label]) => {
      const id = Number(k.replace(/^_/, ''))
      const [name = '', ...rest] = label.split(' - ')
      return { id, label, name: norm(name), parent: norm(rest.join(' - ')) }
    })
    .filter((e) => Number.isFinite(e.id) && e.id > 0)
  const exact = entries.filter((e) => e.name === want)
  const pick = exact.find((e) => e.parent === norm(seed.state)) ?? exact[0] ?? entries.find((e) => want.startsWith(`${e.name} `) || e.name.startsWith(`${want} `) || e.name.startsWith(want))
  return pick ? { id: pick.id, label: pick.label } : null
}

// ---------------------------------------------------------------------------
// Criteria → URL

/**
 * Path segments (before `c208…`) and `+`-attributes (after it) for the
 * criteria. Grammar from the api note: `preis:<min>:<max>`, `anzeige:angebote`
 * (drops wanted-ads), `seite:<n>`; attributes are `haus_kaufen.<field>:<min>,<max>`.
 * Default sort is already newest-first, so no `sortierung:` (unverified, and
 * the one request that carried it was the one that got blocked).
 */
export function compile(c: Criteria): { segments: string[]; attributes: string[] } {
  if (c.channel === 'rent') throw new Error('kleinanzeigen: rent searches are not supported (Häuser zum Kauf only)')
  if (c.propertyType === 'flat') throw new Error('kleinanzeigen: flat searches are not supported (Häuser zum Kauf only)')
  const segments = ['anzeige:angebote']
  if (c.minPrice != null || c.maxPrice != null) segments.push(`preis:${c.minPrice ?? ''}:${c.maxPrice ?? ''}`)
  const attributes: string[] = []
  const range = (field: string, min?: number, max?: number) => {
    if (min == null && max == null) return
    attributes.push(`haus_kaufen.${field}:${min ?? ''},${max ?? ''}`)
  }
  range('zimmer_d', c.minBedrooms != null ? c.minBedrooms + ROOM_OFFSET : undefined, c.maxBedrooms != null ? c.maxBedrooms + ROOM_OFFSET : undefined)
  range('qm_d', c.minFloorArea, c.maxFloorArea)
  range('grundstuecksflaeche_d', c.minPlotArea, c.maxPlotArea)
  range('baujahr_i', c.minYearBuilt, c.maxYearBuilt)
  // `haustyp_s` takes ONE value (multi-select grammar unverified), so it is
  // only sent when exactly one mapped subtype is asked for; otherwise the
  // whole category comes back and the hub post-filters on the type text.
  const types = [...new Set((c.houseSubtypes ?? []).flatMap((s) => HAUSTYP[s] ?? []))]
  if (types.length === 1) attributes.push(`haus_kaufen.haustyp_s:${types[0]}`)
  if (c.noBuyerFee) attributes.push('haus_kaufen.provision_s:nein')
  return { segments, attributes }
}

/** Our portable subtypes → `haustyp_s` values (api note). Resthof/Landhaus have no facet: farmhouse = bauernhaus. */
const HAUSTYP: Record<string, string[]> = {
  detached: ['einfamilienhaus'],
  'semi-detached': ['doppelhaushaelfte'],
  terraced: ['reihenhaus'],
  bungalow: ['bungalow'],
  villa: ['villa'],
  farmhouse: ['bauernhaus'],
}

export function searchUrl(q: Query, c: Criteria, page = 1): string {
  const { segments, attributes } = compile(c)
  const segs = [...segments]
  if (page > 1) segs.push(`seite:${page}`)
  const tail = `${CATEGORY}l${q.location.id}r${q.radiusKm}${attributes.length ? `+${attributes.join('+')}` : ''}`
  return `${ORIGIN}/s-haus-kaufen/${slugify(q.location.name)}/${segs.join('/')}/${tail}`
}

/** Everything the portal cannot filter server-side; the hub post-filters what it can. */
export function unsupported(c: Criteria): string[] {
  const out: string[] = []
  const types = [...new Set((c.houseSubtypes ?? []).flatMap((s) => HAUSTYP[s] ?? []))]
  // Sent only as a single facet; several subtypes (or an unmapped one such as land) are post-filtered.
  if (c.houseSubtypes?.length && (types.length !== 1 || c.houseSubtypes.some((s) => !HAUSTYP[s]))) out.push('houseSubtypes')
  if (c.minBathrooms != null) out.push('minBathrooms')
  // Erbbaurecht has no facet.
  if (c.freeholdOnly) out.push('freeholdOnly')
  if (c.excludeCommonhold) out.push('excludeCommonhold')
  // Garten/Garage are checkmarks on the ad page, not search facets.
  if (c.mustHaveGarden) out.push('mustHaveGarden')
  if (c.mustHaveParking) out.push('mustHaveParking')
  // Free text would be a `k=` query param — unverified, and it widens the crawl; the hub regexes the summary.
  if (c.keywords?.length) out.push('keywords')
  if (c.minInternetMbit != null) out.push('minInternetMbit')
  if (c.excludeSchemes) out.push('excludeSchemes')
  // Zwangsversteigerung resellers list in the same category.
  if (c.excludeAuctions) out.push('excludeAuctions')
  if (c.excludeNewBuild) out.push('excludeNewBuild')
  if (c.maxDaysSinceAdded != null) out.push('maxDaysSinceAdded')
  // €1 / "VB" placeholders are the classifieds version of price-on-request.
  if (c.excludePriceOnRequest) out.push('excludePriceOnRequest')
  return out
}

// ---------------------------------------------------------------------------
// Client

export interface KleinanzeigenClientOptions {
  /** Floor between ANY two requests. Tests set 0. */
  minIntervalMs?: number
  /** Requests allowed per rolling `runWindowMs`. */
  maxRequestsPerRun?: number
  runWindowMs?: number
  /** After a BLOCKED response, refuse to touch the network for this long. */
  blockBackoffMs?: number
  /** Location-id / PLZ cache. `null` = memory only (tests). */
  cacheFile?: string | null
  /** Override the seed table (tests). */
  locations?: SeedLocation[]
}

export class KleinanzeigenClient implements PortalClient {
  readonly portal = 'kleinanzeigen' as const
  readonly currency = 'EUR'
  // A full pull is hours at 25 s/request; once a day is plenty. 40 detail
  // pages per tick ≈ 17 min — leaves the hourly budget for the skim.
  readonly pacing = { fullSyncIntervalMs: 24 * 60 * 60 * 1000, enrichPerTick: 40 }

  private readonly minIntervalMs: number
  private readonly maxRequestsPerRun: number
  private readonly runWindowMs: number
  private readonly blockBackoffMs: number
  private readonly cacheFile: string | null
  private readonly locations: SeedLocation[]

  private lastRequestAt = 0
  private requestTimes: number[] = []
  private blockedUntil = 0
  private blockedReason = ''
  /** Serialises the gate so two callers can never fire together. */
  private gate: Promise<void> = Promise.resolve()
  private readonly cookies = new Map<string, string>()
  private cache: CacheFile | null = null
  /** Completed query results, reusable for a smaller radius on the same town within RESULT_REUSE_MS. */
  private readonly recent = new Map<string, { radiusKm: number; at: number; listings: Listing[]; total: number }>()

  constructor(
    private readonly fetchImpl: typeof fetch = ipv4Fetch,
    opts: KleinanzeigenClientOptions = {},
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.maxRequestsPerRun = opts.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN
    this.runWindowMs = opts.runWindowMs ?? DEFAULT_RUN_WINDOW_MS
    this.blockBackoffMs = opts.blockBackoffMs ?? DEFAULT_BLOCK_BACKOFF_MS
    this.cacheFile = opts.cacheFile === undefined ? DEFAULT_CACHE_FILE : opts.cacheFile
    this.locations = opts.locations ?? SEED_LOCATIONS
  }

  /** Requests still allowed in the current rolling window. */
  budgetLeft(now = Date.now()): number {
    this.requestTimes = this.requestTimes.filter((t) => now - t < this.runWindowMs)
    return Math.max(0, this.maxRequestsPerRun - this.requestTimes.length)
  }

  /**
   * Sum of per-query "N Ergebnisse" — one page-1 request per query, so a
   * whole-zone count is ~30 requests (12+ min). Over-counts where circles
   * overlap; `newest()` dedupes for real.
   */
  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const q of await this.resolveQueries(rings)) {
      const page = parseSearchPage(await this.getText(searchUrl(q, criteria, 1)))
      total += page.total
    }
    return total
  }

  /**
   * Newest-first over one circle per ring (see header). `limit` caps rows
   * per query (2 pages for the hourly 50); `Infinity` walks to the last
   * page, the 50-page cap, or the run budget — `truncated` whenever rows
   * were left behind for any of those reasons.
   */
  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false
    const { segments, attributes } = compile(criteria)
    const filterKey = `${segments.join('/')}|${attributes.join('+')}`
    const queries = await this.resolveQueries(rings)

    for (const q of queries) {
      // A completed pull of the same town at ≥ this radius within the hour
      // already holds every row this circle can return (fullSync calls us
      // once per ring, so the sliver rings around a town come in as separate
      // calls right after the big one).
      const reuseKey = `${q.location.id}|${filterKey}`
      const reusable = this.recent.get(reuseKey)
      if (reusable && reusable.radiusKm >= q.radiusKm && Date.now() - reusable.at < RESULT_REUSE_MS && limit === Number.POSITIVE_INFINITY) {
        total += reusable.total
        for (const l of reusable.listings) if (!seen.has(l.id)) seen.set(l.id, l)
        continue
      }
      const rows = new Map<string, Listing>()
      let queryTotal = 0
      let complete = false
      for (let page = 1; ; page++) {
        if (this.budgetLeft() <= 0) {
          truncated = true
          break
        }
        const parsed = parseSearchPage(await this.getText(searchUrl(q, criteria, page)))
        if (page === 1) {
          queryTotal = parsed.total
          total += parsed.total
        }
        let fresh = 0
        for (const r of parsed.rows) {
          const l = this.toListing(r)
          if (!l) continue
          if (!rows.has(l.id)) {
            rows.set(l.id, l)
            fresh++
          }
          if (!seen.has(l.id)) seen.set(l.id, l)
        }
        // End of the query: an empty page, the arithmetic end when the total
        // is known, or a page that adds nothing (the portal repeating itself).
        // `hasNext` is informational only — the pagination markup is hashed
        // too, so a missing next-link must never end a walk early.
        if (parsed.rows.length === 0 || (queryTotal > 0 && page * PAGE >= queryTotal) || fresh === 0) {
          complete = true
          break
        }
        if (page * PAGE >= limit || page >= MAX_PAGES) {
          truncated = true
          break
        }
      }
      if (complete) this.recent.set(reuseKey, { radiusKm: q.radiusKm, at: Date.now(), listings: [...rows.values()], total: queryTotal })
    }

    return { portal: this.portal, total, listings: [...seen.values()], truncated, unsupported: unsupported(criteria) }
  }

  /**
   * The ad page: PLZ-centroid coordinates, plot area, Haustyp, listing date,
   * description. `null` when the ad is gone (404, "Gelöscht", "Nicht mehr
   * verfügbar"); throws on BLOCKED / budget so the hub's enrich loop stops.
   */
  async detail(listing: Listing): Promise<Partial<Listing> | null> {
    const res = await this.get(listing.url)
    if (res.status === 404 || res.status === 410) return null
    const html = await res.text()
    this.assertNotBlocked(res.status, html, listing.url)
    if (!res.ok) throw new Error(`kleinanzeigen: HTTP ${res.status} on ${listing.url}`)
    const d = parseAdPage(html)
    if (d === null) return null
    if (d.plz && d.lat != null && d.lon != null) this.rememberPlz(d.plz, d.lat, d.lon)
    const out: Partial<Listing> = { detailAt: Date.now() }
    if (d.lat != null && d.lon != null) {
      out.lat = d.lat
      out.lon = d.lon
      out.coordsPrecision = 'area'
    }
    if (d.price != null) out.price = d.price
    if (d.plotArea != null) out.plotArea = d.plotArea
    if (d.floorArea != null) out.floorArea = d.floorArea
    // The page's Schlafzimmer is a real bedroom count; else Zimmer − 1 as on the card.
    if (d.bedrooms != null) out.bedrooms = d.bedrooms
    else if (d.rooms != null) out.bedrooms = Math.max(0, d.rooms - ROOM_OFFSET)
    if (d.bathrooms != null) out.bathrooms = d.bathrooms
    if (d.propertyType) out.propertyType = d.propertyType
    if (d.listedAt) out.listedAt = d.listedAt
    if (d.description) out.description = d.description
    if (d.features.length) out.keyFeatures = d.features
    if (d.address) out.address = d.address
    if (d.agent) out.agent = d.agent
    return out
  }

  // ---- geography ----

  /**
   * Plan over the seed table, resolving ids as needed. A town the site
   * doesn't know (lookup → null) is dropped from the pool and the plan is
   * redone, so its rings fall to the next-best town.
   */
  private async resolveQueries(rings: Ring[]): Promise<Query[]> {
    let pool = this.locations
    while (pool.length) {
      const out: Query[] = []
      let dropped: SeedLocation | null = null
      for (const p of planQueries(rings, pool)) {
        const id = await this.locationId(p.location)
        if (id == null) {
          dropped = p.location
          break
        }
        out.push({ location: { ...p.location, id }, radiusKm: p.radiusKm })
      }
      if (!dropped) return out
      pool = pool.filter((l) => l !== dropped)
    }
    return []
  }

  /** Seed id → cache → one paced autocomplete request. `null` = the site has no such place. */
  private async locationId(loc: SeedLocation): Promise<number | null> {
    if (loc.id != null) return loc.id
    const cache = this.loadCache()
    const hit = cache.locations[loc.name]
    if (hit && (hit.id != null || Date.now() - hit.at < LOOKUP_MISS_TTL_MS)) return hit.id
    const url = `${ORIGIN}/s-ort-empfehlungen.json?query=${encodeURIComponent(loc.name)}`
    const body = await this.getText(url)
    let parsed: Record<string, string> = {}
    try {
      parsed = JSON.parse(body) as Record<string, string>
    } catch {
      throw new Error(`kleinanzeigen: location lookup for ${loc.name} did not return JSON`)
    }
    const pick = pickLocation(parsed, loc)
    cache.locations[loc.name] = { id: pick?.id ?? null, label: pick?.label, at: Date.now() }
    this.saveCache()
    return pick?.id ?? null
  }

  private loadCache(): CacheFile {
    if (this.cache) return this.cache
    let c: CacheFile = { locations: {}, plz: {} }
    if (this.cacheFile && existsSync(this.cacheFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Partial<CacheFile>
        c = { locations: raw.locations ?? {}, plz: raw.plz ?? {} }
      } catch {
        // Corrupt cache: start over; it only costs lookups.
      }
    }
    this.cache = c
    return c
  }

  private saveCache(): void {
    if (!this.cacheFile || !this.cache) return
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const tmp = `${this.cacheFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.cache, null, 2))
      renameSync(tmp, this.cacheFile)
    } catch {
      // Best effort — the cache is an optimisation.
    }
  }

  private rememberPlz(plz: string, lat: number, lon: number): void {
    const cache = this.loadCache()
    if (cache.plz[plz]) return
    cache.plz[plz] = [Number(lat.toFixed(4)), Number(lon.toFixed(4))]
    this.saveCache()
  }

  /** Row → Listing, with coordinates only where the card's PLZ has been seen on an ad page before. */
  toListing(r: RawRow): Listing | null {
    const l = normalise(r)
    if (!l) return null
    const plz = r.plz ?? (r.address ? /^\d{5}/.exec(r.address)?.[0] : undefined)
    const memo = plz ? this.loadCache().plz[plz] : undefined
    if (memo && l.lat == null) {
      l.lat = memo[0]
      l.lon = memo[1]
    }
    return l
  }

  // ---- transport ----

  private async getText(url: string): Promise<string> {
    const res = await this.get(url)
    const text = await res.text()
    this.assertNotBlocked(res.status, text, url)
    if (!res.ok) throw new Error(`kleinanzeigen: HTTP ${res.status} on ${url}`)
    return text
  }

  /**
   * One paced GET. Follows up to two redirects (each hop is a paced request),
   * keeps the site's cookies (`_abck`, `bm_sz`) like a browser would, never
   * retries. Throws `kleinanzeigen: BLOCKED` during the back-off, `kleinanzeigen:
   * BUDGET` when the rolling window is spent.
   */
  private async get(url: string): Promise<Response> {
    for (let hop = 0; ; hop++) {
      await this.acquire()
      const res = await this.fetchImpl(url, {
        headers: this.headers(url),
        redirect: 'manual',
      })
      this.storeCookies(res)
      if (res.status === 403 || res.status === 429) {
        const body = await res.text().catch(() => '')
        this.block(`HTTP ${res.status}`, body, url)
      }
      const location = res.headers.get('location')
      if (location && res.status >= 300 && res.status < 400 && hop < 2) {
        url = new URL(location, url).toString()
        continue
      }
      return res
    }
  }

  private headers(url: string): Record<string, string> {
    const json = url.includes('.json')
    const h: Record<string, string> = {
      'user-agent': UA,
      accept: json ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'de-DE,de;q=0.9,en;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': json ? 'empty' : 'document',
      'sec-fetch-mode': json ? 'cors' : 'navigate',
      'sec-fetch-site': json ? 'same-origin' : 'none',
      'sec-fetch-user': '?1',
      'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
    }
    if (json) h.referer = `${ORIGIN}/`
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    return h
  }

  private storeCookies(res: Response): void {
    const raw = typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [res.headers.get('set-cookie') ?? ''].filter(Boolean)
    for (const line of raw) {
      const first = line.split(';')[0] ?? ''
      const eq = first.indexOf('=')
      if (eq <= 0) continue
      const name = first.slice(0, eq).trim()
      const value = first.slice(eq + 1).trim()
      if (name) this.cookies.set(name, value)
    }
  }

  /** The serialised pacing gate. */
  private acquire(): Promise<void> {
    const turn = this.gate.then(async () => {
      const now = Date.now()
      if (now < this.blockedUntil) throw new Error(`kleinanzeigen: BLOCKED — backing off until ${new Date(this.blockedUntil).toISOString()} (${this.blockedReason})`)
      if (this.budgetLeft(now) <= 0) throw new Error(`kleinanzeigen: BUDGET — ${this.maxRequestsPerRun} requests in the last ${Math.round(this.runWindowMs / 60000)} min, try later`)
      const wait = this.lastRequestAt + this.minIntervalMs - now
      if (wait > 0) await sleep(wait)
      this.lastRequestAt = Date.now()
      this.requestTimes.push(this.lastRequestAt)
    })
    // Keep the chain alive whatever happened to this turn.
    this.gate = turn.then(
      () => undefined,
      () => undefined,
    )
    return turn
  }

  private assertNotBlocked(status: number, body: string, url: string): void {
    if (status === 403 || status === 429 || BLOCK_RE.test(body)) this.block(`HTTP ${status}`, body, url)
  }

  private block(why: string, body: string, url: string): never {
    const ref = /Ref#:?\s*([\w.]+)/.exec(body)?.[1]
    const ip = /IP#:?\s*([\d.a-f:]+)/i.exec(body)?.[1]
    this.blockedUntil = Date.now() + this.blockBackoffMs
    this.blockedReason = `${why}${ref ? ` Ref#${ref}` : ''}${ip ? ` IP#${ip}` : ''} on ${url}`
    throw new Error(`kleinanzeigen: BLOCKED — ${this.blockedReason}; backing off ${Math.round(this.blockBackoffMs / 60000)} min`)
  }
}

// ---------------------------------------------------------------------------
// IPv4-only transport

/**
 * fetch-shaped GET over Node https with `family: 4`. The global fetch resolves
 * AAAA first on a dual-stack host and the site's IPv6 range is the one that
 * stays blocked. Decompresses gzip/deflate/br, never follows redirects (the
 * client paces each hop itself). Returns a standard `Response`.
 */
export const ipv4Fetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    const req = https.request(
      url,
      { method: init?.method ?? 'GET', family: 4, headers, timeout: 30_000 },
      (res) => {
        const chunks: Buffer[] = []
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
        const stream =
          enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res
        stream.on('data', (c: Buffer) => chunks.push(c))
        stream.on('error', reject)
        stream.on('end', () => {
          const h = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (v == null) continue
            if (Array.isArray(v)) for (const x of v) h.append(k, x)
            else if (k.toLowerCase() !== 'content-encoding' && k.toLowerCase() !== 'content-length') h.set(k, v)
          }
          const status = res.statusCode ?? 0
          const body = Buffer.concat(chunks)
          resolve(new Response(status === 204 || status === 304 ? null : body, { status, statusText: res.statusMessage ?? '', headers: h }))
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('kleinanzeigen: request timed out')))
    req.on('error', reject)
    req.end()
  })

// ---------------------------------------------------------------------------
// HTML → rows

export interface RawRow {
  adid: string
  href: string
  title?: string
  /** "35466 Rabenau" */
  address?: string
  plz?: string
  /** "(17 km)" distance from the search centre, km. */
  distanceKm?: number
  summary?: string
  /** "199.999 €", "199.999 € VB", "1 €" */
  priceText?: string
  /** "180 m² · 7 Zi." */
  factsText?: string
  /** "Von Privat" or the dealer's name. */
  sellerText?: string
  /** Card date where the SRP shows one ("Heute, 12:34", "Gestern, 09:10", "06.09.2026"). */
  dateText?: string
  image?: string
  /** "TOP"/sponsored badge. */
  top?: boolean
}

export interface ParsedSearchPage {
  total: number
  rows: RawRow[]
  hasNext: boolean
}

const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** "199.999 €", "199.999 € VB", "1 €", "VB", "Zu verschenken" — the card's price line and nothing else. */
const PRICE_P_RE = /^(?:[\d.]+\s*€(?:\s*VB)?|VB|Zu verschenken|Preis auf Anfrage)$/i
/** "180 m² · 7 Zi.", "180 m²", "4 Zi." */
const FACTS_P_RE = /^(?:[\d.,]+\s*m²(?:\s*·\s*[\d.,]+\s*Zi\.?)?|[\d.,]+\s*Zi\.?)$/

/**
 * Parse an SRP. Classes are hashed, so this walks structure: every
 * `article[data-adid]`, the first `<span>` under it is "PLZ Ort", the next
 * "(N km)", `h3 a` the title, the `<p>`s are teaser / facts / price, the last
 * `<span>` the seller. Duplicated TOP articles are deduped on data-adid.
 */
export function parseSearchPage(html: string): ParsedSearchPage {
  const { document } = parseHTML(html)
  const total = parseGermanInt(/([\d.]+)\s*Ergebnis/i.exec(document.body?.textContent ?? '')?.[1]) ?? 0
  const rows: RawRow[] = []
  const seen = new Set<string>()
  for (const article of document.querySelectorAll('article[data-adid]')) {
    const adid = article.getAttribute('data-adid') ?? ''
    if (!adid || seen.has(adid)) continue
    seen.add(adid)
    const href = article.getAttribute('data-href') ?? article.querySelector('a[href*="/s-anzeige/"]')?.getAttribute('href') ?? ''
    const row: RawRow = { adid, href }
    const h = article.querySelector('h3 a, h2 a, h3, h2')
    row.title = text(h) || undefined
    const spans = [...article.querySelectorAll('span')].map(text).filter(Boolean)
    const addr = spans.find((s) => /^\d{5}\s+\S/.test(s))
    if (addr) {
      row.address = addr
      row.plz = addr.slice(0, 5)
    }
    const dist = spans.map((s) => /^\(\s*([\d.,]+)\s*km\s*\)$/.exec(s)).find(Boolean)
    if (dist) row.distanceKm = parseFloat(dist[1]!.replace(',', '.'))
    const ps = [...article.querySelectorAll('p')].map(text).filter(Boolean)
    // The price and facts <p>s are short and nothing but the figure — a teaser
    // that happens to mention "1.250 m² Grundstück" must not be taken for either.
    row.priceText = ps.find((p) => PRICE_P_RE.test(p)) ?? spans.find((s) => PRICE_P_RE.test(s))
    row.factsText = ps.find((p) => FACTS_P_RE.test(p)) ?? spans.find((s) => FACTS_P_RE.test(s))
    row.summary = ps.find((p) => p !== row.priceText && p !== row.factsText && p.length > 20 && !/^\d{5}\s/.test(p)) ?? undefined
    const seller = spans.filter((s) => s !== addr && !/^\(\s*[\d.,]+\s*km\s*\)$/.test(s) && !PRICE_P_RE.test(s) && !FACTS_P_RE.test(s) && !/^(Heute|Gestern|\d{2}\.\d{2}\.\d{4})/.test(s) && !/^TOP$/i.test(s) && !/^(Anzeige|Gesuch)$/i.test(s))
    row.sellerText = seller.length ? seller[seller.length - 1] : undefined
    row.dateText = spans.find((s) => /^(Heute|Gestern)\b|^\d{2}\.\d{2}\.\d{4}$/.test(s))
    row.top = spans.some((s) => /^TOP$/i.test(s)) || !!article.querySelector('[class*="topad" i], [class*="badge-top" i]')
    const img = article.querySelector('img')
    row.image = img?.getAttribute('src') ?? img?.getAttribute('data-src') ?? (img?.getAttribute('srcset')?.split(/\s+/)[0] || undefined) ?? undefined
    rows.push(row)
  }
  const hasNext = !!document.querySelector('a[aria-label*="Nächste" i], a[title*="Nächste" i], [class*="pagination-next" i]:not([disabled]), a[href*="seite:"][rel="next"], link[rel="next"]')
  return { total, rows, hasNext }
}

/** "199.999 € VB" → 199999; "1 €" → 1; "VB" alone / "Zu verschenken" → undefined. */
export function parsePrice(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = /([\d.]+)\s*€/.exec(s)
  if (!m) return undefined
  const n = parseGermanInt(m[1])
  return n && n > 0 ? n : undefined
}

export function parseGermanInt(s: string | undefined): number | undefined {
  if (!s) return undefined
  const n = parseInt(s.replace(/\./g, ''), 10)
  return Number.isFinite(n) ? n : undefined
}

/** "180 m² · 7 Zi." → { floorArea: 180, rooms: 7 }. Either may be missing. */
export function parseFacts(s: string | undefined): { floorArea?: number; rooms?: number } {
  if (!s) return {}
  const area = /([\d.]+(?:,\d+)?)\s*m²/.exec(s)?.[1]
  const rooms = /([\d.]+(?:,\d+)?)\s*Zi\b/.exec(s)?.[1]
  const num = (v?: string) => (v ? Number(v.replace(/\./g, '').replace(',', '.')) : undefined)
  return { floorArea: num(area), rooms: num(rooms) }
}

/**
 * Card date → ISO. "Heute, 12:34" / "Gestern, 09:10" relative to `now`
 * (Europe/Berlin is what the site means; the hub only sorts on this, so UTC
 * day boundaries are close enough), "06.09.2026" → that day at 00:00Z.
 */
export function parseCardDate(s: string | undefined, now = new Date()): string | undefined {
  if (!s) return undefined
  const time = /(\d{1,2}):(\d{2})/.exec(s)
  const day = (offset: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset, time ? Number(time[1]) : 0, time ? Number(time[2]) : 0))
    return d.toISOString()
  }
  if (/^Heute/i.test(s)) return day(0)
  if (/^Gestern/i.test(s)) return day(1)
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(s)
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))).toISOString()
  return undefined
}

/**
 * Best-effort Haustyp from the title until `detail()` reads the real one.
 * Leftmost match; the list has the compound forms first so "Bauernhaus" beats
 * "Haus". Resthof/Hof/Landhaus/Fachwerkhaus are kept as their own words so the
 * hub's farmland classifier sees them.
 */
const TYPE_RE = /\b(Resthof|Bauernhof|Bauernhaus|Landhaus|Fachwerkhaus|Einfamilienhaus|Zweifamilienhaus|Mehrfamilienhaus|Doppelhaush[äa]lfte|Doppelhaus|Reihen(?:mittel|end|eck)?haus|Bungalow|Villa|Stadthaus|Ferienhaus|Wohnhaus|Hofstelle|Hofreite|Anwesen|Gehöft|Aussiedlerhof|Forsthaus|Mühle|Ferienhaus|Holzhaus|Fertighaus|Haus)\b/i

export function typeFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const m = TYPE_RE.exec(title)
  if (!m) return undefined
  const t = m[1]!
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function normalise(r: RawRow, now = new Date()): Listing | null {
  if (!r.adid || !r.href) return null
  const facts = parseFacts(r.factsText)
  const priv = !!r.sellerText && /privat/i.test(r.sellerText)
  const url = r.href.startsWith('http') ? r.href : `${ORIGIN}${r.href.startsWith('/') ? '' : '/'}${r.href}`
  return {
    portal: 'kleinanzeigen',
    id: r.adid,
    url,
    title: r.title,
    address: r.address,
    // "VB" (Verhandlungsbasis) still carries the asking price; a bare 1 € placeholder is kept as-is for the hub's own filters.
    price: parsePrice(r.priceText),
    currency: 'EUR',
    // Zimmer − 1, like Subito's locali: a 3-Zimmer-Haus is a 2-bed.
    bedrooms: facts.rooms != null ? Math.max(0, Math.round(facts.rooms) - ROOM_OFFSET) : undefined,
    floorArea: facts.floorArea,
    // Never on the card; `detail()` fills it in from the ad page.
    plotArea: undefined,
    propertyType: typeFromTitle(r.title),
    // No coordinates on the card (PLZ centroid only via the ad page or the client's PLZ memo).
    coordsPrecision: 'area',
    listedAt: parseCardDate(r.dateText, now),
    summary: [r.title, r.summary].filter(Boolean).join(' — ').slice(0, SUMMARY_CHARS) || undefined,
    agent: r.sellerText ? (priv ? 'privat' : r.sellerText) : undefined,
    image: r.image,
  }
}

// ---------------------------------------------------------------------------
// Ad page

export interface ParsedAd {
  lat?: number
  lon?: number
  plz?: string
  address?: string
  price?: number
  floorArea?: number
  plotArea?: number
  /** Zimmer (all rooms). */
  rooms?: number
  /** Schlafzimmer — a real bedroom count, present on maybe half the ads. */
  bedrooms?: number
  bathrooms?: number
  propertyType?: string
  listedAt?: string
  description?: string
  features: string[]
  agent?: string
  /** "Reserviert •" prefix on the title. */
  reserved: boolean
}

/**
 * Ad page → fields. `null` when the page says the ad is gone ("Gelöscht •"
 * title prefix or `data-soldlabel="Nicht mehr verfügbar"`). Everything else
 * per the api note: `og:latitude`/`og:longitude` (PLZ centroid),
 * `.addetailslist--detail` label/value pairs, `#viewad-locality`,
 * `#viewad-extra-info` (DD.MM.YYYY), `#viewad-price`, `.userprofile-vip`.
 */
export function parseAdPage(html: string): ParsedAd | null {
  const { document } = parseHTML(html)
  const title = text(document.querySelector('#viewad-title'))
  if (/^Gelöscht\s*•/i.test(title) || document.querySelector('[data-soldlabel*="Nicht mehr verf" i]')) return null
  const meta = (p: string) => document.querySelector(`meta[property="${p}"]`)?.getAttribute('content') ?? undefined
  const lat = parseFloat(meta('og:latitude') ?? '')
  const lon = parseFloat(meta('og:longitude') ?? '')
  const out: ParsedAd = { features: [], reserved: /^Reserviert\s*•/i.test(title) }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    out.lat = lat
    out.lon = lon
  }
  const locality = text(document.querySelector('#viewad-locality'))
  if (locality) {
    out.address = locality
    out.plz = /\b(\d{5})\b/.exec(locality)?.[1]
  }
  out.price = parsePrice(text(document.querySelector('#viewad-price')))
  for (const li of document.querySelectorAll('.addetailslist--detail')) {
    const value = text(li.querySelector('.addetailslist--detail--value'))
    const label = text(li).replace(value, '').trim()
    if (!label) continue
    if (/^Wohnfläche/i.test(label)) out.floorArea = parseGermanNumber(value)
    else if (/^Grundstücksfläche/i.test(label)) out.plotArea = parseGermanNumber(value)
    else if (/^Zimmer$/i.test(label)) out.rooms = parseGermanNumber(value)
    else if (/^Schlafzimmer/i.test(label)) out.bedrooms = parseGermanNumber(value)
    else if (/^Badezimmer/i.test(label)) out.bathrooms = parseGermanNumber(value)
    else if (/^Haustyp/i.test(label)) out.propertyType = value || undefined
    else if (!value) out.features.push(label)
    else out.features.push(`${label}: ${value}`)
  }
  const extra = text(document.querySelector('#viewad-extra-info'))
  const date = /(\d{2})\.(\d{2})\.(\d{4})/.exec(extra)
  if (date) out.listedAt = new Date(Date.UTC(Number(date[3]), Number(date[2]) - 1, Number(date[1]))).toISOString()
  const desc = document.querySelector('#viewad-description-text')
  if (desc) {
    // <br> → newline before flattening, so paragraphs survive.
    for (const br of desc.querySelectorAll('br')) br.replaceWith('\n')
    out.description = (desc.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() || undefined
  }
  const profile = document.querySelector('.userprofile-vip')
  if (profile) {
    const t = text(profile)
    // Private sellers stay anonymous — their name is a person, not a brand.
    if (/Privater Nutzer|Privat/i.test(t)) out.agent = 'privat'
    else {
      const name = text(profile.querySelector('.userprofile-vip-name, a, span'))
      if (name) out.agent = name
    }
  }
  return out
}

/** "867 m²" → 867, "1.098 m²" → 1098, "3,5" → 3.5. */
export function parseGermanNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const s = value.replace(/[^\d.,]/g, '')
  if (!s) return undefined
  let norm: string
  if (s.includes(',')) norm = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) norm = s.replace(/\./g, '')
  else norm = s
  const n = Number(norm)
  return Number.isFinite(n) ? n : undefined
}
