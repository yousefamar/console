// subito.it client (Italy — the classifieds / private-seller channel). Protocol notes:
// ~/sync/brain/root/projects/home/subito-api.md
//
// Why a fourth Italian source: ~15% of its houses aren't on immobiliare, and its
// "Terreni e rustici" category (c=30) is the only place rural private sellers
// list — ~50% FSBO there vs ~6% for houses. So one client feeds two layers:
// the house search (c=29, plus c=7 for flats) and, when `farmhouse` is among the
// requested subtypes, the smallholding pull (c=30 filtered to rustico-like
// listings, with bare land dropped locally — see `isBareLand`).
//
// Shape of the portal: one mandatory header (`x-subito-channel: web` — without
// it every call is an Akamai 403 that looks like an IP ban), radius search only
// (`lat`/`lon`/`rad` metres, ≤100 km), 100 rows a page with no depth cap, real
// ISO timestamps, and a `list_ids=` lookup that doubles as the liveness probe.
// Coordinates are COMUNE CENTROIDS, never the house — every row is flagged
// `coordsPrecision: 'area'` so the hub clips with a buffer and never dedupes
// them against exact-coordinate portals.

import type { Ring } from './geo.js'
import { coverRingWithCircles } from './geo.js'
import type { Criteria, Listing, PortalClient, SearchResult } from './types.js'

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const BASE = 'https://hades.subito.it/v1/search/items'
/** The whole Akamai gate. Verified 2026-09-07: with it 200 (any UA, no cookies); without it 403. */
const CHANNEL_HEADER = 'x-subito-channel'
/** `lim` silently clamps to 100. */
const PAGE = 100
/** `rad` is honoured up to 100 km (1,204 rows at 100 km around Pisa, no cap hit). */
const MAX_RADIUS_KM = 100
/** The note asks for ≥1.5 s between calls; applied between every two requests, not just deep pulls. */
const DEFAULT_REQUEST_GAP_MS = 1500
/** The hub regexes the body for terreno/ettari, so keep most of it (bodies run 500–2,000 chars). */
const SUMMARY_CHARS = 1500
/** Subito counts *locali* (all rooms incl. living room): a trilocale is a 2-bed. */
const ROOM_OFFSET = 1
/**
 * In c=30 the `/size` feature is the LAND for bare terreni but the BUILDING for
 * rustici (66–450 m² seen live). A rustico-typed row whose size is at or above
 * this can only be a seller who put the plot in the size box (a ≤€300k rustico
 * is not a 1,000 m² building), so it's read as plot area instead.
 */
const LAND_SIZE_M2 = 1000
/** Thumbnail rule that actually serves (the bare `cdn_base_url` is a 400). 351×466 jpeg. */
const IMAGE_RULE = 'gallery-desktop-1x-auto'

const CATEGORY = {
  /** Ville singole e a schiera — detached AND terraced houses; no typology filter inside it. */
  houses: '29',
  /** Appartamenti. */
  flats: '7',
  /** Terreni e rustici — bare land, rustici, casali, sheds, all mixed. */
  landAndRustici: '30',
} as const

/**
 * The farmland recipe from the api note: `c=30` is mostly bare land, so narrow
 * it with the rustico-like terms. `q=a OR b` is a real union (verified live:
 * rustico 29 + cascina 6 → 34; `|` is a literal and returns 0). "cascina" also
 * matches the comune of Cascina (PI) — that noise is bare land and falls to
 * `isBareLand`.
 */
export const FARM_QUERY = ['rustico', 'casale', 'podere', 'cascina', 'colonica'].join(' OR ')

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface SubitoClientOptions {
  /** Pause between consecutive requests. Tests set 0. */
  requestGapMs?: number
}

export class SubitoClient implements PortalClient {
  readonly portal = 'subito' as const
  readonly currency = 'EUR'
  private readonly gapMs: number
  private lastRequestAt = 0

  constructor(private readonly fetchImpl: typeof fetch = fetch, opts: SubitoClientOptions = {}) {
    this.gapMs = opts.requestGapMs ?? DEFAULT_REQUEST_GAP_MS
  }

  /**
   * Sum of `count_all` over every (circle × category) query. Circles overlap
   * and c=30 counts the bare land we drop, so this over-reports — it's a
   * cheap order-of-magnitude probe, same as immobiliare's per-ring sum.
   */
  async count(rings: Ring[], criteria: Criteria): Promise<number> {
    let total = 0
    for (const ring of rings) {
      for (const circle of coverRingWithCircles(ring, MAX_RADIUS_KM)) {
        for (const q of plan(criteria)) {
          const d = (await this.get({ ...q, ...circleParams(circle), lim: '1', start: '0' })) as RawResponse
          total += d.count_all ?? 0
        }
      }
    }
    return total
  }

