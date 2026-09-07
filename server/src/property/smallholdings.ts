// smallholdingsforsale.co.uk client (UK, house + land). Protocol notes:
// ~/sync/brain/root/projects/home/smallholdingsforsale-api.md
//
// Not a portal — a curated WordPress feed of ~1,200 smallholding posts, UK-wide,
// with no coordinates and no server-side filters worth using. So `newest()`
// pulls the catalogue over the WP REST API (13 pages of 100 for the whole
// site, 1 page for the hourly skim), parses each rigid title into
// price / acres / beds / place, geocodes "<place>, <county>" through Nominatim
// (rate-limited, cached on disk so the catalogue geocodes once), and keeps the
// rows within AREA_BUFFER_KM of the search rings. Price/beds/plot are enforced
// here from the parsed title (cheaply, BEFORE geocoding) rather than reported
// as unsupported.
//
// Bare-land rule: a post with no bedroom count in its title AND no dwelling
// noun (farmhouse/house/bungalow/cottage/croft house/dwelling/home/
// smallholding/premises/chalet/barn conversion/annexe/property…), or whose
// title says "Land For Sale" / "Smallholding Land", is land or a development
// plot, not a house with land — dropped. Blog articles share the same feed
// (no price, no acres, no beds) and are dropped too.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { nearGeometry, type Geometry, type Ring } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

const BASE = 'https://smallholdingsforsale.co.uk'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const PAGE = 100
const PAGE_DELAY_MS = 1000
const POST_FIELDS = 'id,date_gmt,modified_gmt,link,title,categories,tags,excerpt'
export const M2_PER_ACRE = 4046.86
/**
 * Coordinates are a place centroid, so a listing counts as inside a ring when
 * within this many km of it — same slack PropertySync.clipToLayer gives
 * `coordsPrecision: 'area'` rows against the real geometry (holes included).
 */
const AREA_BUFFER_KM = 6

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
// Nominatim policy: identify yourself, absolute max 1 request/second.
const NOMINATIM_UA = 'console-property-sync/1.0 (+https://yousefamar.com; personal house hunt)'
const NOMINATIM_DELAY_MS = 1100
const DEFAULT_CACHE_FILE = join(homedir(), '.cache', 'console', 'geocode-uk.json')

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface SmallholdingsOptions {
  fetchImpl?: typeof fetch
  /** Persistent geocode cache. Defaults to ~/.cache/console/geocode-uk.json. */
  cacheFile?: string
  nominatimDelayMs?: number
  pageDelayMs?: number
  log?: (msg: string) => void
}

/** Diagnostics from the last `newest()` run — for smoke tests and logs. */
export interface RunStats {
  posts: number
  listings: number
  passedCriteria: number
  geocoded: number
  geocodeMisses: number
  inZone: number
  httpRequests: number
  ms: number
}

export class SmallholdingsClient implements PortalClient {
  readonly portal = 'smallholdings' as const
  readonly currency = 'GBP'
  readonly geocoder: UkGeocoder
  stats: RunStats | null = null

  private readonly fetchImpl: typeof fetch
  private readonly pageDelayMs: number
  private readonly log: (msg: string) => void
  private terms: Terms | null = null
  private requests = 0

  constructor(opts: SmallholdingsOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.pageDelayMs = opts.pageDelayMs ?? PAGE_DELAY_MS
    this.log = opts.log ?? (() => {})
    this.geocoder = new UkGeocoder(opts.cacheFile ?? DEFAULT_CACHE_FILE, this.fetchImpl, opts.nominatimDelayMs ?? NOMINATIM_DELAY_MS)
  }

