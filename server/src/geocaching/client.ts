// Geocaching.com client facade — ties together the session (auth), the rate
// limiter (safety), and the store (persistence). The route layer and CLI talk
// only to this. All gc.com network access funnels through `limiter.schedule`,
// so the conservative concurrency/delay/budget rules can't be bypassed.

import { join } from 'node:path'
import type { AuthStore } from '../auth-store.js'
import { GeocachingSession } from './session.js'
import { RateLimiter } from './rate-limit.js'
import { GeocacheStore } from './store.js'
import { parseSearchResults, parseCacheDetail, parseLogbook } from './parse.js'
import type { BBox, Geocache, GeocacheDetail, GeocacheLog } from './types.js'

export class GeocachingAuthError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'GeocachingAuthError'
  }
}

const SEARCH_PAGE = 200 // gc.com search/v2 max take
const DEFAULT_MAX = 1000 // per-fetch cache cap (safety)

export interface FetchAreaResult {
  added: number
  total: number
  budget: { used: number; cap: number; remaining: number }
}

export class GeocachingClient {
  private session: GeocachingSession
  private limiter: RateLimiter
  readonly store: GeocacheStore
  onChange?: (changed: Geocache[]) => void

  constructor(private authStore: AuthStore, configDir: string) {
    this.session = new GeocachingSession(join(configDir, 'geocaching-session.json'))
    this.limiter = new RateLimiter({ budgetFile: join(configDir, 'geocaching-budget.json') })
    this.store = new GeocacheStore(join(configDir, 'geocaches.json'))
  }

  getStatus() {
    return {
      loggedIn: this.session.isLoggedIn(),
      username: this.session.username,
      hasCredentials: !!this.authStore.getGeocachingCreds(),
      budget: this.limiter.budgetStatus(),
      cacheCount: this.store.count(),
    }
  }

  /** Persist credentials and log in immediately so we surface auth errors now. */
  async setCredentials(creds: { username?: string; password?: string; cookie?: string }) {
    this.authStore.setGeocachingCreds(creds)
    if (creds.cookie) {
      await this.session.loginWithCookie(creds.cookie)
    } else if (creds.username && creds.password) {
      await this.session.login(creds.username, creds.password)
    }
    return this.getStatus()
  }

  private async ensureLogin(): Promise<void> {
    if (this.session.isLoggedIn()) return
    const creds = this.authStore.getGeocachingCreds()
    if (!creds) {
      throw new GeocachingAuthError('No geocaching.com credentials configured. POST /geocaching/credentials first.')
    }
    if (creds.cookie) {
      await this.session.loginWithCookie(creds.cookie)
    } else if (creds.username && creds.password) {
      await this.session.login(creds.username, creds.password)
    } else {
      throw new GeocachingAuthError('Incomplete geocaching.com credentials.')
    }
  }

  /** Search-first: one cheap request per ~200 caches, summaries only. */
  async fetchArea(bbox: BBox, opts: { max?: number } = {}): Promise<FetchAreaResult> {
    await this.ensureLogin()
    const max = Math.min(opts.max ?? DEFAULT_MAX, 5000)
    const [s, w, n, e] = bbox
    const box = `${n},${w},${s},${e}` // gc.com box = NW lat,lon, SE lat,lon

    const collected: Geocache[] = []
    let skip = 0
    let total = Infinity
    while (collected.length < max && skip < total) {
      const take = Math.min(SEARCH_PAGE, max - collected.length)
      const page = await this.searchOnce(box, take, skip)
      total = page.total
      if (page.caches.length === 0) break
      collected.push(...page.caches)
      skip += take
      if (page.caches.length < take) break
    }

    const changed = this.store.upsertSummaries(collected)
    if (changed.length && this.onChange) this.onChange(changed)
    return { added: changed.length, total: Number.isFinite(total) ? total : collected.length, budget: this.limiter.budgetStatus() }
  }

  private async searchOnce(box: string, take: number, skip: number) {
    const params = new URLSearchParams({ box, sort: 'datelastvisited', asc: 'true', take: String(take), skip: String(skip) })
    const res = await this.limiter.schedule(() =>
      this.session.request(`/api/proxy/web/search/v2?${params.toString()}`, { headers: { Accept: 'application/json' } }),
    )
    const ct = res.headers.get('content-type') ?? ''
    if (!res.ok || !ct.includes('json')) {
      throw new GeocachingAuthError(`search failed (HTTP ${res.status}); session may be expired — re-authenticate via /geocaching/credentials`)
    }
    return parseSearchResults(await res.json())
  }

  /** Lazy full detail (hint, attributes, description, recent logs) for one cache. */
  async getCacheDetail(code: string, opts: { logLimit?: number } = {}): Promise<Geocache> {
    const existing = this.store.get(code)
    if (existing?.detail) return existing

    await this.ensureLogin()
    const html = await this.limiter.schedule(() =>
      this.session.requestText(`/seek/cache_details.aspx?wp=${encodeURIComponent(code)}`, { headers: { Accept: 'text/html' } }),
    )
    const parsed = parseCacheDetail(html)

    let logs: GeocacheLog[] = []
    if (parsed.userToken) {
      const lbParams = new URLSearchParams({
        tkn: parsed.userToken,
        idx: '1',
        num: String(opts.logLimit ?? 30),
        decrypt: 'true',
      })
      const lbJson = await this.limiter.schedule(() =>
        this.session.requestJson(`/seek/geocache.logbook?${lbParams.toString()}`),
      )
      logs = parseLogbook(lbJson)
    }

    const detail: GeocacheDetail = {
      hint: parsed.hint,
      description: parsed.description,
      attributes: parsed.attributes,
      logs,
      waypoints: parsed.waypoints,
      fetchedAt: Date.now(),
    }

    if (!existing) {
      // Cache requested by code without a prior area fetch — seed a stub summary.
      this.store.upsertSummaries([
        {
          code,
          name: parsed.name ?? code,
          lat: null,
          lon: null,
          type: 'Unknown',
          size: 'unknown',
          difficulty: 0,
          terrain: 0,
          found: false,
          pmOnly: false,
          owner: '',
          hidden: '',
          favorites: parsed.favorites ?? 0,
          status: 'enabled',
          fetchedAt: Date.now(),
        },
      ])
    }
    return this.store.setDetail(code, detail) ?? { ...(existing as Geocache), detail }
  }

  getSnapshot() {
    return this.store.getSnapshot()
  }
}