  /**
   * Newest-first over every circle covering every ring, for every category
   * the criteria call for. `limit` caps rows pulled PER QUERY (circle ×
   * category), as on the other clients; `Infinity` walks each query to the end.
   * Rows are deduped by list id across overlapping circles (first seen wins —
   * identical row either way).
   */
  async newest(rings: Ring[], criteria: Criteria, limit: number): Promise<SearchResult> {
    const seen = new Map<string, Listing>()
    let total = 0
    let truncated = false
    const queries = plan(criteria)

    for (const ring of rings) {
      for (const circle of coverRingWithCircles(ring, MAX_RADIUS_KM)) {
        for (const q of queries) {
          let start = 0
          let pulled = 0
          for (;;) {
            const lim = Math.min(PAGE, limit - pulled)
            if (lim <= 0) break
            const d = (await this.get({ ...q, ...circleParams(circle), sort: 'datedesc', lim: String(lim), start: String(start) })) as RawResponse
            const countAll = d.count_all ?? 0
            if (start === 0) total += countAll
            const rows = d.ads ?? []
            for (const r of rows) {
              const l = normalise(r)
              if (l && !seen.has(l.id)) seen.set(l.id, l)
            }
            pulled += rows.length
            // `start` in the response is the NEXT offset; fall back to arithmetic if absent.
            start = d.start ?? start + rows.length
            if (rows.length === 0 || start >= countAll) break
            if (pulled >= limit) {
              truncated = true
              break
            }
          }
        }
      }
    }

    return { portal: this.portal, total, listings: [...seen.values()], truncated, unsupported: unsupportedFor(criteria) }
  }

  /**
   * `list_ids=<id>` returns only ids still live (verified: a fabricated id is
   * silently dropped), so one call answers "still there?". Any HTTP/network
   * failure → "don't know".
   */
  async isLive(listing: Listing): Promise<boolean | null> {
    try {
      const d = (await this.get({ list_ids: listing.id, lim: '10' })) as RawResponse
      return (d.ads ?? []).some((a) => listIdOf(a.urn) === listing.id)
    } catch {
      return null
    }
  }

  private async get(params: Record<string, string>): Promise<unknown> {
    const url = `${BASE}?${new URLSearchParams(params)}`
    for (let attempt = 1; ; attempt++) {
      await this.throttle()
      const res = await this.fetchImpl(url, {
        headers: { [CHANNEL_HEADER]: 'web', 'user-agent': UA, accept: 'application/json' },
      })
      if (res.ok) return res.json()
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(2000 * attempt)
        continue
      }
      if (res.status === 403) throw new Error(`subito: HTTP 403 — Akamai block (is the ${CHANNEL_HEADER} header still the gate?)`)
      // Unknown params are a 400 `SEARCH:invalid-param-<name>` — the body names the culprit.
      const body = res.status === 400 ? ` ${(await res.text().catch(() => '')).slice(0, 200)}` : ''
      throw new Error(`subito: HTTP ${res.status}${body}`)
    }
  }

  private async throttle(): Promise<void> {
    if (this.gapMs <= 0) return
    const wait = this.lastRequestAt + this.gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastRequestAt = Date.now()
  }
}

function circleParams(c: { lat: number; lon: number; radiusKm: number }): Record<string, string> {
  return {
    lat: c.lat.toFixed(6),
    lon: c.lon.toFixed(6),
    rad: String(Math.round(Math.min(c.radiusKm, MAX_RADIUS_KM) * 1000)),
  }
}

/**
 * Which category queries the criteria need, each with its own compiled params.
 * Houses → c=29 (Subito lumps detached and terraced together; no typology
 * filter exists inside it, so `houseSubtypes` is always post-filtered).
 * Flats → c=7. `any` → both. `farmhouse` among the subtypes adds the c=30
 * farmland pull.
 */
export function plan(c: Criteria): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  const type = c.propertyType ?? 'house'
  if (type === 'house' || type === 'any') out.push(compile(c, CATEGORY.houses))
  if (type === 'flat' || type === 'any') out.push(compile(c, CATEGORY.flats))
  if (wantsFarmland(c)) out.push(compile(c, CATEGORY.landAndRustici))
  return out
}

function wantsFarmland(c: Criteria): boolean {
  return (c.propertyType ?? 'house') !== 'flat' && !!c.houseSubtypes?.includes('farmhouse')
}

