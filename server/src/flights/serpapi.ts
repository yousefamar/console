// SerpApi wrapper for flight data.
//
// Two engines used:
//   • google_travel_explore — open-ended "anywhere from X" discovery.
//     Returns one entry per destination with a pre-computed best price for
//     the requested month + trip duration.
//   • google_flights — point-to-point with specific dates. Returns
//     bookable-style price candidates with stops, airline, etc.
//
// Docs: https://serpapi.com/google-travel-explore-api
//       https://serpapi.com/google-flights-api

import type { AuthStore } from '../auth-store.js'

const SERPAPI_BASE = 'https://serpapi.com/search.json'

// UK-centric defaults — gl=uk, hl=en, currency=GBP
const DEFAULT_GL = 'uk'
const DEFAULT_HL = 'en'
const DEFAULT_CURRENCY = 'GBP'

// kgmid region IDs (from SerpApi docs)
export const REGION_KGMID = {
  europe: '/m/02j9z',
  africa: '/m/0dbdy',
  asia: '/m/0j0k',
  oceania: '/m/0440zs',
  northAmerica: '/m/059g4',
  southAmerica: '/m/015fr',
} as const

export type RegionKey = keyof typeof REGION_KGMID

export type TripDuration = 'Weekend' | '1 week' | '2 weeks'

// SerpApi expects travel_duration as a numeric code, not the docs' label.
// Verified empirically against the engine:
//   1 → Weekend (~3 nights)   2 → 1 week (~6-7 nights)   3 → 2 weeks (~13 nights)
const DURATION_CODE: Record<TripDuration, string> = {
  'Weekend': '1',
  '1 week': '2',
  '2 weeks': '3',
}

// --------------------------------------------------------------------------
// Explore (anywhere / month-view)
// --------------------------------------------------------------------------

export interface ExploreQuery {
  /** Origin airport code (e.g. "LHR") or kgmid */
  departureId: string
  /** Specific destination — omit for "anywhere" */
  arrivalId?: string
  /** Region (Europe, Asia, etc) — used instead of arrivalId for area search */
  region?: RegionKey
  /** Custom kgmid for area search (overrides region) */
  arrivalAreaId?: string
  /** Weekend / 1 week / 2 weeks. Default: '1 week' */
  duration?: TripDuration
  /** Month 1-12, or 0 for next six months. Default: 0 */
  month?: number
  /** ISO currency. Default: GBP */
  currency?: string
  gl?: string
  hl?: string
}

export interface ExploreDestination {
  /** Destination display name (city) */
  name: string
  /** Country if SerpApi returned one */
  country?: string
  /** kgmid for further drill-down (SerpApi calls this destination_id) */
  kgmid?: string
  /** Destination airport IATA code */
  airport?: string
  /** Lowest price found in the window, in `currency` major units (e.g. £349.00) */
  priceMajor: number
  /** ISO start date of best window (YYYY-MM-DD) */
  startDate: string
  /** ISO end date of best window */
  endDate: string
  /** Currency code, mirrors the query */
  currency: string
  /** Direct? — derived from number_of_stops when present */
  nonstop?: boolean
  /** Google Flights deep link for this destination + dates */
  link?: string
  /** Raw destination payload (kept for callers that want extras) */
  raw?: unknown
}

export interface ExploreResult {
  query: ExploreQuery
  destinations: ExploreDestination[]
  /** Raw SerpApi response for debugging */
  raw: unknown
}

// --------------------------------------------------------------------------
// Search (point-to-point)
// --------------------------------------------------------------------------

export interface SearchQuery {
  departureId: string
  arrivalId: string
  /** YYYY-MM-DD */
  outboundDate: string
  /** YYYY-MM-DD — omit for one-way */
  returnDate?: string
  /** 1=economy 2=premium economy 3=business 4=first. Default 1. */
  travelClass?: 1 | 2 | 3 | 4
  adults?: number
  children?: number
  infantsInSeat?: number
  infantsOnLap?: number
  /** ISO currency. Default GBP */
  currency?: string
  gl?: string
  hl?: string
}