  /** No count endpoint that knows about our polygon — run the feed and count. */
  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    return (await this.newest(rings, criteria, Infinity)).total
  }

  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const t0 = Date.now()
    const empty: SearchResult = { portal: this.portal, total: 0, listings: [], truncated: false, unsupported: [] }
    // Sales of houses with land only — nothing to rent, nothing that's a flat.
    if (criteria.channel === 'rent' || criteria.propertyType === 'flat') return empty

    const requestsBefore = this.requests + this.geocoder.requests
    const terms = await this.loadTerms()
    const { posts, truncated } = await this.fetchPosts(limit)
    const rows = posts.map((p) => normalise(p, terms)).filter((r): r is NormalisedPost => !!r)
    const candidates = rows.filter((r) => passesCriteria(r.listing, criteria))

    const geometry: Geometry | null = rings.length ? { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) } : null
    const kept: Listing[] = []
    let geocoded = 0
    let misses = 0
    for (const { listing, place, county, country } of candidates) {
      // Geocode only what already passed the cheap filters — the whole
      // catalogue is ~1,150 distinct places, a ≤£300k slice is ~60.
      const hit = place ? await this.geocoder.lookup(place, county, country) : null
      if (!hit) {
        misses++
        continue
      }
      geocoded++
      listing.lat = hit.lat
      listing.lon = hit.lon
      if (geometry && !nearGeometry([hit.lon, hit.lat], geometry, AREA_BUFFER_KM)) continue
      kept.push(listing)
    }

    this.stats = {
      posts: posts.length,
      listings: rows.length,
      passedCriteria: candidates.length,
      geocoded,
      geocodeMisses: misses,
      inZone: kept.length,
      httpRequests: this.requests + this.geocoder.requests - requestsBefore,
      ms: Date.now() - t0,
    }
    this.log(`[smallholdings] ${JSON.stringify(this.stats)}`)

    return { portal: this.portal, total: kept.length, listings: kept, truncated, unsupported: unsupported(criteria) }
  }

  /**
   * Posts are never pruned when sold, so this only says whether the post
   * itself still exists (404 → gone) or has been edited to say sold. The
   * agent's own page is the real liveness signal, but it's a different site
   * per agent, each with its own bot wall — out of scope.
   */
  async isLive(listing: Listing): Promise<boolean | null> {
    try {
      const res = await this.get(`${BASE}/wp-json/wp/v2/posts/${encodeURIComponent(listing.id)}?_fields=id,title,excerpt`, 1)
      if (res.status === 404 || res.status === 410) return false
      if (!res.ok) return null
      const p = (await res.json()) as RawPost
      const hay = `${p.title?.rendered ?? ''} ${p.excerpt?.rendered ?? ''}`
      return !/\b(sold|under offer|withdrawn)\b/i.test(hay)
    } catch {
      return null
    }
  }

  /**
   * One request for the post body: the agent (from the "Click To View
   * Listing" outbound link — the only place the agent appears), the full
   * write-up, the featured image, and — when the blurb carries a full UK
   * postcode, as agent copy usually does — postcode-level coordinates via the
   * same geocoder (still `area`: a postcode centroid, not the house).
   */
  async detail(listing: Listing): Promise<Partial<Listing> | null> {
    const url = `${BASE}/wp-json/wp/v2/posts/${encodeURIComponent(listing.id)}?_embed=wp:featuredmedia&_fields=id,content,_links.wp:featuredmedia,_embedded`
    const res = await this.get(url)
    if (res.status === 404 || res.status === 410) return null
    if (!res.ok) throw new Error(`smallholdings: HTTP ${res.status}`)
    const p = (await res.json()) as RawPost
    const html = p.content?.rendered ?? ''
    const out: Partial<Listing> = { detailAt: Date.now() }
    const text = htmlToText(html)
    if (text) out.description = text.slice(0, 4000)
    const agentUrl = agentLinkOf(html)
    if (agentUrl) out.agent = agentNameOf(agentUrl)
    const media = p._embedded?.['wp:featuredmedia']?.[0]
    const image = media?.media_details?.sizes?.medium?.source_url ?? media?.source_url
    if (image) out.image = image
    const postcode = text.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/)?.[1]
    if (postcode) {
      const hit = await this.geocoder.lookupPostcode(postcode.replace(/\s+/g, ' '))
      if (hit) {
        out.lat = hit.lat
        out.lon = hit.lon
        out.coordsPrecision = 'area'
      }
    }
    return out
  }

  /** Newest-first raw posts, up to `limit` of them (all pages when Infinity). */
  private async fetchPosts(limit: number): Promise<{ posts: RawPost[]; truncated: boolean }> {
    const perPage = Number.isFinite(limit) ? Math.min(PAGE, Math.max(1, Math.ceil(limit))) : PAGE
    const posts: RawPost[] = []
    let totalPages = Infinity
    let exhausted = false
    let page = 1
    while (posts.length < limit) {
      if (page > 1) await sleep(this.pageDelayMs)
      const url = `${BASE}/wp-json/wp/v2/posts?per_page=${perPage}&page=${page}&orderby=date&order=desc&_fields=${POST_FIELDS}`
      const res = await this.get(url)
      if (res.status === 400) {
        // Past the last page: `rest_post_invalid_page_number`.
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        if (body.code !== 'rest_post_invalid_page_number') throw new Error('smallholdings: HTTP 400')
        exhausted = true
        break
      }
      if (!res.ok) throw new Error(`smallholdings: HTTP ${res.status}`)
      const tp = parseInt(res.headers.get('x-wp-totalpages') ?? '', 10)
      if (Number.isFinite(tp)) totalPages = tp
      const rows = (await res.json()) as RawPost[]
      posts.push(...rows)
      if (rows.length < perPage || page >= totalPages) {
        exhausted = true
        break
      }
      page++
    }
    // Stopped by the limit with catalogue left over (spare rows on this page, or pages after it).
    const truncated = !exhausted && (posts.length > limit || page < totalPages)
    return { posts: Number.isFinite(limit) ? posts.slice(0, limit) : posts, truncated }
  }

  /** Category (county / country) and tag (feature) names, fetched once per process. */
  private async loadTerms(): Promise<Terms> {
    if (this.terms) return this.terms
    const categories = new Map<number, string>()
    const tags = new Map<number, string>()
    try {
      for (let page = 1; page <= 3; page++) {
        const res = await this.get(`${BASE}/wp-json/wp/v2/categories?per_page=100&page=${page}&_fields=id,name`)
        if (!res.ok) break
        const rows = (await res.json()) as Array<{ id: number; name: string }>
        for (const r of rows) categories.set(r.id, decodeEntities(r.name))
        if (rows.length < 100) break
        await sleep(this.pageDelayMs)
      }
      const res = await this.get(`${BASE}/wp-json/wp/v2/tags?per_page=100&_fields=id,slug`)
      if (res.ok) for (const r of (await res.json()) as Array<{ id: number; slug: string }>) tags.set(r.id, r.slug)
    } catch (e) {
      // Terms are a nicety (county from categories, features from tags); the
      // excerpt still names the county, so carry on without them.
      this.log(`[smallholdings] terms fetch failed: ${(e as Error).message}`)
    }
    this.terms = { categories, tags }
    return this.terms
  }

  /** GET with back-off on 429/5xx. `attempts: 1` for probes, where "don't know" is a fine answer. */
  private async get(url: string, attempts = 3): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      this.requests++
      const res = await this.fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json' } })
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(2000 * attempt)
        continue
      }
      return res
    }
  }
}