/**
 * Criteria → Subito params for one category. Unknown NAMES fail loudly (400
 * `SEARCH:invalid-param-x`) but a valid name with a bad VALUE fails open
 * (`grd=1` matched nothing), so only emit what was verified live.
 *
 * c=30 rows carry only `/price`, `/size`, `/nosalesman`: rooms, bathrooms,
 * garden and size filters there match NOTHING (`rs=1` → 0 rows, verified), and
 * `/size` means land as often as floor. So the residential filters are only
 * compiled for the house/flat categories; `unsupportedFor` reports them when
 * the c=30 branch ran.
 */
export function compile(c: Criteria, category: string): Record<string, string> {
  const p: Record<string, string> = {
    c: category,
    t: c.channel === 'rent' ? 'u' : 's',
  }
  if (c.minPrice != null) p.ps = String(c.minPrice)
  if (c.maxPrice != null) p.pe = String(c.maxPrice)
  if (category === CATEGORY.landAndRustici) {
    p.q = FARM_QUERY
    return p
  }
  // `rs`/`re` are locali (all rooms), so a 2-bed is a 3-locali house.
  if (c.minBedrooms != null) p.rs = String(c.minBedrooms + ROOM_OFFSET)
  if (c.maxBedrooms != null) p.re = String(c.maxBedrooms + ROOM_OFFSET)
  if (c.minBathrooms != null) p.btrs = String(c.minBathrooms)
  if (c.minFloorArea != null) p.szs = String(c.minFloorArea)
  if (c.maxFloorArea != null) p.sze = String(c.maxFloorArea)
  // Literal `true` — `grd=1` is accepted and matches nothing.
  if (c.mustHaveGarden) p.grd = 'true'
  // Any-of, matching the hub's own keyword post-filter semantics.
  if (c.keywords?.length) p.q = c.keywords.join(' OR ')
  return p
}

/** Everything the caller must enforce locally (see `postFilter` in sync.ts). */
export function unsupportedFor(c: Criteria): string[] {
  const u: string[] = []
  // No typology filter inside c=29 (detached + a schiera share the category).
  if (c.houseSubtypes?.length) u.push('houseSubtypes')
  // No auction / nuda-proprietà / scheme flags — all regexed on the body by the hub.
  if (c.excludeAuctions) u.push('excludeAuctions')
  if (c.excludeSchemes) u.push('excludeSchemes')
  if (c.freeholdOnly) u.push('freeholdOnly')
  if (c.excludeCommonhold) u.push('excludeCommonhold')
  if (c.excludePriceOnRequest) u.push('excludePriceOnRequest')
  // `szs`/`sze` is floor area in c=29 and ambiguous in c=30 — never a plot filter.
  if (c.minPlotArea != null) u.push('minPlotArea')
  if (c.maxPlotArea != null) u.push('maxPlotArea')
  if (c.minYearBuilt != null) u.push('minYearBuilt')
  if (c.maxYearBuilt != null) u.push('maxYearBuilt')
  if (c.minInternetMbit != null) u.push('minInternetMbit')
  if (c.excludeNewBuild) u.push('excludeNewBuild')
  if (c.noBuyerFee) u.push('noBuyerFee')
  if (c.maxDaysSinceAdded != null) u.push('maxDaysSinceAdded')
  // `prk` takes ids from /v1/values/parkings/types — unverified, so not sent.
  if (c.mustHaveParking) u.push('mustHaveParking')
  // Applied to the house/flat categories but NOT to the c=30 pull (see compile).
  if (wantsFarmland(c)) {
    if (c.minBedrooms != null) u.push('minBedrooms')
    if (c.maxBedrooms != null) u.push('maxBedrooms')
    if (c.minBathrooms != null) u.push('minBathrooms')
    if (c.minFloorArea != null) u.push('minFloorArea')
    if (c.maxFloorArea != null) u.push('maxFloorArea')
    if (c.mustHaveGarden) u.push('mustHaveGarden')
    if (c.keywords?.length) u.push('keywords')
  }
  return u
}

// ---------------------------------------------------------------------------
// Rows → Listing

export interface RawResponse {
  count_all?: number
  lines?: number
  /** NEXT offset, not the one requested. */
  start?: number
  ads?: RawAd[]
}

