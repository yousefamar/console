// Meetup client facade — wraps the anonymous web GraphQL endpoint behind the
// same conservative rate limiter the geocaching scraper uses. The route layer
// and CLI talk only to this. All Meetup network access funnels through
// `limiter.schedule`, so the concurrency/delay/daily-budget rules can't be
// bypassed. Fetches are MANUAL only — we never background-poll Meetup.
//
// `eventSearch` is keyword-driven (an empty query returns nothing), but a
// wildcard term ("*") returns the full near-here list with venue coords inline,
// so "everything near here" = query "*" + paginate. A real keyword just filters.

import { join } from 'node:path'
import { RateLimiter } from '../geocaching/rate-limit.js'
import { MeetupEventStore } from './store.js'
import { eventFromNode, type MeetupEvent, type MeetupEventDetail, type MeetupEventType } from './types.js'

// Both confirmed to answer anonymously; gql2 is the site's own endpoint, the
// other is the public API gateway used as a transport fallback.
const GQL_PRIMARY = 'https://www.meetup.com/gql2'
const GQL_FALLBACK = 'https://api.meetup.com/gql-ext'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const PAGE_SIZE = 50
const DEFAULT_MAX_PAGES = 4

export class MeetupError extends Error {
  constructor(msg: string, public retryable = false) {
    super(msg)
    this.name = 'MeetupError'
  }
}

const EVENT_SEARCH = `query($f: EventSearchFilter!, $first: Int, $after: String) {
  eventSearch(filter: $f, first: $first, after: $after) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node {
      id title dateTime endTime eventUrl eventType isOnline
      going { totalCount }
      group { name urlname }
      venue { name address city lat lon }
    } }
  }
}`

const EVENT_DETAIL = `query($id: ID!) {
  event(id: $id) {
    id title dateTime endTime eventUrl eventType isOnline description
    going { totalCount }
    group { name urlname }
    venue { name address city lat lon }
  }
}`

interface EventSearchEdge {
  node: Record<string, unknown>
}
interface EventSearchConnection {
  totalCount?: number
  pageInfo?: { endCursor?: string | null; hasNextPage?: boolean }
  edges?: EventSearchEdge[]
}

export interface MeetupFetchOpts {
  lat: number
  lon: number
  radiusMiles?: number
  query?: string
  eventType?: MeetupEventType
  startDate?: string // ISO; default = now (upcoming only)
  endDate?: string // ISO
  categoryId?: string
  maxPages?: number
}

export interface MeetupFetchResult {
  added: number
  total: number
  budget: { used: number; cap: number; remaining: number }
}

export class MeetupClient {
  private limiter: RateLimiter
  readonly store: MeetupEventStore
  onChange?: (changed: MeetupEvent[]) => void
  private lastFetch = 0

  constructor(configDir: string) {
    this.limiter = new RateLimiter({
      budgetFile: join(configDir, 'meetup-budget.json'),
      minDelayMs: 1000,
      maxDelayMs: 2000,
      dailyCap: 800,
      label: 'Meetup request',
    })
    this.store = new MeetupEventStore(join(configDir, 'meetup-events.json'))
  }

  getStatus() {
    return {
      budget: this.limiter.budgetStatus(),
      eventCount: this.store.count(),
      lastFetch: this.lastFetch,
    }
  }

  private async gqlOnce<T>(endpoint: string, query: string, variables: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.limiter.schedule(() =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': UA,
            Origin: 'https://www.meetup.com',
          },
          body: JSON.stringify({ query, variables }),
        }),
      )
    } catch (err) {
      throw new MeetupError(`Meetup GraphQL unreachable (${endpoint}): ${(err as Error).message}`, true)
    }
    if (!res.ok) throw new MeetupError(`Meetup GraphQL HTTP ${res.status} (${endpoint})`, true)
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (body.errors?.length) throw new MeetupError(body.errors.map((e) => e.message).join('; '), false)
    if (!body.data) throw new MeetupError('Meetup GraphQL: empty response', true)
    return body.data
  }

  /** Run a query, retrying transport failures (not GraphQL errors) on the fallback endpoint. */
  private async gql<T>(query: string, variables: unknown): Promise<T> {
    try {
      return await this.gqlOnce<T>(GQL_PRIMARY, query, variables)
    } catch (err) {
      if (err instanceof MeetupError && err.retryable) {
        return await this.gqlOnce<T>(GQL_FALLBACK, query, variables)
      }
      throw err
    }
  }

  /** Search events near a point, paginate up to `maxPages`, upsert + broadcast. */
  async fetchArea(opts: MeetupFetchOpts): Promise<MeetupFetchResult> {
    const radius = clampRadius(opts.radiusMiles ?? 10)
    const maxPages = Math.min(Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES), 10)
    const filter: Record<string, unknown> = {
      query: opts.query?.trim() || '*',
      lat: opts.lat,
      lon: opts.lon,
      radius,
      startDateRange: opts.startDate ?? isoNow(),
    }
    if (opts.endDate) filter.endDateRange = opts.endDate
    if (opts.eventType) filter.eventType = opts.eventType
    if (opts.categoryId) filter.categoryId = opts.categoryId

    const collected: MeetupEvent[] = []
    const seen = new Set<string>()
    let after: string | null = null

    for (let page = 0; page < maxPages; page++) {
      const data = await this.gql<{ eventSearch: EventSearchConnection }>(EVENT_SEARCH, {
        f: filter,
        first: PAGE_SIZE,
        after,
      })
      const conn: EventSearchConnection = data.eventSearch ?? {}
      for (const edge of conn.edges ?? []) {
        const ev = eventFromNode(edge.node)
        if (ev.id && !seen.has(ev.id)) {
          seen.add(ev.id)
          collected.push(ev)
        }
      }
      const next: string | null = conn.pageInfo?.endCursor ?? null
      if (!conn.pageInfo?.hasNextPage || !next) break
      after = next
    }

    this.lastFetch = Date.now()
    this.store.prune(Date.now())
    const changed = this.store.upsert(collected)
    if (changed.length && this.onChange) this.onChange(changed)
    // Meetup's connection `totalCount` is unreliable for wildcard queries, so we
    // report the number actually pulled this fetch, not a claimed grand total.
    return { added: changed.length, total: collected.length, budget: this.limiter.budgetStatus() }
  }

  /** Lazy full detail (long description) for one event; cached into the store. */
  async getEventDetail(id: string): Promise<MeetupEvent | undefined> {
    const existing = this.store.get(id)
    if (existing?.detail) return existing

    const data = await this.gql<{ event: Record<string, unknown> | null }>(EVENT_DETAIL, { id })
    if (!data.event) return existing

    // Seed a summary if the event was requested directly (no prior area fetch).
    if (!existing) this.store.upsert([eventFromNode(data.event)])

    const detail: MeetupEventDetail = {
      description: typeof data.event.description === 'string' ? data.event.description : '',
      fetchedAt: Date.now(),
    }
    return this.store.setDetail(id, detail) ?? (existing ? { ...existing, detail } : undefined)
  }

  getSnapshot() {
    return this.store.getSnapshot()
  }
}

function isoNow(): string {
  return new Date().toISOString()
}

/** Meetup's radius is in miles and effectively caps around 100. */
function clampRadius(miles: number): number {
  if (!Number.isFinite(miles)) return 10
  return Math.min(100, Math.max(1, miles))
}