// ---------------------------------------------------------------------------
// Criteria

/** Everything the feed can't express AND we don't enforce here — PropertySync.postFilter takes these. */
function unsupported(c: Criteria): string[] {
  const out: string[] = []
  // Text-matched by sync (title + summary carry "(By Auction)" / "opening bid").
  if (c.excludeAuctions) out.push('excludeAuctions')
  if (c.excludeSchemes) out.push('excludeSchemes')
  if (c.excludePriceOnRequest) out.push('excludePriceOnRequest')
  if (c.keywords?.length) out.push('keywords')
  // Fields the feed simply doesn't carry — sync's post-filter is fail-open on
  // absent values, so listing them is honest and harmless.
  if (c.minFloorArea != null) out.push('minFloorArea')
  if (c.maxFloorArea != null) out.push('maxFloorArea')
  if (c.minBathrooms != null) out.push('minBathrooms')
  if (c.minYearBuilt != null) out.push('minYearBuilt')
  if (c.maxYearBuilt != null) out.push('maxYearBuilt')
  if (c.minInternetMbit != null) out.push('minInternetMbit')
  if (c.freeholdOnly) out.push('freeholdOnly')
  if (c.excludeCommonhold) out.push('excludeCommonhold')
  if (c.mustHaveParking) out.push('mustHaveParking')
  if (c.excludeNewBuild) out.push('excludeNewBuild')
  if (c.noBuyerFee) out.push('noBuyerFee')
  if (c.houseSubtypes?.length) out.push('houseSubtypes')
  return out
}