export interface SearchFlight {
  /** Price in major units (e.g. 349.50 means £349.50) */
  priceMajor: number
  currency: string
  /** Total trip duration in minutes (outbound + return) */
  totalDurationMin: number
  /** Number of stops (0 = direct) */
  stops: number
  /** Operating airlines, deduped */
  airlines: string[]
  /** Outbound segments — airport codes joined: "LHR → CDG → JFK" */
  outboundRoute: string
  /** Return segments if round-trip */
  returnRoute?: string
  /** Local-time departure of the first segment, "YYYY-MM-DD HH:MM" */
  departureTime?: string
  /** Local-time arrival of the last segment */
  arrivalTime?: string
  /** Operating flight numbers for each segment, e.g. ["BA442"] */
  flightNumbers?: string[]
  /** Per-segment detail for callers that want to render layovers */
  segments?: SearchSegment[]
  /** Raw flight payload */
  raw: unknown
}

export interface SearchSegment {
  from: string
  to: string
  departureTime?: string
  arrivalTime?: string
  airline?: string
  flightNumber?: string
  durationMin?: number
}

export interface SearchResult {
  query: SearchQuery
  best: SearchFlight[]
  other: SearchFlight[]
  /** SerpApi's price_insights block (lowest/typical/high) if present */
  priceInsights?: unknown
  raw: unknown
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export class SerpApiClient {
  constructor(private readonly auth: AuthStore) {}

  isConfigured(): boolean {
    return !!this.auth.getSerpApiKey()
  }

  /**
   * Remaining searches this month, via the FREE /account endpoint (it does not
   * consume a search). Returns null if not configured or the check failed —
   * callers treat null as "unknown, proceed". The poller uses this to skip
   * polling when exhausted, so a dead quota never fires search requests (and
   * never triggers SerpApi's "you're out of searches" emails).
   */
  async searchesLeft(): Promise<number | null> {
    const key = this.auth.getSerpApiKey()
    if (!key) return null
    try {
      const res = await fetch(`https://serpapi.com/account?api_key=${encodeURIComponent(key)}`)
      if (!res.ok) return null
      const data = await res.json() as { total_searches_left?: number }
      return typeof data.total_searches_left === 'number' ? data.total_searches_left : null
    } catch {
      return null
    }
  }

  async explore(q: ExploreQuery): Promise<ExploreResult> {
    const apiKey = this.requireKey()
    const params: Record<string, string> = {
      engine: 'google_travel_explore',
      api_key: apiKey,
      departure_id: q.departureId,
      gl: q.gl ?? DEFAULT_GL,
      hl: q.hl ?? DEFAULT_HL,
      currency: q.currency ?? DEFAULT_CURRENCY,
      travel_duration: DURATION_CODE[q.duration ?? '1 week'],
      month: String(q.month ?? 0),
    }
    if (q.arrivalId) params.arrival_id = q.arrivalId
    if (q.arrivalAreaId) params.arrival_area_id = q.arrivalAreaId
    else if (q.region) params.arrival_area_id = REGION_KGMID[q.region]

    const raw = await this.fetch(params)
    const destinations = normaliseExplore(raw, params.currency!)
    return { query: q, destinations, raw }
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const apiKey = this.requireKey()
    const params: Record<string, string> = {
      engine: 'google_flights',
      api_key: apiKey,
      departure_id: q.departureId,
      arrival_id: q.arrivalId,
      outbound_date: q.outboundDate,
      gl: q.gl ?? DEFAULT_GL,
      hl: q.hl ?? DEFAULT_HL,
      currency: q.currency ?? DEFAULT_CURRENCY,
      type: q.returnDate ? '1' : '2',
      travel_class: String(q.travelClass ?? 1),
      adults: String(q.adults ?? 1),
    }
    if (q.returnDate) params.return_date = q.returnDate
    if (q.children) params.children = String(q.children)
    if (q.infantsInSeat) params.infants_in_seat = String(q.infantsInSeat)
    if (q.infantsOnLap) params.infants_on_lap = String(q.infantsOnLap)

    const raw = await this.fetch(params)
    return normaliseSearch(q, raw, params.currency!)
  }

  private requireKey(): string {
    const k = this.auth.getSerpApiKey()
    if (!k) throw apiError(412, 'SerpApi key not configured. POST /flights/credentials with {apiKey}')
    return k
  }

  private async fetch(params: Record<string, string>): Promise<any> {
    const url = `${SERPAPI_BASE}?${new URLSearchParams(params).toString()}`
    const res = await fetch(url)
    const text = await res.text()
    if (!res.ok) {
      throw apiError(res.status, `SerpApi ${params.engine} failed: ${res.status} ${text.slice(0, 300)}`)
    }
    let data: any
    try { data = JSON.parse(text) } catch {
      throw apiError(502, `SerpApi returned non-JSON: ${text.slice(0, 300)}`)
    }
    if (data.error) {
      throw apiError(502, `SerpApi error: ${data.error}`)
    }
    return data
  }
}

// --------------------------------------------------------------------------
// Normalisers (shape SerpApi → our stable types)
// --------------------------------------------------------------------------

function normaliseExplore(raw: any, currency: string): ExploreDestination[] {
  // Travel Explore's actual response (verified live): flat objects under
  // `best_flights` with `destination_id`, top-level `name`/`country`,
  // `destination_airport.code`, `flight_price`, `start_date`, `end_date`,
  // `number_of_stops`, and a Google `link`.
  const list: any[] = raw?.best_flights ?? raw?.destinations ?? raw?.results ?? []
  const out: ExploreDestination[] = []
  for (const item of list) {
    const price = item.flight_price ?? item.price
    const start = item.start_date ?? item.outbound_date
    const end = item.end_date ?? item.return_date
    if (typeof price !== 'number' || !start || !end) continue
    const stops = item.number_of_stops
    out.push({
      name: item.name ?? item.title ?? String(item.destination_id ?? item.kgmid ?? 'unknown'),
      country: item.country,
      kgmid: item.destination_id ?? item.kgmid,
      airport: item.destination_airport?.code,
      priceMajor: price,
      startDate: String(start),
      endDate: String(end),
      currency,
      nonstop: typeof stops === 'number' ? stops === 0 : undefined,
      link: item.link,
      raw: item,
    })
  }
  // Cheapest first
  out.sort((a, b) => a.priceMajor - b.priceMajor)
  return out
}

function normaliseSearch(q: SearchQuery, raw: any, currency: string): SearchResult {
  const best = (raw?.best_flights ?? []).map((f: any) => normaliseFlight(f, currency))
  const other = (raw?.other_flights ?? []).map((f: any) => normaliseFlight(f, currency))
  return {
    query: q,
    best: best.sort((a: SearchFlight, b: SearchFlight) => a.priceMajor - b.priceMajor),
    other: other.sort((a: SearchFlight, b: SearchFlight) => a.priceMajor - b.priceMajor),
    priceInsights: raw?.price_insights,
    raw,
  }
}

function normaliseFlight(f: any, currency: string): SearchFlight {
  const segs: any[] = f.flights ?? []
  const airlines = new Set<string>()
  const flightNumbers: string[] = []
  const segments: SearchSegment[] = []
  for (const s of segs) {
    if (s.airline) airlines.add(s.airline)
    if (s.flight_number) flightNumbers.push(String(s.flight_number).replace(/\s+/g, ''))
    segments.push({
      from: s.departure_airport?.id ?? '?',
      to: s.arrival_airport?.id ?? '?',
      departureTime: s.departure_airport?.time,
      arrivalTime: s.arrival_airport?.time,
      airline: s.airline,
      flightNumber: s.flight_number,
      durationMin: typeof s.duration === 'number' ? s.duration : undefined,
    })
  }
  const outboundRoute = segs.length
    ? segs.map((s, i) => i === 0 ? `${s.departure_airport?.id ?? '?'} → ${s.arrival_airport?.id ?? '?'}` : `→ ${s.arrival_airport?.id ?? '?'}`).join(' ')
    : ''
  return {
    priceMajor: typeof f.price === 'number' ? f.price : 0,
    currency,
    totalDurationMin: f.total_duration ?? 0,
    stops: Math.max(0, segs.length - 1),
    airlines: Array.from(airlines),
    outboundRoute,
    departureTime: segments[0]?.departureTime,
    arrivalTime: segments[segments.length - 1]?.arrivalTime,
    flightNumbers: flightNumbers.length ? flightNumbers : undefined,
    segments: segments.length ? segments : undefined,
    raw: f,
  }
}

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

interface ApiError extends Error { status: number }
function apiError(status: number, message: string): ApiError {
  const err = new Error(message) as ApiError
  err.status = status
  return err
}
