// LocationWatcher — holds the Recorder's live WebSocket open, runs every fix it
// delivers through the geofences, and dispatches transitions: archive → wake
// each fence's agents with a [GEOFENCE] envelope → POST to the fence's URL if
// it has one. The hub never interprets a transition; the woken agent decides
// what "entered home" means today.
//
// Nothing is lost across a gap: on every (re)connect the Recorder's history
// since the last fix we saw is replayed through the same engine, in fix order,
// BEFORE any live frame is applied — an enter and a leave that both happened
// while the hub was down still fire (flagged `replayed`). Every IO seam is
// injected so the whole thing is stub-testable.

import { buildGeofenceEnvelope, evaluate, fencesContaining, type FenceState, type Fix, type Geofence, type GeofenceEvent } from './geofence.js'
import type { GeofenceStore } from './store.js'
import type { HistoryQuery, LiveFeed, OpenLiveFeed } from './recorder.js'
import type { EmitInput, HubEvent } from '../events/types.js'

export interface LocationWatcherCtx {
  store: GeofenceStore
  /** Latest fix per device from the Recorder; [] when unconfigured/unreachable. */
  fetchLast: () => Promise<Fix[]>
  /** Recorder history in fix order; [] when unconfigured. Absent = no replay. */
  fetchHistory?: (q: HistoryQuery) => Promise<Fix[]>
  /** The Recorder's live WebSocket; null when unconfigured. Absent = poll `fetchLast` instead. */
  openLiveFeed?: OpenLiveFeed
  /** Inject an envelope into the live session with this agentKey. False = not live. */
  deliverToAgent: (agentKey: string, envelope: string) => boolean
  /** Outbound webhook. Default = global fetch with a 10 s timeout. */
  postUrl?: (url: string, body: string, token?: string) => Promise<{ ok: boolean; detail?: string }>
  /** Event bus seam: `location.fix` per new fix (ring-only), `geo.enter` /
   *  `geo.leave` per transition — alongside, not instead of, the fence's own
   *  wake/url. Listeners are the general path; fences keep theirs. */
  emit?: (input: EmitInput) => HubEvent | null
  /** Something the Map tab shows changed: the current fix, a fence's state, the feed. */
  onChange?: (change: LocationChange) => void
  log: (msg: string) => void
  /** Poll cadence when there is no live feed. */
  intervalMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  now?: () => number
}

export const DEFAULT_POLL_MS = 60_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 60_000
/** A replay window older than this is not worth the Recorder's time: state is re-derived silently instead. */
const MAX_REPLAY_S = 14 * 24 * 3600

export type LocationChange =
  | { kind: 'fix'; fix: Fix; replayed: boolean }
  | { kind: 'fences' }
  | { kind: 'feed'; live: LiveStatus }

export interface LiveStatus {
  /** connected = frames flow; connecting = between attempts; polling = no feed configured/available */
  state: 'connected' | 'connecting' | 'polling' | 'stopped'
  since: number | null
  lastFrameAt: number | null
  reconnects: number
  lastError: string | null
}

export interface ReplayStatus {
  at: number
  /** [fromTst, toTst] unix seconds */
  window: [number, number]
  fixes: number
  events: number
}

export interface CurrentLocation {
  fix: Fix | null
  /** seconds since the fix, at the time of the call */
  ageS: number | null
  inside: Array<{ id: string; name: string; private: boolean }>
  polledAt: number | null
}

export interface DryReplayResult {
  window: [number, number]
  devices: string[]
  fixes: number
  events: Array<Pick<GeofenceEvent, 'id' | 'ts' | 'fenceId' | 'fenceName' | 'event' | 'dwellS'> & { fix: Pick<Fix, 'lat' | 'lon' | 'acc' | 'tst'> }>
  /** where the engine would leave each fence after the window */
  state: Record<string, FenceState>
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
  private started = false