/**
 * Local enforcement of what the title gives us. Fail-open on absent values
 * (like every other local post-filter) EXCEPT bedrooms: a row without a bed
 * count that survived the bare-land rule is a dwelling of unknown size, and a
 * `minBedrooms` search shouldn't pay a geocode for it.
 */
export function passesCriteria(l: Listing, c: Criteria): boolean {
  if (c.minPrice != null && l.price != null && l.price < c.minPrice) return false
  if (c.maxPrice != null && l.price != null && l.price > c.maxPrice) return false
  if (c.minBedrooms != null && (l.bedrooms == null || l.bedrooms < c.minBedrooms)) return false
  if (c.maxBedrooms != null && l.bedrooms != null && l.bedrooms > c.maxBedrooms) return false
  if (c.minPlotArea != null && l.plotArea != null && l.plotArea < c.minPlotArea) return false
  if (c.maxPlotArea != null && l.plotArea != null && l.plotArea > c.maxPlotArea) return false
  if (c.maxDaysSinceAdded != null && l.listedAt) {
    const age = (Date.now() - Date.parse(l.listedAt)) / 86_400_000
    if (age > c.maxDaysSinceAdded) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Title grammar

export interface ParsedTitle {
  price?: number
  acres?: number
  bedrooms?: number
  place?: string
  /** The title's own noun phrase, e.g. "Farmhouse Smallholding"; `smallholding` when there's none. */
  type: string
  auction: boolean
}

// Case-sensitive on purpose: titles are Title Case, so "in Sedbergh" is a
// place but "in excess" (excerpt prose) and "Including" are not.
const PLACE_PREPOSITION = /\b(?:[Ii]n|[Nn]r\.?|[Nn]ear|[Bb]y|[Oo]n the (?:[Ii]sland|[Ii]sle) of)\s+(?=[A-Z0-9])/g
// Only a "(Nr. Ruthin)"-style bracket is a place; "(By Auction)" / "(Agricultural Tie)" are not.
const BRACKET_PLACE = /^(?:[Nn]r\.?|[Nn]ear)\s+/
const LAND_NOUNS = new Set([
  'land', 'pasture', 'pastureland', 'paddock', 'paddocks', 'woodland', 'woodlands', 'grounds', 'grassland', 'garden', 'gardens',
  'field', 'fields', 'meadow', 'meadows', 'orchard', 'forest', 'forestry', 'croft', 'farmland', 'moorland', 'marsh', 'marshland',
  'lawn', 'lawns', 'ancient', 'mixed', 'productive', 'agricultural', 'arable', 'rough', 'grazing', 'hill', 'lowland', 'upland',
])
const DWELLING_NOUN = /\b(?:farm ?house|house|longhouse|bungalow|cottages?|croft house|dwellings?|home|smallholding|premises|chalet|barn conversion|annexe?|cabin|lodge|propert(?:y|ies)|farmstead)\b/i
// Land / plot posts even when they name a bed count ("Plot For Sale With
// Planning Permission For 3 Bed Dwelling").
const LAND_ONLY = /\bland for sale\b|\bsmallholding land\b|\bplot for sale\b|^\s*(?:building|development)?\s*plot\b/i
const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * `<N> Bed <Type> Smallholding For Sale [With|Inc. …] <A> Acres … in <Place> (£<P>K|M)`
 * plus the variants seen across the whole catalogue (2026-09-07): "Nr."/"Near"/
 * "by" places, a trailing "- £575K", "(£135K opening bid)", "(525K)" without
 * the £, "Six-bedroom", "Acres of <Place>" with the "in" missing, a postcode
 * after the place. The excerpt ("<County> <N> bed <A> acres £<P>K") is the
 * fallback for beds and acres when the title omits them.
 */
export function parseTitle(rawTitle: string, rawExcerpt = ''): ParsedTitle {
  const t = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim()
  const ex = decodeEntities(stripHtml(rawExcerpt)).replace(/\s+/g, ' ').trim()

  const price = parsePrice(t)
  const bedrooms = parseBeds(t) ?? parseBeds(ex)
  const acres = parseAcres(t) ?? parseAcres(ex)

  // Everything before the price segment is where the place lives.
  let body = t.replace(/\s*[-–]?\s*\(?\s*£?\s*\d+(?:[.,]\d+)?\s*[km]\b[^)]*\)?\s*$/i, '').trim()
  let place: string | undefined
  // "(Nr. Ruthin)" — a bracketed place at the very end.
  const bracket = body.match(/\(([^()]*)\)\s*$/)
  if (bracket) {
    const inner = bracket[1]!.trim()
    body = BRACKET_PLACE.test(inner) ? inner : body.slice(0, bracket.index).trim()
  }
  const preps = [...body.matchAll(PLACE_PREPOSITION)]
  const last = preps[preps.length - 1]
  if (last && last.index != null) place = cleanPlace(body.slice(last.index + last[0].length))
  if (!place) {
    // "2 Acres of Lancester" — the "in" was dropped; only take it when the
    // tail isn't a land noun phrase ("Acres of Ancient Woodland").
    const m = body.match(/[Aa]cres?\s+[Oo]f\s+([A-Z][\w'’.-]*(?:[ -][A-Z][\w'’.-]*)*)\s*$/)
    if (m) {
      const words = m[1]!.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== 'and' && w !== '&' && w !== 'of')
      if (!words.every((w) => LAND_NOUNS.has(w))) place = cleanPlace(m[1]!)
    }
  }

  return { price, acres, bedrooms, place, type: parseType(t), auction: /\bauction\b|\bbid\b/i.test(t) }
}