export interface RawAd {
  /** `id:ad:<internal>:list:<public>` */
  urn?: string
  subject?: string
  body?: string
  category?: { key?: string; value?: string; friendly_name?: string }
  dates?: { display_iso8601?: string }
  images?: Array<{ cdn_base_url?: string }>
  features?: Array<{ uri?: string; values?: Array<{ key?: string; value?: string }> }>
  advertiser?: { name?: string; company?: boolean; type?: number; shop_name?: string }
  geo?: {
    town?: { value?: string; lat?: number; lon?: number }
    city?: { value?: string }
    map?: { address?: string; latitude?: string; longitude?: string }
  }
  urls?: { default?: string }
}

/**
 * The public list id — the `N` in `id:ad:…:list:N`, which is also the id in
 * the listing URL and what `list_ids=` accepts. The `ad:` id is internal and
 * never appears anywhere user-facing, so the list id is the stable key.
 */
export function listIdOf(urn: string | undefined): string | undefined {
  const m = /:list:(\d+)/.exec(urn ?? '')
  return m?.[1]
}

/**
 * Bare-land typologies. A row whose subject leads with one of these is a
 * terreno unless the text also mentions a building (see `isBareLand`).
 * No `bosco`: "Boschi di Lari" is a place name and turns up in house ads.
 */
const LAND_RE = /\b(terren[oi](?:\s+(?:agricol[oi]|edificabil[ei]|residenzial[ei]|industrial[ei]|boschiv[oi]|coltivabil[ei]|seminativ[oi]))?|lott[oi](?:\s+edificabil[ei])?|appezzament[oi]|[ou]livet[oi]|vignet[oi]|frutteto|pascol[oi]|seminativ[oi]|area\s+edificabile)\b/i

/**
 * Dwelling typologies, most specific first (alternation is left-to-right at a
 * given position, so "casa indipendente" must precede "casa"). Leftmost match
 * wins on the subject — agency feeds lead with the type ("Rustico / Casale di
 * 370 m²", "Casa indipendente di 115 m² con 4 locali"). On the body this list
 * is tried BEFORE `LAND_RE` so "immerso in un terreno di 3000 mq, il casale…"
 * stays a casale.
 */
const HOUSE_RE = /\b(casa\s+colonica|colonica|casale|rustic[oi]|podere|cascina|casolare|rudere|masseria|baita|chalet|agriturismo|villa\s+singola|villa\s+bifamiliare|villa\s+a\s+schiera|villetta\s+a\s+schiera|casa\s+a\s+schiera|villetta|villino|villa|casa\s+indipendente|casa\s+semi-?i?ndipendente|casa\s+singola|casa\s+padronale|porzione\s+di\s+(?:casa|bifamiliare|colonica|casale)|porzione\s+cielo[- ]terra|cielo[- ]terra|casa|abitazione(?:\s+indipendente)?|terratetto|bifamiliare|trifamiliare|quadrifamiliare|unifamiliare|monolocale|bilocale|trilocale|quadrilocale|plurilocale|appartamento|attico|mansarda|loft|palazzina|palazzo)\b/i

/**
 * Non-dwelling structures. Count as "a building on the land" for the bare-land
 * test, and as the typology only when the SUBJECT LEADS with one ("Rimessaggio
 * con terreno", "Capannone con terreno") — never as a body fallback and never
 * mid-subject, or "Immobile in asta … con 5 locali e box auto" is a garage.
 */
const OUTBUILDING_RE = /\b(fabbricat[oi](?:\s+rural[ei])?|anness[oi](?:\s+agricol[oi])?|fienile|stalla|capannone|rimessaggio|magazzino|deposito|garage|box\s+auto)\b/i

interface Typology {
  text: string
  land: boolean
}

/**
 * Subject first — leftmost of dwelling vs land ("Casa con terreno" is a casa,
 * "Terreno con rustico" a terreno), else an outbuilding the subject leads with.
 * Then the body: dwellings before land, outbuildings never.
 */
export function typologyOf(subject: string | undefined, body: string | undefined): Typology | undefined {
  const s = subject ?? ''
  const sh = HOUSE_RE.exec(s)
  const sl = LAND_RE.exec(s)
  if (sh && (!sl || sh.index <= sl.index)) return { text: tidy(sh[0]), land: false }
  if (sl) return { text: tidy(sl[0]), land: true }
  const so = OUTBUILDING_RE.exec(s)
  if (so && s.slice(0, so.index).trim() === '') return { text: tidy(so[0]), land: false }
  const b = body ?? ''
  const bh = HOUSE_RE.exec(b)
  if (bh) return { text: tidy(bh[0]), land: false }
  const bl = LAND_RE.exec(b)
  if (bl) return { text: tidy(bl[0]), land: true }
  return undefined
}

