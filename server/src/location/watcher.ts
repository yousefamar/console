// LocationWatcher — polls the OwnTracks Recorder's latest fix, runs it through
// the geofences, and dispatches transitions: archive → wake each fence's
// agents with a [GEOFENCE] envelope → POST to the fence's URL if it has one.
// The hub never interprets a transition; the woken agent decides what
// "entered home" means today. Every IO seam is injected so the whole thing is
// stub-testable.

import { buildGeofenceEnvelope, evaluate, fencesContaining, type Fix, type Geofence, type GeofenceEvent } from './geofence.js'
import type { GeofenceStore } from './store.js'

export interface LocationWatcherCtx {
  store: GeofenceStore
  /** Latest fix per device from the Recorder; [] when unconfigured/unreachable. */
  fetchLast: () => Promise<Fix[]>
  /** Inject an envelope into the live session with this agentKey. False = not live. */
  deliverToAgent: (agentKey: string, envelope: string) => boolean
  /** Outbound webhook. Default = global fetch with a 10 s timeout. */
  postUrl?: (url: string, body: string, token?: string) => Promise<{ ok: boolean; detail?: string }>
  log: (msg: string) => void
  intervalMs?: number
  now?: () => number
}

export const DEFAULT_POLL_MS = 60_000

export interface CurrentLocation {
  fix: Fix | null
  /** seconds since the fix, at the time of the call */
  ageS: number | null
  inside: Array<{ id: string; name: string; private: boolean }>
  polledAt: number | null
}

async function defaultPost(url: string, body: string, token?: string): Promise<{ ok: boolean; detail?: string }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'console-hub-geofence/1' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal })
    return { ok: res.ok, detail: `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  } finally {
    clearTimeout(t)
  }
}

export class LocationWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking: Promise<void> | null = null
  private polledAt: number | null = null
  private lastError: string | null = null

  constructor(private readonly ctx: LocationWatcherCtx) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.ctx.intervalMs ?? DEFAULT_POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private now(): number { return this.ctx.now ? this.ctx.now() : Date.now() }

  status(): { polledAt: number | null; lastError: string | null; fences: number } {
    return { polledAt: this.polledAt, lastError: this.lastError, fences: this.ctx.store.fences().length }
  }

  current(): CurrentLocation {
    const fix = this.ctx.store.lastFix()
    const inside = fix ? fencesContaining(this.ctx.store.fences(), fix).map((f) => ({ id: f.id, name: f.name, private: !!f.private })) : []
    return { fix, ageS: fix ? Math.max(0, Math.round(this.now() / 1000 - fix.tst)) : null, inside, polledAt: this.polledAt }
  }

  /** One poll: fetch → prune expired fences → evaluate → dispatch. Coalesces concurrent calls. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking
    this.ticking = this.doTick().finally(() => { this.ticking = null })
    return this.ticking
  }

  private async doTick(): Promise<void> {
    const nowMs = this.now()
    for (const gone of this.ctx.store.pruneExpired(nowMs)) this.ctx.log(`[location] fence "${gone.id}" expired, removed`)

    let fixes: Fix[]
    try {
      fixes = await this.ctx.fetchLast()
      this.lastError = null
    } catch (err) {
      this.lastError = (err as Error).message
      this.ctx.log(`[location] recorder fetch failed: ${this.lastError}`)
      return
    }
    this.polledAt = nowMs
    const newest = fixes.reduce<Fix | null>((best, f) => (best && best.tst >= f.tst ? best : f), null)
    if (!newest) return
    const prevFix = this.ctx.store.lastFix()
    if (prevFix && newest.tst <= prevFix.tst && prevFix.lat === newest.lat && prevFix.lon === newest.lon) return
    await this.applyFix(newest)
  }

  /** Evaluate + dispatch one fix. Exposed for tests and for `POST /location/fix` style injection. */
  async applyFix(fix: Fix): Promise<GeofenceEvent[]> {
    const fences = this.ctx.store.fences()
    const { state, events } = evaluate(fences, this.ctx.store.state(), fix)
    this.ctx.store.commit(state, fix)
    for (const ev of events) await this.dispatch(ev, fences.find((f) => f.id === ev.fenceId))
    return events
  }

  /** Fire a synthetic transition through the full pipeline (no state change). */
  async test(fenceId: string, event: 'enter' | 'leave'): Promise<GeofenceEvent | null> {
    const fence = this.ctx.store.fence(fenceId)
    if (!fence) return null
    const fix = this.ctx.store.lastFix() ?? { lat: fence.lat, lon: fence.lon, tst: Math.round(this.now() / 1000) }
    const ev: GeofenceEvent = {
      id: `gf_test_${this.now().toString(36)}_${fenceId}`.slice(0, 64),
      ts: this.now(),
      fenceId: fence.id,
      fenceName: fence.name,
      event,
      fix,
      dwellS: 0,
      test: true,
      delivered: [],
    }
    await this.dispatch(ev, fence)
    return ev
  }

  private async dispatch(ev: GeofenceEvent, fence: Geofence | undefined): Promise<void> {
    const envelope = buildGeofenceEnvelope(ev, fence, this.now())
    for (const key of fence?.wake ?? []) {
      const ok = this.ctx.deliverToAgent(key, envelope)
      ev.delivered.push({ to: `@${key}`, ok, detail: ok ? undefined : 'not live' })
    }
    if (fence?.url) {
      const post = this.ctx.postUrl ?? defaultPost
      const { delivered: _d, ...payload } = ev
      const r = await post(fence.url, JSON.stringify({ type: 'geofence', ...payload, fence: { id: fence.id, name: fence.name, note: fence.note ?? null } }), fence.urlToken)
      ev.delivered.push({ to: fence.url, ok: r.ok, detail: r.detail })
    }
    this.ctx.store.appendEvent(ev)
    const outcome = ev.delivered.map((d) => `${d.to}${d.ok ? '' : ` ✗ ${d.detail ?? ''}`}`).join(', ') || 'nobody to notify'
    this.ctx.log(`[location] ${ev.test ? 'TEST ' : ''}${ev.event} "${ev.fenceId}" → ${outcome}`)
  }
}