function parsePrice(t: string): number | undefined {
  const m = t.match(/£\s*(\d+(?:[.,]\d+)?)\s*([km])\b/i) ?? t.match(/\(\s*(\d+(?:\.\d+)?)\s*([km])\b/i)
  if (m) {
    const n = parseFloat(m[1]!.replace(',', '.'))
    return Math.round(n * (m[2]!.toLowerCase() === 'k' ? 1_000 : 1_000_000))
  }
  const plain = t.match(/£\s*(\d{1,3}(?:,\d{3})+|\d{4,})\b/)
  return plain ? parseInt(plain[1]!.replace(/,/g, ''), 10) : undefined
}

function parseBeds(s: string): number | undefined {
  const m = s.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*bed(?:room)?s?\b/i)
  if (!m) return undefined
  const w = m[1]!.toLowerCase()
  return WORD_NUMBERS[w] ?? parseInt(w, 10)
}

function parseAcres(s: string): number | undefined {
  const m = s.match(/(\d+(?:\.\d+)?)\s*acres?\b/i)
  return m ? parseFloat(m[1]!) : undefined
}

function parseType(t: string): string {
  const cut = t.search(/\bfor sale\b/i)
  let head = cut > 0 ? t.slice(0, cut) : t.split(/\s+(?:with|inc\.?|including)\s+/i)[0] ?? ''
  head = head
    .replace(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*bed(?:room)?s?\b/gi, '')
    .replace(/^\s*\d+x?\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!head || /^\d/.test(head) || /\bacres?\b/i.test(head)) return 'smallholding'
  return head
}

const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/

function cleanPlace(s: string): string | undefined {
  const raw = s.replace(/\s*[-–]\s*$/, '').replace(/[\s,.]+$/, '').trim()
  // "in LL12 9EW" — a bare full postcode geocodes better than any place name.
  if (FULL_POSTCODE.test(raw.toUpperCase())) return raw.toUpperCase().replace(/\s+/g, ' ')
  const p = raw
    // Trailing UK postcode or outward code ("Haile, Egremont, CA22").
    .replace(/,?\s*\b[A-Z]{1,2}\d[A-Z\d]?(?:\s*\d[A-Z]{2})?\s*$/, '')
    .replace(/^(?:nr\.?|near|the)\s+/i, '')
    .replace(/[\s,.]+$/, '')
    .trim()
  if (!p || /^\d/.test(p)) return undefined
  return p
}

/**
 * True for land / development plots / barns-with-permission — not a house with
 * land. `bedrooms` must be the TITLE's own count: an excerpt can say "3 bed"
 * about the barn conversion the planning permission allows.
 */
export function isBareLand(title: string, bedrooms: number | undefined): boolean {
  const t = decodeEntities(title)
  if (LAND_ONLY.test(t)) return true
  if (bedrooms != null) return false
  return !DWELLING_NOUN.test(t)
}

// ---------------------------------------------------------------------------
// Post → Listing

export interface Terms {
  categories: Map<number, string>
  tags: Map<number, string>
}