function tidy(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim().toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** First dwelling, else first outbuilding, named anywhere in the ad's text. */
function buildingMentioned(r: RawAd): string | undefined {
  const hay = `${r.subject ?? ''} ${r.body ?? ''}`
  return (HOUSE_RE.exec(hay) ?? OUTBUILDING_RE.exec(hay))?.[0]
}

/**
 * The terreno-vs-rustico rule (api note, "Farmland / smallholding layer"):
 * a row is bare land — and dropped — when its typology is a land term AND
 * neither subject nor body names any building. "Terreno con rustico da
 * ristrutturare" is kept (as `Terreno agricolo con rustico`, so the hub's type
 * vocabulary sees both `land` and `farmhouse`); "Terreno agricolo uso oliveto"
 * with no building is dropped. Fail-open: a row with no typology at all is kept.
 */
export function isBareLand(r: RawAd): boolean {
  const t = typologyOf(r.subject, r.body)
  if (!t?.land) return false
  return buildingMentioned(r) === undefined
}

function feature(r: RawAd, uri: string): string | undefined {
  return r.features?.find((f) => f.uri === uri)?.values?.[0]?.key
}

export function normalise(r: RawAd): Listing | null {
  const id = listIdOf(r.urn)
  if (!id) return null
  if (isBareLand(r)) return null

  const category = r.category?.key
  const typ = typologyOf(r.subject, r.body)
  const size = parseNum(feature(r, '/size'))
  const locali = parseNum(feature(r, '/room'))
  const body = (r.body ?? '').replace(/\s+/g, ' ').trim()

  // `/size` semantics: floor area in the residential categories; in c=30 it's
  // the land for terreno-typed rows and for anything implausibly large, else
  // the rustico's building. Plot sizes buried in a rustico's body are left to
  // the hub's own terreno/ettari regex over `summary`.
  let floorArea: number | undefined
  let plotArea: number | undefined
  if (size != null) {
    if (category === CATEGORY.landAndRustici && (typ?.land || size >= LAND_SIZE_M2)) plotArea = size
    else floorArea = size
  }

  let propertyType = typ?.text
  if (typ?.land) {
    // Only reachable when the text also names a building (else isBareLand dropped it).
    const building = buildingMentioned(r)
    if (building) propertyType = `${typ.text} con ${building.toLowerCase()}`
  } else if (!propertyType && category === CATEGORY.flats) {
    propertyType = 'Appartamento'
  }

  const adv = r.advertiser
  const agency = adv?.company === true || adv?.type === 1
  const town = r.geo?.town
  const lat = town?.lat ?? parseFloat(r.geo?.map?.latitude ?? '')
  const lon = town?.lon ?? parseFloat(r.geo?.map?.longitude ?? '')
  const listedAt = r.dates?.display_iso8601 ? new Date(r.dates.display_iso8601) : undefined
  const image = r.images?.[0]?.cdn_base_url

  return {
    portal: 'subito',
    id,
    url: r.urls?.default ?? `https://www.subito.it/${r.category?.friendly_name ?? 'annunci'}/${id}.htm`,
    title: r.subject,
    address: r.geo?.map?.address ?? ([town?.value, r.geo?.city?.value].filter(Boolean).join(', ') || undefined),
    // Absent = prezzo su richiesta (3/30 in c=30).
    price: parseNum(feature(r, '/price')),
    currency: 'EUR',
    bedrooms: locali != null ? Math.max(0, locali - ROOM_OFFSET) : undefined,
    bathrooms: parseNum(feature(r, '/bathrooms')),
    floorArea,
    plotArea,
    propertyType,
    lat: Number.isFinite(lat) ? lat : undefined,
    lon: Number.isFinite(lon) ? lon : undefined,
    // Comune centroid, never the house — every sampled ad has showPin:false.
    coordsPrecision: 'area',
    // Normalised to UTC: the hub sorts listedAt as strings, and Subito's
    // offsets flip between +0200 and +0100 across the year.
    listedAt: listedAt && !Number.isNaN(listedAt.getTime()) ? listedAt.toISOString() : undefined,
    summary: body ? body.slice(0, SUMMARY_CHARS) : undefined,
    // Private sellers stay anonymous: their `name` is a person, not a brand.
    agent: agency ? adv?.shop_name ?? adv?.name : 'privato',
    image: image ? `${image}?rule=${IMAGE_RULE}` : undefined,
  }
}

function parseNum(v: string | undefined): number | undefined {
  if (!v) return undefined
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10)
  return Number.isFinite(n) ? n : undefined
}