  private feed: LiveFeed | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private hadConnected = false
  private live: LiveStatus = { state: 'stopped', since: null, lastFrameAt: null, reconnects: 0, lastError: null }
  private lastReplay: ReplayStatus | null = null
  /** devices the LAST snapshot named, so the replay asks the Recorder for each */
  private devices = new Map<string, string>()
  /** fixes are applied strictly in arrival order; a replay is queued ahead of the frames that follow it */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: LocationWatcherCtx) {}

  start(): void {
    if (this.started) return
    this.started = true
    if (this.ctx.openLiveFeed) this.connect()
    else this.startPolling()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const feed = this.feed
    this.feed = null
    feed?.close()
    this.setLive({ state: 'stopped', since: null })
  }

  private now(): number { return this.ctx.now ? this.ctx.now() : Date.now() }

  status(): { polledAt: number | null; lastError: string | null; fences: number; live: LiveStatus; lastReplay: ReplayStatus | null } {
    return { polledAt: this.polledAt, lastError: this.lastError, fences: this.ctx.store.fences().length, live: { ...this.live }, lastReplay: this.lastReplay }
  }

  current(): CurrentLocation {
    const fix = this.ctx.store.lastFix()
    const inside = fix ? fencesContaining(this.ctx.store.fences(), fix).map((f) => ({ id: f.id, name: f.name, private: !!f.private })) : []
    return { fix, ageS: fix ? Math.max(0, Math.round(this.now() / 1000 - fix.tst)) : null, inside, polledAt: this.polledAt }
  }

  /** Fences changed underneath us (route upsert/remove) — tell the Map. */
  fencesChanged(): void {
    this.ctx.onChange?.({ kind: 'fences' })
  }

  // --- live feed -------------------------------------------------------------

  private setLive(patch: Partial<LiveStatus>): void {
    this.live = { ...this.live, ...patch }
    this.ctx.onChange?.({ kind: 'feed', live: { ...this.live } })
  }

  private connect(): void {
    if (!this.started || this.feed || !this.ctx.openLiveFeed) return
    this.reconnectTimer = null
    let snapshotDone = false
    let opened = false
    const feed = this.ctx.openLiveFeed({
      onFix: (fix) => {
        if (this.feed !== feed) return
        if (!opened) this.onFeedOpen()
        opened = true
        if (fix.device) this.devices.set(fix.device, fix.user ?? 'amar')
        this.live.lastFrameAt = this.now()
        this.enqueue(fix, false)
      },
      onSnapshot: () => {
        if (this.feed !== feed) return
        if (!opened) this.onFeedOpen()
        opened = true
        snapshotDone = true
        this.live.lastFrameAt = this.now()
      },
      onClose: (reason) => {
        if (this.feed !== feed) return
        this.feed = null
        this.setLive({ state: 'connecting', since: null, lastError: reason })
        this.ctx.log(`[location] live feed closed: ${reason}${snapshotDone ? '' : ' (before the LAST snapshot)'}`)
        this.scheduleReconnect()
      },
    })
    if (!feed) {
      // unconfigured: poll idles on [] too, so just retry the feed slowly
      this.setLive({ state: 'polling', since: null, lastError: 'OwnTracks not configured' })
      this.scheduleReconnect(this.ctx.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS)
      return
    }
    this.feed = feed
    this.setLive({ state: 'connecting' })
  }

  /** First frame after a connect: the socket is real. Replay the gap before anything else is applied. */
  private onFeedOpen(): void {
    const reconnect = this.hadConnected
    this.hadConnected = true
    this.reconnectAttempt = 0
    this.setLive({ state: 'connected', since: this.now(), lastError: null, reconnects: this.live.reconnects + (reconnect ? 1 : 0) })
    this.ctx.log(`[location] live feed ${reconnect ? 're' : ''}connected`)
    this.queue = this.queue.then(() => this.replayGap()).catch((err) => { this.ctx.log(`[location] replay failed: ${(err as Error).message}`) })
  }

  private scheduleReconnect(delayMs?: number): void {
    if (!this.started || this.reconnectTimer) return
    const base = this.ctx.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    const max = this.ctx.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    const delay = delayMs ?? Math.min(max, base * 2 ** Math.min(this.reconnectAttempt, 10))
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, delay)
    this.reconnectTimer.unref?.()
  }

  /** Feed the Recorder's history since the last fix we saw through the engine, in order. */
  private async replayGap(): Promise<void> {
    const last = this.ctx.store.lastFix()
    if (!last || !this.ctx.fetchHistory) return
    const nowTst = Math.round(this.now() / 1000)
    if (nowTst - last.tst > MAX_REPLAY_S) {
      this.ctx.log(`[location] gap since last fix is ${Math.round((nowTst - last.tst) / 86400)} d — too old to replay, re-deriving from live fixes`)
      return
    }
    const devices = new Map(this.devices)
    if (last.device) devices.set(last.device, last.user ?? 'amar')
    if (!devices.size) devices.set('armor', 'amar')
    const all: Fix[] = []
    for (const [device, user] of devices) {
      all.push(...(await this.ctx.fetchHistory({ user, device, fromTst: last.tst, toTst: nowTst + 60 })))
    }
    const fresh = all.filter((f) => f.tst > last.tst).sort((a, b) => a.tst - b.tst)
    let events = 0
    for (const fix of fresh) events += (await this.applyFix(fix, { replayed: true })).length
    this.lastReplay = { at: this.now(), window: [last.tst, nowTst], fixes: fresh.length, events }
    if (fresh.length) this.ctx.log(`[location] replayed ${fresh.length} fix${fresh.length === 1 ? '' : 'es'} since ${new Date(last.tst * 1000).toISOString()} → ${events} transition${events === 1 ? '' : 's'}`)
  }

  private enqueue(fix: Fix, replayed: boolean): void {
    this.queue = this.queue
      .then(async () => {
        const prev = this.ctx.store.lastFix()
        if (prev && fix.tst <= prev.tst) return
        await this.applyFix(fix, { replayed })
      })
      .catch((err) => { this.ctx.log(`[location] applying fix failed: ${(err as Error).message}`) })
  }

  /** Everything queued so far has been applied (tests, shutdown). */
  settled(): Promise<void> { return this.queue }

  // --- polling fallback + manual refresh --------------------------------------

  private startPolling(): void {
    this.setLive({ state: 'polling', since: null })
    void this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.ctx.intervalMs ?? DEFAULT_POLL_MS)
    this.timer.unref?.()
  }

  /** One poll of /last: fetch → prune expired fences → evaluate → dispatch. Coalesces concurrent calls. */
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
    for (const f of fixes) if (f.device) this.devices.set(f.device, f.user ?? 'amar')
    const prevFix = this.ctx.store.lastFix()
    if (prevFix && newest.tst <= prevFix.tst && prevFix.lat === newest.lat && prevFix.lon === newest.lon) return
    await this.applyFix(newest)
  }

  // --- engine ------------------------------------------------------------------

  /** Evaluate + dispatch one fix. Exposed for tests and for `POST /location/fix` style injection. */
  async applyFix(fix: Fix, opts: { replayed?: boolean } = {}): Promise<GeofenceEvent[]> {
    const nowMs = this.now()
    for (const gone of this.ctx.store.pruneExpired(nowMs)) this.ctx.log(`[location] fence "${gone.id}" expired, removed`)
    const fences = this.ctx.store.fences()
    const { state, events } = evaluate(fences, this.ctx.store.state(), fix)
    this.ctx.store.commit(state, fix)
    if (opts.replayed) for (const ev of events) ev.replayed = true
    this.ctx.emit?.({
      topic: 'location.fix',
      source: 'owntracks',
      key: `${fix.device ?? 'device'}:${fix.tst}`,
      at: fix.tst * 1000,
      data: { device: fix.device ?? null, lat: fix.lat, lon: fix.lon, acc: fix.acc ?? null, tst: fix.tst, vel: fix.vel ?? null, batt: fix.batt ?? null, confidence: opts.replayed ? 'replayed' : 'live' },
      ref: 'con location',
    })
    this.ctx.onChange?.({ kind: 'fix', fix, replayed: !!opts.replayed })
    for (const ev of events) await this.dispatch(ev, fences.find((f) => f.id === ev.fenceId))
    if (events.length) this.ctx.onChange?.({ kind: 'fences' })
    return events
  }

  /**
   * Run the engine over Recorder history WITHOUT touching state or dispatching:
   * the transitions the fences as configured would have produced. Tune a radius
   * against a known week instead of waiting for real movement.
   */
  async dryReplay(fromTst: number, toTst: number, opts: { fenceId?: string; devices?: Array<{ user: string; device: string }> } = {}): Promise<DryReplayResult> {
    if (!this.ctx.fetchHistory) throw new Error('history replay not configured')
    const devices = opts.devices ?? (this.devices.size ? [...this.devices].map(([device, user]) => ({ device, user })) : [{ user: 'amar', device: this.ctx.store.lastFix()?.device ?? 'armor' }])
    const all: Fix[] = []
    for (const d of devices) all.push(...(await this.ctx.fetchHistory({ user: d.user, device: d.device, fromTst, toTst })))
    all.sort((a, b) => a.tst - b.tst)
    const fences = this.ctx.store.fences().filter((f) => !opts.fenceId || f.id === opts.fenceId)
    let state: Record<string, FenceState> = {}
    const events: DryReplayResult['events'] = []
    for (const fix of all) {
      const r = evaluate(fences, state, fix)
      state = r.state
      for (const ev of r.events) events.push({ id: ev.id, ts: ev.ts, fenceId: ev.fenceId, fenceName: ev.fenceName, event: ev.event, dwellS: ev.dwellS, fix: { lat: fix.lat, lon: fix.lon, acc: fix.acc, tst: fix.tst } })
    }
    return { window: [fromTst, toTst], devices: devices.map((d) => `${d.user}/${d.device}`), fixes: all.length, events, state }
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
    this.ctx.emit?.({
      topic: ev.event === 'enter' ? 'geo.enter' : 'geo.leave',
      source: 'location',
      key: ev.id,
      at: ev.ts,
      data: {
        fence: ev.fenceId, fenceName: ev.fenceName, lat: ev.fix.lat, lon: ev.fix.lon, acc: ev.fix.acc ?? null,
        dwellS: ev.dwellS, device: ev.fix.device ?? null, private: !!fence?.private, test: !!ev.test, eventId: ev.id,
        confidence: ev.test ? 'test' : ev.replayed ? 'replayed' : 'live',
      },
      ref: 'con location events',
    })
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
    this.ctx.log(`[location] ${ev.test ? 'TEST ' : ''}${ev.replayed ? 'REPLAYED ' : ''}${ev.event} "${ev.fenceId}" → ${outcome}`)
  }
}