export interface RawPost {
  id: number
  date_gmt?: string
  date?: string
  modified_gmt?: string
  link?: string
  title?: { rendered?: string }
  excerpt?: { rendered?: string }
  content?: { rendered?: string }
  categories?: number[]
  tags?: number[]
  _embedded?: { 'wp:featuredmedia'?: Array<{ source_url?: string; media_details?: { sizes?: Record<string, { source_url?: string }> } }> }
}

const COUNTRIES: Record<string, string> = { ENGLAND: 'England', SCOTLAND: 'Scotland', WALES: 'Wales', 'NORTHERN IRELAND': 'Northern Ireland' }

/** A Listing plus the geocoding inputs, which don't belong on the wire. */
export interface NormalisedPost {
  listing: Listing
  place?: string
  county?: string
  country?: string
}

export function normalise(p: RawPost, terms: Terms = { categories: new Map(), tags: new Map() }): NormalisedPost | null {
  if (!p.id) return null
  const rawTitle = p.title?.rendered ?? ''
  const rawExcerpt = p.excerpt?.rendered ?? ''
  // Blog articles ride the same feed (uncategorised, no structured title). The
  // TITLE must carry at least one of price/acres/beds — an article's excerpt
  // can mention "50 acres" and must not qualify it.
  const titleOnly = parseTitle(rawTitle)
  if (titleOnly.price == null && titleOnly.acres == null && titleOnly.bedrooms == null) return null
  if (isBareLand(rawTitle, titleOnly.bedrooms)) return null
  const parsed = parseTitle(rawTitle, rawExcerpt)

  let county: string | undefined
  let country: string | undefined
  for (const id of p.categories ?? []) {
    const name = terms.categories.get(id)
    if (!name || name === 'Uncategorized') continue
    if (COUNTRIES[name.toUpperCase()] && name === name.toUpperCase()) country = COUNTRIES[name.toUpperCase()]
    else if (/^smallhold/i.test(name)) return null // advice / discussion / wanted
    else county ??= name
  }
  // No categories loaded → the excerpt leads with the county ("Norfolk 4 bed …").
  county ??= countyFromExcerpt(rawExcerpt)

  const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim()
  const features = (p.tags ?? []).map((id) => terms.tags.get(id)).filter((s): s is string => !!s)
  const listing: Listing = {
    portal: 'smallholdings',
    id: String(p.id),
    url: p.link ?? `${BASE}/?p=${p.id}`,
    title,
    address: [parsed.place, county].filter(Boolean).join(', ') || undefined,
    price: parsed.price,
    currency: 'GBP',
    bedrooms: parsed.bedrooms,
    plotArea: parsed.acres != null ? acresToM2(parsed.acres) : undefined,
    propertyType: parsed.type,
    coordsPrecision: 'area',
    listedAt: toIso(p.date_gmt ?? p.date),
    summary: summaryOf(rawExcerpt),
    keyFeatures: features.length ? features : undefined,
  }
  return { listing, place: parsed.place, county, country }
}

export function acresToM2(acres: number): number {
  return Math.round(acres * M2_PER_ACRE)
}

function countyFromExcerpt(rawExcerpt: string): string | undefined {
  const ex = decodeEntities(stripHtml(rawExcerpt)).replace(/\s+/g, ' ').trim()
  const m = ex.match(/^([A-Z][A-Za-z&'’ .-]{1,40}?)\s+(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|derelict|parcel)\b/i)
  return m?.[1]?.trim() || undefined
}

function summaryOf(rawExcerpt: string): string | undefined {
  const text = decodeEntities(stripHtml(rawExcerpt.replace(/<a\b[\s\S]*$/i, '')))
    .replace(/\s*\[…\]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, 400) : undefined
}

function toIso(d: string | undefined): string | undefined {
  if (!d) return undefined
  const ms = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(d) ? d : `${d}Z`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ')
}

function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/Click To View Listing/gi, '')
    .trim()
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', pound: '£' }

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

/** The outbound agent link in a post body — the only URL not on this site. */
function agentLinkOf(html: string): string | undefined {
  for (const m of html.matchAll(/href="([^"]+)"/gi)) {
    try {
      const u = new URL(m[1]!)
      const host = u.hostname.toLowerCase()
      if (host.endsWith('smallholdingsforsale.co.uk')) continue
      if (/facebook|twitter|x\.com|instagram|youtube|google|pinterest|linkedin|whatsapp/.test(host)) continue
      return u.toString()
    } catch {
      // relative or malformed href — not an agent link
    }
  }
  return undefined
}

/** "www.hallsgb.com" → "hallsgb.com". A host is the most stable agent identity across posts. */
function agentNameOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
}

