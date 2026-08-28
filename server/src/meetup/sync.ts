// Meetup auto-refresh — keeps the LAST manually-fetched area alive.
//
// Meetup events are time-bound and the store prunes anything that has ended,
// so a one-off manual fetch starves within days: the store empties, the SPA's
// calendar overlay unregisters on zero events, and the "Meetup" calendar
// silently vanishes (happened twice). This refresher re-runs the last manual
// fetch-area once a day — it never polls an area Yousef didn't ask for, and
// at 1–4 requests/day it is negligible against the 800/day budget.

import type { MeetupClient, MeetupFetchOpts } from './client.js'
import type { MeetupEventType } from './types.js'

export const REFRESH_MS = 24 * 60 * 60 * 1000
const CHECK_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** What we persist to re-run a fetch later: the original date WINDOW becomes a
 *  duration (`days`) so each refresh re-anchors at "now" instead of replaying
 *  a stale absolute range. */
export interface MeetupRefreshSpec {
  lat: number
  lon: number
  radiusMiles?: number
  query?: string
  eventType?: MeetupEventType
  categoryId?: string
  maxPages?: number
  days?: number
}

export function specFromOpts(opts: MeetupFetchOpts, nowMs: number): MeetupRefreshSpec {
  const spec: MeetupRefreshSpec = { lat: opts.lat, lon: opts.lon }
  if (opts.radiusMiles != null) spec.radiusMiles = opts.radiusMiles
  if (opts.query) spec.query = opts.query
  if (opts.eventType) spec.eventType = opts.eventType
  if (opts.categoryId) spec.categoryId = opts.categoryId
  if (opts.maxPages != null) spec.maxPages = opts.maxPages
  if (opts.endDate) {
    const start = opts.startDate ? Date.parse(opts.startDate) : nowMs
    const end = Date.parse(opts.endDate)
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      spec.days = Math.max(1, Math.round((end - start) / DAY_MS))
    }
  }
  return spec
}

export function optsFromSpec(spec: MeetupRefreshSpec, nowMs: number): MeetupFetchOpts {
  const opts: MeetupFetchOpts = { lat: spec.lat, lon: spec.lon, startDate: new Date(nowMs).toISOString() }
  if (spec.radiusMiles != null) opts.radiusMiles = spec.radiusMiles
  if (spec.query) opts.query = spec.query
  if (spec.eventType) opts.eventType = spec.eventType
  if (spec.categoryId) opts.categoryId = spec.categoryId
  if (spec.maxPages != null) opts.maxPages = spec.maxPages
  if (spec.days) opts.endDate = new Date(nowMs + spec.days * DAY_MS).toISOString()
  return opts
}

export class MeetupSync {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly client: MeetupClient,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return
    // Defer the first check so boot stays snappy; hourly checks after that so
    // a hub that restarts often (or a laptop that sleeps) still converges.
    setTimeout(() => { void this.tick() }, 30_000)
    this.timer = setInterval(() => { void this.tick() }, CHECK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const saved = this.client.refreshState()
      if (!saved) return // never manually fetched — never poll
      if (Date.now() - saved.at < REFRESH_MS) return
      const res = await this.client.fetchArea(optsFromSpec(saved.spec, Date.now()))
      this.log(`[meetup-sync] daily refresh of last area: ${res.added} changed, ${res.total} pulled`)
    } catch (e) {
      this.log(`[meetup-sync] refresh failed: ${(e as Error).message}`)
    } finally {
      this.running = false
    }
  }
}