// ---------------------------------------------------------------------------
// Geocoding

export interface GeoHit {
  lat: number
  lon: number
}

/**
 * Nominatim with a persistent on-disk cache and a serialised ≥1.1 s gap
 * between requests. Misses are cached as null so a place Nominatim can't
 * resolve costs one request ever, not one per poll. Network/5xx errors are
 * NOT cached — they throw, and the caller's next run retries.
 */
export class UkGeocoder {
  requests = 0
  private cache: Record<string, GeoHit | null> | null = null
  private lastRequestAt = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly fetchImpl: typeof fetch,
    private readonly delayMs: number,
  ) {}

  /**
   * Query ladder, stopping at the first hit; every rung is one request and the
   * final verdict (hit or null) is cached, so a hard miss costs ≤4 requests ever:
   *   1. "<place>, <county>, <country>"
   *   2. for a two-part place "Moelfre, Oswestry": each part alone with the
   *      county — Nominatim misses the comma-heavy form even when it knows the
   *      anchoring town (verified live 2026-09-07: "Moelfre, Oswestry,
   *      Shropshire, England" → nothing; "Oswestry, Shropshire, England" → hit)
   *   3. "<place>, UK" — the county is the site's own tagging and is sometimes
   *      wrong (Hawick filed under North Yorkshire), so drop the hierarchy.
   */
  async lookup(place: string, county?: string, country?: string): Promise<GeoHit | null> {
    const key = `${norm(place)}|${norm(county ?? '')}`
    const cached = this.peek(key)
    if (cached !== undefined) return cached
    const parts = place.split(',').map((s) => s.trim()).filter(Boolean)
    const ladder: Array<Array<string | undefined>> = [[place, county, country ?? 'UK']]
    if (parts.length > 1) ladder.push([parts[0]!, county, country ?? 'UK'], [parts[parts.length - 1]!, county, country ?? 'UK'])
    ladder.push([place, 'UK'])
    const queries = [...new Set(ladder.map((q) => q.filter((s): s is string => !!s).join(', ')))]
    let hit: GeoHit | null = null
    for (const q of queries) {
      hit = await this.query(q)
      if (hit) break
    }
    this.store(key, hit)
    return hit
  }

  async lookupPostcode(postcode: string): Promise<GeoHit | null> {
    const key = `pc:${norm(postcode)}`
    const cached = this.peek(key)
    if (cached !== undefined) return cached
    const hit = await this.query(`${postcode.toUpperCase()}, UK`)
    this.store(key, hit)
    return hit
  }

  /** Cached value, or undefined when never looked up. */
  peek(key: string): GeoHit | null | undefined {
    this.load()
    return Object.prototype.hasOwnProperty.call(this.cache!, key) ? this.cache![key] : undefined
  }

  private async query(q: string): Promise<GeoHit | null> {
    // Serialise so concurrent callers still respect the one-request-per-second rule.
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.delayMs - Date.now()
      if (wait > 0) await sleep(wait)
      this.lastRequestAt = Date.now()
      this.requests++
      const url = `${NOMINATIM}?${new URLSearchParams({ q, format: 'jsonv2', limit: '1', countrycodes: 'gb' })}`
      const res = await this.fetchImpl(url, { headers: { 'user-agent': NOMINATIM_UA, accept: 'application/json' } })
      if (!res.ok) throw new Error(`nominatim: HTTP ${res.status}`)
      const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>
      const r = rows[0]
      if (!r?.lat || !r.lon) return null
      const lat = parseFloat(r.lat)
      const lon = parseFloat(r.lon)
      return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null
    })
    this.queue = run.catch(() => {})
    return run
  }

  private store(key: string, hit: GeoHit | null): void {
    this.load()
    this.cache![key] = hit
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cache), 'utf8')
    } catch {
      // A lost cache write only costs a repeat lookup next run.
    }
  }

  private load(): void {
    if (this.cache) return
    try {
      this.cache = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, GeoHit | null>) : {}
    } catch {
      this.cache = {}
    }
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}
