import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { evaluate, haversineM, leaveMarginM, fixTooCoarse, resolveInside, buildGeofenceEnvelope, slugify, fencesContaining, type Fix, type Geofence } from '../location/geofence.js'
import { GeofenceStore } from '../location/store.js'
import { LocationWatcher, type LocationChange } from '../location/watcher.js'
import { fixFromRecorder, type HistoryQuery, type LiveFeedHandlers } from '../location/recorder.js'
import type { EmitInput } from '../events/types.js'
import { handleLocationRoutes, parseFenceBody, type LocationRouteCtx } from '../routes/location.js'
import { levelFor, placeWords, ageWords, disclose, type ReverseGeo } from '../location/disclose.js'
import { lateCheck, formatLateReport, VIRTUAL_RE, TRAVEL_RE, type CalEvent, type LateCtx } from '../location/late.js'

const HOME = { lat: 51.45537, lon: -0.96380 }
const fence = (over: Partial<Geofence> = {}): Geofence => ({ id: 'home', name: 'Home', lat: HOME.lat, lon: HOME.lon, radius: 150, wake: ['al'], on: 'both', createdAt: 0, ...over })
/** A fix `metres` east of HOME. */
const at = (metres: number, tst: number, over: Partial<Fix> = {}): Fix => ({ lat: HOME.lat, lon: HOME.lon + metres / (111_320 * Math.cos((HOME.lat * Math.PI) / 180)), tst, acc: 12, ...over })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'location-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('geofence: geometry', () => {
  it('haversine is metres', () => {
    expect(haversineM(HOME.lat, HOME.lon, HOME.lat, HOME.lon)).toBe(0)
    expect(haversineM(51.5074, -0.1278, 51.4543, -0.9781)).toBeGreaterThan(58_000) // London → Reading
    expect(haversineM(51.5074, -0.1278, 51.4543, -0.9781)).toBeLessThan(60_000)
    expect(Math.abs(haversineM(HOME.lat, HOME.lon, at(100, 0).lat, at(100, 0).lon) - 100)).toBeLessThan(1)
  })
  it('leave margin is 15 % with a 30 m floor', () => {
    expect(leaveMarginM(100)).toBe(30)
    expect(leaveMarginM(1000)).toBe(150)
  })
  it('a fix coarser than the fence cannot flip it', () => {
    expect(fixTooCoarse(fence(), at(0, 1, { acc: 100 }))).toBe(false)
    expect(fixTooCoarse(fence(), at(0, 1, { acc: 301 }))).toBe(true)
    expect(fixTooCoarse(fence({ radius: 20 }), at(0, 1, { acc: 140 }))).toBe(false) // 150 floor
    expect(fixTooCoarse(fence(), at(0, 1, { acc: undefined }))).toBe(false)
  })
  it('slugify', () => {
    expect(slugify('Reading Speakers Club!')).toBe('reading-speakers-club')
    expect(slugify('   ')).toBe('fence')
  })
})

describe('geofence: evaluate', () => {
  it('first sighting initialises silently — no event', () => {
    const r = evaluate([fence()], {}, at(0, 100))
    expect(r.events).toEqual([])
    expect(r.state.home).toMatchObject({ inside: true, since: 100_000, tst: 100 })
  })
  it('outside → inside fires enter with the dwell outside', () => {
    const s0 = evaluate([fence()], {}, at(2000, 100)).state
    const r = evaluate([fence()], s0, at(50, 700))
    expect(r.events).toHaveLength(1)
    expect(r.events[0]).toMatchObject({ event: 'enter', fenceId: 'home', fenceName: 'Home', dwellS: 600, ts: 700_000 })
    expect(r.events[0]!.id).toMatch(/^gf_/)
  })
  it('hysteresis: just past the radius stays inside, past the margin leaves', () => {
    const s0 = evaluate([fence()], {}, at(0, 100)).state
    const edge = evaluate([fence()], s0, at(170, 200)) // 150 + 30 margin = 180, and the fix is ±12 m
    expect(edge.events).toEqual([])
    expect(edge.state.home!.inside).toBe(true)
    const out = evaluate([fence()], edge.state, at(195, 300))
    expect(out.events).toHaveLength(1)
    expect(out.events[0]).toMatchObject({ event: 'leave', dwellS: 200 })
    expect(out.state.home).toMatchObject({ inside: false, since: 300_000 })
  })
  it('a coarse fix neither flips nor advances the fence', () => {
    const s0 = evaluate([fence()], {}, at(0, 100)).state
    const r = evaluate([fence()], s0, at(5000, 200, { acc: 2000 }))
    expect(r.events).toEqual([])
    expect(r.state.home).toEqual(s0.home)
  })
  it('a transition needs the whole ±acc circle past its line (the home flap of 2026-09-24 17:00)', () => {
    // Real fixes: 16:57:43 ENTER 87 m in at ±20 m, then 17:00:10 a network fix 186 m out at ±200 m —
    // finer than the absolute gate (300 m for r 150) yet past the 180 m leave line. It must not flip.
    const outside = evaluate([fence()], {}, { lat: 51.4547802, lon: -0.9667123, tst: 1790265341, acc: 17 }).state
    expect(outside.home!.inside).toBe(false)
    const enter = evaluate([fence()], outside, { lat: 51.4547368, lon: -0.9645321, tst: 1790265463, acc: 20 })
    expect(enter.events.map((e) => e.event)).toEqual(['enter'])
    const flap = evaluate([fence()], enter.state, { lat: 51.4547181, lon: -0.9662706, tst: 1790265610, acc: 200 })
    expect(flap.events).toEqual([])
    expect(flap.state.home).toMatchObject({ inside: true, since: 1790265463_000, tst: 1790265610 })
    // the same spot at GPS accuracy is a real leave
    const gps = evaluate([fence()], flap.state, { lat: 51.4547181, lon: -0.9662706, tst: 1790265700, acc: 2 })
    expect(gps.events.map((e) => e.event)).toEqual(['leave'])
    expect(gps.events[0]).toMatchObject({ dwellS: 237 })
  })
  it('enter needs the circle inside too: ±100 m at 80 m in is not an enter, ±20 m is', () => {
    const s0 = evaluate([fence()], {}, at(2000, 100)).state
    const coarse = evaluate([fence()], s0, at(80, 200, { acc: 100 }))
    expect(coarse.events).toEqual([])
    expect(coarse.state.home).toMatchObject({ inside: false, tst: 200 })
    expect(evaluate([fence()], coarse.state, at(80, 300, { acc: 20 })).events.map((e) => e.event)).toEqual(['enter'])
    expect(resolveInside(fence(), at(80, 1, { acc: undefined }), false)).toBe(true) // no accuracy = trust the point
  })
  it('`on` filters which transitions fire but state still moves', () => {
    const f = fence({ on: 'leave' })
    const s0 = evaluate([f], {}, at(2000, 100)).state
    const enter = evaluate([f], s0, at(0, 200))
    expect(enter.events).toEqual([])
    expect(enter.state.home!.inside).toBe(true)
    const leave = evaluate([f], enter.state, at(1000, 300))
    expect(leave.events.map((e) => e.event)).toEqual(['leave'])
  })
  it('many fences evaluate independently', () => {
    const fences = [fence(), fence({ id: 'work', name: 'Work', lat: 51.5, lon: -0.1, radius: 200 })]
    const s0 = evaluate(fences, {}, at(0, 100)).state
    expect(s0.home!.inside).toBe(true)
    expect(s0.work!.inside).toBe(false)
    const r = evaluate(fences, s0, { lat: 51.5, lon: -0.1, tst: 4000, acc: 10 })
    expect(r.events.map((e) => `${e.fenceId}:${e.event}`).sort()).toEqual(['home:leave', 'work:enter'])
    expect(fencesContaining(fences, { lat: 51.5, lon: -0.1, tst: 0 }).map((f) => f.id)).toEqual(['work'])
  })
  it('envelope names the fence, the verb, the dwell and the event id', () => {
    const s0 = evaluate([fence()], {}, at(2000, 1_000_000)).state
    const [ev] = evaluate([fence()], s0, at(0, 1_003_600, { batt: 77 })).events
    const env = buildGeofenceEnvelope(ev!, fence({ note: 'his flat' }), 1_003_660_000)
    expect(env).toContain('[GEOFENCE — Yousef ENTERED "Home"]')
    expect(env).toContain('fix 1 min old ±12 m, battery 77 %')
    expect(env).toContain('r 150 m — his flat')
    expect(env).toContain('Before: outside for 1 h')
    expect(env).toContain(`Event id ${ev!.id}`)
    expect(buildGeofenceEnvelope({ ...ev!, test: true }, undefined)).toContain('[GEOFENCE TEST — ')
  })
})

describe('geofence: store', () => {
  it('persists fences + state across instances and resets state when geometry changes', () => {
    const a = new GeofenceStore(dir)
    a.upsert(fence({ createdBy: 'al' }))
    a.commit(evaluate(a.fences(), {}, at(0, 100)).state, at(0, 100))
    const b = new GeofenceStore(dir)
    expect(b.fences()).toHaveLength(1)
    expect(b.state().home!.inside).toBe(true)
    expect(b.lastFix()!.tst).toBe(100)
    b.upsert(fence({ name: 'Home (renamed)', createdAt: 999 }))
    expect(b.state().home!.inside).toBe(true) // same geometry → state kept
    expect(b.fence('home')!.createdAt).toBe(0) // original creation preserved
    expect(b.fence('home')!.createdBy).toBe('al')
    b.upsert(fence({ radius: 300 }))
    expect(b.state().home).toBeUndefined()
  })
  it('remove + pruneExpired', () => {
    const s = new GeofenceStore(dir)
    s.upsert(fence())
    s.upsert(fence({ id: 'venue', name: 'Venue', expiresAt: 5000 }))
    expect(s.pruneExpired(4999)).toEqual([])
    expect(s.pruneExpired(5000).map((f) => f.id)).toEqual(['venue'])
    expect(s.fences().map((f) => f.id)).toEqual(['home'])
    expect(s.remove('nope')).toBe(false)
    expect(s.remove('home')).toBe(true)
    expect(s.fences()).toEqual([])
  })
  it('events are append-only, newest first, filterable', () => {
    const s = new GeofenceStore(dir)
    const s0 = evaluate([fence()], {}, at(2000, 100)).state
    const [enter] = evaluate([fence()], s0, at(0, 200)).events
    const [leave] = evaluate([fence()], evaluate([fence()], s0, at(0, 200)).state, at(1000, 300)).events
    s.appendEvent(enter!)
    s.appendEvent(leave!)
    s.appendEvent({ ...enter!, id: 'x', fenceId: 'work', fenceName: 'Work' })
    expect(s.events().map((e) => e.id)).toEqual(['x', leave!.id, enter!.id])
    expect(s.events({ fenceId: 'home' }).map((e) => e.event)).toEqual(['leave', 'enter'])
    expect(s.events({ limit: 1 })).toHaveLength(1)
    expect(readFileSync(join(dir, 'geofence-events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(3)
  })
})

describe('recorder mapping', () => {
  it('maps a Recorder /last row and drops junk', () => {
    expect(fixFromRecorder({ _type: 'location', lat: 51.4553713, lon: -0.9638021, tst: 1789894800, acc: 100, batt: 93, vel: 0, device: 'armor', username: 'amar' }))
      .toEqual({ lat: 51.4553713, lon: -0.9638021, tst: 1789894800, acc: 100, batt: 93, vel: 0, device: 'armor', user: 'amar' })
    expect(fixFromRecorder({ _type: 'lwt' })).toBeNull()
  })
  it('the /ws/last snapshot names the device only in its topic', () => {
    expect(fixFromRecorder({ _type: 'location', lat: 51.4553919, lon: -0.963761, tst: 1789922584, tid: 'h2', topic: 'owntracks/amar/armor' } as Parameters<typeof fixFromRecorder>[0]))
      .toEqual({ lat: 51.4553919, lon: -0.963761, tst: 1789922584, device: 'armor', user: 'amar' })
  })
})

interface Harness {
  store: GeofenceStore
  watcher: LocationWatcher
  fixes: Fix[]
  delivered: Array<{ key: string; envelope: string }>
  posts: Array<{ url: string; body: string; token?: string }>
  logs: string[]
  live: Set<string>
  clock: { now: number }
}

function harness(fixes: Fix[] = [], opts: { live?: string[]; fetchThrows?: boolean } = {}): Harness {
  const store = new GeofenceStore(dir)
  const delivered: Harness['delivered'] = []
  const posts: Harness['posts'] = []
  const logs: string[] = []
  const live = new Set(opts.live ?? ['al'])
  const clock = { now: 10_000_000 }
  const watcher = new LocationWatcher({
    store,
    fetchLast: async () => { if (opts.fetchThrows) throw new Error('boom'); return fixes },
    deliverToAgent: (key, envelope) => { if (!live.has(key)) return false; delivered.push({ key, envelope }); return true },
    postUrl: async (url, body, token) => { posts.push({ url, body, token }); return { ok: url.includes('good'), detail: url.includes('good') ? 'HTTP 200' : 'HTTP 500' } },
    log: (m) => logs.push(m),
    now: () => clock.now,
  })
  return { store, watcher, fixes, delivered, posts, logs, live, clock }
}

describe('watcher', () => {
  it('tick picks the newest device fix, initialises silently, then fires on the next transition', async () => {
    const h = harness([at(3000, 100, { device: 'old' }), at(0, 200, { device: 'armor' })])
    h.store.upsert(fence())
    await h.watcher.tick()
    expect(h.store.lastFix()!.device).toBe('armor')
    expect(h.store.state().home!.inside).toBe(true)
    expect(h.delivered).toEqual([])
    expect(h.watcher.current()).toMatchObject({ inside: [{ id: 'home', name: 'Home', private: false }], ageS: 9800 })

    h.fixes.splice(0, h.fixes.length, at(1000, 300, { device: 'armor' }))
    await h.watcher.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.key).toBe('al')
    expect(h.delivered[0]!.envelope).toContain('Yousef LEFT "Home"')
    expect(h.store.events()[0]).toMatchObject({ event: 'leave', delivered: [{ to: '@al', ok: true }] })
    expect(h.logs.at(-1)).toContain('leave "home" → @al')
  })
  it('the same fix twice is not re-evaluated; a Recorder error is logged, not thrown', async () => {
    const h = harness([at(0, 100)])
    h.store.upsert(fence())
    await h.watcher.tick()
    const before = JSON.stringify(h.store.state())
    await h.watcher.tick()
    expect(JSON.stringify(h.store.state())).toBe(before)
    const bad = harness([], { fetchThrows: true })
    await bad.watcher.tick()
    expect(bad.watcher.status().lastError).toBe('boom')
    expect(bad.logs[0]).toContain('recorder fetch failed: boom')
  })
  it('wakes every agent in `wake`, records not-live ones, and POSTs to the url with the token', async () => {
    const h = harness([at(3000, 100)], { live: ['al'] })
    h.store.upsert(fence({ wake: ['al', 'ceo'], url: 'https://good.example/hook', urlToken: 'sekrit' }))
    await h.watcher.tick()
    h.fixes.splice(0, 1, at(0, 200))
    await h.watcher.tick()
    expect(h.delivered.map((d) => d.key)).toEqual(['al'])
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.token).toBe('sekrit')
    const body = JSON.parse(h.posts[0]!.body) as Record<string, unknown>
    expect(body).toMatchObject({ type: 'geofence', event: 'enter', fenceId: 'home', fence: { id: 'home', name: 'Home' } })
    expect(body.delivered).toBeUndefined()
    expect(h.store.events()[0]!.delivered).toEqual([
      { to: '@al', ok: true },
      { to: '@ceo', ok: false, detail: 'not live' },
      { to: 'https://good.example/hook', ok: true, detail: 'HTTP 200' },
    ])
  })
  it('expired fences are pruned on tick; test() fires a synthetic event without touching state', async () => {
    const h = harness([at(0, 100)])
    h.store.upsert(fence({ id: 'venue', name: 'Venue', expiresAt: 9_999_999 }))
    h.store.upsert(fence())
    await h.watcher.tick()
    expect(h.store.fences().map((f) => f.id)).toEqual(['home'])
    expect(h.logs[0]).toContain('"venue" expired')
    const ev = await h.watcher.test('home', 'leave')
    expect(ev).toMatchObject({ test: true, event: 'leave', fenceId: 'home' })
    expect(h.delivered.at(-1)!.envelope).toContain('[GEOFENCE TEST — Yousef LEFT "Home"]')
    expect(h.store.state().home!.inside).toBe(true)
    expect(await h.watcher.test('nope', 'enter')).toBeNull()
  })
})

// --- live feed + replay ------------------------------------------------------

interface FakeFeed {
  handlers: LiveFeedHandlers
  closedByHub: boolean
}

interface LiveHarness extends Harness {
  feeds: FakeFeed[]
  /** Recorder history the replay will see, any order */
  history: Fix[]
  historyQueries: HistoryQuery[]
  emitted: EmitInput[]
  changes: LocationChange[]
  /** null → "unconfigured" for that attempt */
  configured: { value: boolean }
  /** drive the newest feed */
  feed: () => FakeFeed
  open: (snapshot: Fix[]) => Promise<void>
}

function liveHarness(opts: { live?: string[]; fetchLastFixes?: Fix[] } = {}): LiveHarness {
  const store = new GeofenceStore(dir)
  const delivered: Harness['delivered'] = []
  const posts: Harness['posts'] = []
  const logs: string[] = []
  const live = new Set(opts.live ?? ['al'])
  const clock = { now: 10_000_000 }
  const feeds: FakeFeed[] = []
  const history: Fix[] = []
  const historyQueries: HistoryQuery[] = []
  const emitted: EmitInput[] = []
  const changes: LocationChange[] = []
  const configured = { value: true }
  const fixes = opts.fetchLastFixes ?? []
  const watcher = new LocationWatcher({
    store,
    fetchLast: async () => fixes,
    fetchHistory: async (q) => {
      historyQueries.push(q)
      return history.filter((f) => (f.device ?? 'armor') === q.device && f.tst >= q.fromTst && f.tst <= q.toTst).sort((a, b) => a.tst - b.tst)
    },
    openLiveFeed: (handlers) => {
      if (!configured.value) return null
      const f: FakeFeed = { handlers, closedByHub: false }
      feeds.push(f)
      return { close: () => { f.closedByHub = true } }
    },
    deliverToAgent: (key, envelope) => { if (!live.has(key)) return false; delivered.push({ key, envelope }); return true },
    postUrl: async (url, body, token) => { posts.push({ url, body, token }); return { ok: true, detail: 'HTTP 200' } },
    emit: (input) => { emitted.push(input); return null },
    onChange: (c) => { changes.push(c) },
    log: (m) => logs.push(m),
    now: () => clock.now,
    reconnectBaseMs: 1,
    reconnectMaxMs: 4,
  })
  const feed = () => feeds[feeds.length - 1]!
  const open = async (snapshot: Fix[]) => {
    for (const f of snapshot) feed().handlers.onFix(f)
    feed().handlers.onSnapshot()
    await watcher.settled()
  }
  return { store, watcher, fixes, delivered, posts, logs, live, clock, feeds, history, historyQueries, emitted, changes, configured, feed, open }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('watcher: live feed', () => {
  it('opens the feed on start, applies the LAST snapshot silently, then fires on live frames in order', async () => {
    const h = liveHarness()
    h.store.upsert(fence())
    h.watcher.start()
    expect(h.feeds).toHaveLength(1)
    expect(h.watcher.status().live.state).toBe('connecting')
    await h.open([at(0, 100, { device: 'armor', user: 'amar' })])
    expect(h.watcher.status().live).toMatchObject({ state: 'connected', reconnects: 0 })
    expect(h.store.state().home!.inside).toBe(true)
    expect(h.delivered).toEqual([])
    expect(h.historyQueries).toEqual([]) // nothing to replay: no prior fix

    h.feed().handlers.onFix(at(400, 200, { device: 'armor' }))
    h.feed().handlers.onFix(at(0, 300, { device: 'armor' }))
    await h.watcher.settled()
    expect(h.delivered.map((d) => d.envelope.split('\n')[0])).toEqual(['[GEOFENCE — Yousef LEFT "Home"]', '[GEOFENCE — Yousef ENTERED "Home"]'])
    expect(h.emitted.filter((e) => e.topic === 'location.fix').map((e) => e.data.confidence)).toEqual(['live', 'live', 'live'])
    expect(h.emitted.filter((e) => e.topic.startsWith('geo.')).map((e) => [e.topic, e.data.confidence])).toEqual([['geo.leave', 'live'], ['geo.enter', 'live']])
    expect(h.changes.filter((c) => c.kind === 'fix')).toHaveLength(3)
    expect(h.watcher.current().fix!.tst).toBe(300)
    h.watcher.stop()
    expect(h.feed().closedByHub).toBe(true)
    expect(h.watcher.status().live.state).toBe('stopped')
  })

  it('a stale or duplicate frame is ignored; frames are never re-evaluated out of order', async () => {
    const h = liveHarness()
    h.store.upsert(fence())
    h.watcher.start()
    await h.open([at(0, 500)])
    h.feed().handlers.onFix(at(400, 400)) // older than what we have
    h.feed().handlers.onFix(at(0, 500)) // same again
    await h.watcher.settled()
    expect(h.delivered).toEqual([])
    expect(h.store.lastFix()!.tst).toBe(500)
  })

  it('kill-and-restart: a transit entirely inside the gap replays both transitions in fix order, flagged replayed, with no duplicate enter', async () => {
    // session 1: inside home, then the hub dies
    const h1 = liveHarness()
    h1.store.upsert(fence())
    h1.watcher.start()
    await h1.open([at(0, 1000, { device: 'armor', user: 'amar' })])
    h1.watcher.stop()
    expect(h1.store.state().home!.inside).toBe(true)

    // while down: he left (1200), came back (1500); the Recorder has it all; his phone is now at home (1800)
    const h2 = liveHarness()
    h2.clock.now = 1_900_000
    h2.history.push(at(0, 1000, { device: 'armor' }), at(600, 1200, { device: 'armor' }), at(700, 1300, { device: 'armor' }), at(0, 1500, { device: 'armor' }), at(0, 1800, { device: 'armor' }))
    h2.watcher.start()
    await h2.open([at(0, 1800, { device: 'armor', user: 'amar' })])

    expect(h2.historyQueries).toEqual([{ user: 'amar', device: 'armor', fromTst: 1000, toTst: 1900 + 60 }])
    expect(h2.delivered.map((d) => d.envelope.split('\n')[0])).toEqual([
      '[GEOFENCE REPLAYED — Yousef LEFT "Home"]',
      '[GEOFENCE REPLAYED — Yousef ENTERED "Home"]',
    ])
    expect(h2.delivered[0]!.envelope).toContain('replayed from Recorder history')
    const geo = h2.emitted.filter((e) => e.topic.startsWith('geo.'))
    expect(geo.map((e) => [e.topic, e.at, e.data.confidence])).toEqual([['geo.leave', 1_200_000, 'replayed'], ['geo.enter', 1_500_000, 'replayed']])
    expect(h2.store.events().map((e) => [e.event, e.ts, e.replayed])).toEqual([['enter', 1_500_000, true], ['leave', 1_200_000, true]])
    expect(h2.store.lastFix()!.tst).toBe(1800)
    expect(h2.store.state().home).toMatchObject({ inside: true, since: 1_500_000 })
    expect(h2.watcher.status().lastReplay).toMatchObject({ window: [1000, 1900], fixes: 4, events: 2 })
    expect(h2.logs.some((l) => l.includes('replayed 4 fixes since 1970-01-01T00:16:40.000Z → 2 transitions'))).toBe(true)
    // the LAST snapshot fix (1800) arrived before the replay finished and was applied AFTER it, not before
    expect(h2.emitted.filter((e) => e.topic === 'location.fix').map((e) => e.data.tst)).toEqual([1200, 1300, 1500, 1800])
  })

  it('reconnect: the socket dies, backoff reopens it, and the gap is replayed before the buffered live frames', async () => {
    const h = liveHarness()
    h.store.upsert(fence())
    h.watcher.start()
    await h.open([at(0, 100, { device: 'armor', user: 'amar' })])
    h.clock.now = 10_000_000 + 700_000
    h.feed().handlers.onClose('closed 1006')
    expect(h.watcher.status().live).toMatchObject({ state: 'connecting', lastError: 'closed 1006' })
    expect(h.logs.at(-1)).toContain('live feed closed: closed 1006')
    await sleep(15)
    expect(h.feeds).toHaveLength(2)
    // the Recorder recorded a leave while we were reconnecting
    h.history.push(at(600, 400, { device: 'armor' }))
    // live frame arrives with the snapshot, then the sentinel
    await h.open([at(650, 700, { device: 'armor', user: 'amar' })])
    expect(h.watcher.status().live).toMatchObject({ state: 'connected', reconnects: 1, lastError: null })
    expect(h.delivered.map((d) => d.envelope.split('\n')[0])).toEqual(['[GEOFENCE REPLAYED — Yousef LEFT "Home"]'])
    expect(h.emitted.filter((e) => e.topic === 'location.fix').map((e) => [e.data.tst, e.data.confidence])).toEqual([[100, 'live'], [400, 'replayed'], [700, 'live']])
    expect(h.store.state().home!.inside).toBe(false)
    // a close from a feed we already replaced is ignored
    h.feeds[0]!.handlers.onClose('late')
    expect(h.watcher.status().live.state).toBe('connected')
  })

  it('a gap older than 14 days is not replayed; state re-derives silently from the live snapshot', async () => {
    const h1 = liveHarness()
    h1.store.upsert(fence())
    h1.watcher.start()
    await h1.open([at(0, 1000)])
    h1.watcher.stop()
    const h2 = liveHarness()
    h2.clock.now = (1000 + 20 * 86400) * 1000
    h2.history.push(at(600, 2000))
    h2.watcher.start()
    await h2.open([at(600, 1000 + 20 * 86400)])
    expect(h2.historyQueries).toEqual([])
    expect(h2.logs.some((l) => l.includes('too old to replay'))).toBe(true)
    // he is outside now — that IS a transition relative to the persisted inside state, and it fires once, live
    expect(h2.delivered.map((d) => d.envelope.split('\n')[0])).toEqual(['[GEOFENCE — Yousef LEFT "Home"]'])
  })

  it('unconfigured OwnTracks: no feed, status says so, the feed is retried; a manual tick still works', async () => {
    const h = liveHarness({ fetchLastFixes: [at(0, 100)] })
    h.configured.value = false
    h.watcher.start()
    expect(h.feeds).toHaveLength(0)
    expect(h.watcher.status().live).toMatchObject({ state: 'polling', lastError: 'OwnTracks not configured' })
    await h.watcher.tick()
    expect(h.store.lastFix()!.tst).toBe(100)
    h.configured.value = true
    await sleep(15)
    expect(h.feeds).toHaveLength(1)
    h.watcher.stop()
  })

  it('fence changes and feed state reach the Map seam', async () => {
    const h = liveHarness()
    h.watcher.start()
    h.watcher.fencesChanged()
    expect(h.changes.map((c) => c.kind)).toEqual(['feed', 'fences'])
    await h.open([at(0, 100)])
    expect(h.changes.map((c) => c.kind)).toEqual(['feed', 'fences', 'feed', 'fix'])
    expect((h.changes[2] as { live: { state: string } }).live.state).toBe('connected')
    h.watcher.stop()
  })

  it('dryReplay reports the transitions history would produce without touching state or waking anyone', async () => {
    const h = liveHarness()
    h.store.upsert(fence())
    h.store.upsert(fence({ id: 'gym', name: 'Gym', lat: at(5000, 0).lat, lon: at(5000, 0).lon, radius: 100 }))
    h.history.push(at(0, 100), at(600, 200), at(5000, 300), at(5010, 400), at(600, 500), at(0, 600))
    const r = await h.watcher.dryReplay(0, 1000)
    expect(r).toMatchObject({ window: [0, 1000], devices: ['amar/armor'], fixes: 6 })
    expect(r.events.map((e) => `${e.fenceId}:${e.event}@${e.ts / 1000}`)).toEqual(['home:leave@200', 'gym:enter@300', 'gym:leave@500', 'home:enter@600'])
    expect(r.state.home!.inside).toBe(true)
    expect(r.state.gym!.inside).toBe(false)
    const only = await h.watcher.dryReplay(0, 1000, { fenceId: 'gym' })
    expect(only.events.map((e) => e.fenceId)).toEqual(['gym', 'gym'])
    expect(h.delivered).toEqual([])
    expect(h.store.lastFix()).toBeNull()
    expect(h.store.events()).toEqual([])
  })
})

describe('routes: parseFenceBody', () => {
  it('derives the id, defaults wake/on, validates ranges', () => {
    const r = parseFenceBody(JSON.stringify({ name: 'Reading Speakers Club', lat: 51.45, lon: -0.96, radius: 120 }), 'al-fork', 1000)
    expect('fence' in r && r.fence).toMatchObject({ id: 'reading-speakers-club', wake: ['al'], on: 'both', createdBy: 'al-fork', createdAt: 1000 })
    expect(parseFenceBody('{}', undefined, 0)).toEqual({ error: 'name required' })
    expect(parseFenceBody(JSON.stringify({ name: 'x', lat: 91, lon: 0, radius: 50 }), undefined, 0)).toEqual({ error: 'lat must be -90..90' })
    expect(parseFenceBody(JSON.stringify({ name: 'x', lat: 0, lon: 0, radius: 5 }), undefined, 0)).toEqual({ error: 'radius must be 10..500000 metres' })
    expect(parseFenceBody(JSON.stringify({ name: 'x', lat: 0, lon: 0, radius: 50, on: 'sometimes' }), undefined, 0)).toEqual({ error: 'on must be enter, leave or both' })
    expect(parseFenceBody(JSON.stringify({ name: 'x', lat: 0, lon: 0, radius: 50, url: 'ftp://x' }), undefined, 0)).toEqual({ error: 'url must be http(s)' })
    expect(parseFenceBody(JSON.stringify({ name: 'x', lat: 0, lon: 0, radius: 50, expiresAt: '2020-01-01T00:00:00Z' }), undefined, Date.now())).toEqual({ error: 'expiresAt is in the past' })
    expect(parseFenceBody('nope', undefined, 0)).toEqual({ error: 'body must be JSON' })
    const full = parseFenceBody(JSON.stringify({ id: 'HQ', name: 'HQ', lat: 1, lon: 2, radius: 100, wake: 'al, ceo', url: 'https://x/y', urlToken: 't', private: true, on: 'enter', note: 'n', expiresAt: 5_000_000_000_000 }), undefined, 0)
    expect('fence' in full && full.fence).toMatchObject({ id: 'hq', wake: ['al', 'ceo'], url: 'https://x/y', urlToken: 't', private: true, on: 'enter', note: 'n', expiresAt: 5_000_000_000_000 })
  })
})

const USERS: Record<string, Record<string, string | string[]>> = {
  yousef: { trust: 'owner' },
  nica: { allow: ['location', 'schedule'] },
  mai: { location: 'city', allow: ['wellbeing'] },
  sam: { allow: ['bedrock-guest-key-support'] },
  lucas: { allow: ['location:country'] },
}
const HOME_GEO: Record<number, ReverseGeo> = {
  3: { display: 'United Kingdom', address: { country: 'United Kingdom' } },
  10: { display: 'Reading, England, United Kingdom', address: { town: 'Reading', country: 'United Kingdom' } },
  14: { display: 'Katesgrove, Reading, England, United Kingdom', address: { suburb: 'Katesgrove', town: 'Reading', country: 'United Kingdom' } },
  18: { display: '15, Blakes Cottages, Katesgrove, Reading, RG1 3JA, United Kingdom', address: { house_number: '15', road: 'Blakes Cottages', suburb: 'Katesgrove', town: 'Reading', postcode: 'RG1 3JA', country: 'United Kingdom' } },
}
const LONDON_GEO: Record<number, ReverseGeo> = {
  3: { display: 'United Kingdom', address: { country: 'United Kingdom' } },
  10: { display: 'London', address: { city: 'London', country: 'United Kingdom' } },
  14: { display: 'Paddington, London', address: { suburb: 'Paddington', city: 'London', country: 'United Kingdom' } },
  18: { display: 'Praed Street, Paddington, London W2 1HU', address: { road: 'Praed Street', suburb: 'Paddington', city: 'London', postcode: 'W2 1HU', country: 'United Kingdom' } },
}
const fakeRevgeo = async (lat: number, _lon: number, zoom: number): Promise<ReverseGeo> => (lat > 51.5 ? LONDON_GEO : HOME_GEO)[zoom] ?? { display: null, address: {} }
const VENUES: Record<string, { name: string; address?: string; lat: number; lon: number }> = {
  'Paddington Station, London': { name: 'Paddington', address: 'Praed St, London W2 1HU', lat: 51.5154, lon: -0.1755 },
  'Reading Speakers Club, Orts Rd': { name: 'Reading Speakers Club', lat: HOME.lat + 0.001, lon: HOME.lon + 0.001 },
  'Sparrows Campsite, Froyz Hall, Pennypot Corner, Halstead CO9 1RS': { name: 'Sparrows Campsite', address: 'Froyz Hall, Halstead CO9 1RS', lat: 51.9685, lon: 0.6075 },
}
let EVENTS: CalEvent[] = []

describe('disclose: policy', () => {
  it('levelFor walks trust → location → allow → none', () => {
    expect(levelFor(USERS.yousef!)).toEqual({ level: 'exact', why: 'trust: owner' })
    expect(levelFor(USERS.nica!)).toEqual({ level: 'exact', why: 'allow: location' })
    expect(levelFor(USERS.mai!)).toEqual({ level: 'city', why: 'location: city' })
    expect(levelFor(USERS.lucas!)).toEqual({ level: 'country', why: 'allow: location:country' })
    expect(levelFor(USERS.sam!)).toEqual({ level: 'none', why: 'not in allow' })
    expect(levelFor(null)).toMatchObject({ level: 'none' })
    expect(levelFor({ location: 'exactly' })).toMatchObject({ level: 'none' }) // bad value ≠ a grant
  })
  it('placeWords per level, ageWords thresholds', () => {
    expect(placeWords(HOME_GEO[3]!.address, 'country')).toBe('in United Kingdom')
    expect(placeWords(HOME_GEO[10]!.address, 'city')).toBe('in Reading')
    expect(placeWords(HOME_GEO[14]!.address, 'area')).toBe('in Reading, around Katesgrove')
    expect(placeWords(HOME_GEO[18]!.address, 'exact')).toBe('15, Blakes Cottages, Katesgrove, Reading, RG1 3JA')
    expect(placeWords({}, 'city')).toBe('location unknown')
    expect(ageWords(120)).toBe('')
    expect(ageWords(1500)).toBe(' (as of 25 min ago)')
    expect(ageWords(7200)).toBe(' (last seen 2.0 h ago)')
    expect(ageWords(200_000)).toBe(' (last seen 2 d ago)')
  })
  const cur = (over: Partial<Parameters<typeof disclose>[1]> = {}) => ({ fix: at(0, 100), ageS: 60, inside: [], polledAt: 1, ...over })
  it('none refuses; no fix says so', async () => {
    expect(await disclose({ level: 'none', why: 'x' }, cur(), fakeRevgeo, [])).toMatchObject({ say: null })
    expect((await disclose({ level: 'exact', why: 'x' }, cur({ fix: null }), fakeRevgeo, [])).say).toMatch(/can't see/)
  })
  it('inside a private fence exact/area collapse to the fence name; city/country unaffected', async () => {
    const c = cur({ inside: [{ id: 'home', name: 'Home', private: true }] })
    expect((await disclose({ level: 'exact', why: 'x' }, c, fakeRevgeo, [])).say).toBe('At home (Reading).')
    expect((await disclose({ level: 'area', why: 'x' }, c, fakeRevgeo, [])).say).toBe('At home (Reading).')
    expect((await disclose({ level: 'city', why: 'x' }, c, fakeRevgeo, [])).say).toBe('Yousef is in Reading.')
    expect((await disclose({ level: 'country', why: 'x' }, c, fakeRevgeo, [])).say).toBe('Yousef is in United Kingdom.')
  })
  it('the censor backstop hides home even with no fence; away from home exact gives words + pin', async () => {
    const home = await disclose({ level: 'exact', why: 'x' }, cur(), fakeRevgeo, ['15 Blakes Cottages'])
    expect(home.say).toBe('At home (Reading).')
    expect(home.lat).toBeUndefined()
    const leak = await disclose({ level: 'exact', why: 'x' }, cur(), fakeRevgeo, [])
    expect(leak.say).toContain('Blakes Cottages') // no fence, no terms → nothing to collapse on (the live hub always has terms)
    const away = await disclose({ level: 'exact', why: 'x' }, cur({ fix: { lat: 51.5154, lon: -0.1755, tst: 100 }, ageS: 900 }), fakeRevgeo, ['15 Blakes Cottages'])
    expect(away.say).toBe('Praed Street, Paddington, London, W2 1HU (as of 15 min ago). Pin: https://maps.google.com/?q=51.51540,-0.17550')
    expect(away).toMatchObject({ lat: 51.5154, lon: -0.1755 })
    const named = await disclose({ level: 'area', why: 'x' }, cur({ fix: { lat: 51.5154, lon: -0.1755, tst: 100 }, inside: [{ id: 'office', name: 'Office', private: false }] }), fakeRevgeo, [])
    expect(named.say).toBe('Yousef is at Office, in London, around Paddington.')
  })
})

describe('late-check', () => {
  const T0 = Date.parse('2026-09-20T09:30:00Z')
  const ev = (over: Partial<CalEvent> = {}): CalEvent => ({ id: 'e1', summary: 'Meeting', location: 'Paddington Station, London', start: { dateTime: new Date(T0 + 15 * 60_000).toISOString() }, attendees: [{ email: 'me@x', self: true, responseStatus: 'accepted' }, { email: 'a@b' }], calendarId: 'cal', ...over })
  const ctx = (events: CalEvent[], durationSec = 73 * 60): LateCtx => ({
    listEvents: async () => events,
    geocode: async (q) => VENUES[q] ?? null,
    route: async () => ({ durationSec, distanceMeters: 64_500, description: 'M4' }),
  })
  it('reports a placed event he cannot reach in time, once, with attendees minus himself', async () => {
    const r1 = await lateCheck(ctx([ev()]), at(0, 1), 60, {}, { nowMs: T0 })
    expect(r1.reports).toHaveLength(1)
    expect(r1.reports[0]).toMatchObject({ eventId: 'e1', startsInMin: 15, etaMin: 73, lateMin: 58, attendees: ['a@b'], reAlert: false, distanceKm: 64.5 })
    expect(r1.state.e1).toMatchObject({ lateMin: 58 })
    const text = formatLateReport(r1.reports[0]!)
    expect(text).toContain('LATE: "Meeting" starts 10:45 (in 15 min) at Paddington Station, London')
    expect(text).toContain('about 58 min late')
    expect(text).toContain('Attendees: a@b')
    const r2 = await lateCheck(ctx([ev()]), at(0, 1), 60, r1.state, { nowMs: T0 })
    expect(r2.reports).toEqual([]) // de-duped
    const r3 = await lateCheck(ctx([ev()], 90 * 60), at(0, 1), 60, r1.state, { nowMs: T0 })
    expect(r3.reports[0]).toMatchObject({ lateMin: 75, reAlert: true }) // grew by ≥ threshold
  })
  it('skips virtual/home venues, declined, cancelled, all-day, past, unknown venues and on-time events', async () => {
    const events = [
      ev({ id: 'v', location: 'Zoom' }), ev({ id: 'h', location: 'Our nice living room' }), ev({ id: 'u', location: 'https://meet.google.com/x' }),
      ev({ id: 'd', attendees: [{ self: true, responseStatus: 'declined' }] }), ev({ id: 'c', status: 'cancelled' }),
      ev({ id: 'a', start: { date: '2026-09-20' } }), ev({ id: 'p', start: { dateTime: new Date(T0 - 60_000).toISOString() } }),
      ev({ id: 'g', location: 'Nowhere Specific' }),
      ev({ id: 'ok', start: { dateTime: new Date(T0 + 120 * 60_000).toISOString() } }),
    ]
    const r = await lateCheck(ctx(events), at(0, 1), 60, {}, { nowMs: T0 })
    expect(r.reports).toEqual([])
    expect(r.considered).toBe(2) // 'g' and 'ok' got as far as geocoding
    expect(VIRTUAL_RE.test('Reading Speakers Club, Orts Rd')).toBe(false)
  })
  it('already at the venue clears its state; no/stale fix evaluates nothing', async () => {
    const r = await lateCheck(ctx([ev({ location: 'Reading Speakers Club, Orts Rd' })]), at(0, 1), 60, { e1: { lateMin: 20, at: 'x' } }, { nowMs: T0 })
    expect(r.reports).toEqual([])
    expect(r.state.e1).toBeUndefined()
    expect(await lateCheck(ctx([ev()]), null, null, {}, { nowMs: T0 })).toMatchObject({ skipped: 'no fix' })
    expect(await lateCheck(ctx([ev()]), at(0, 1), 3600, {}, { nowMs: T0 })).toMatchObject({ skipped: 'stale fix' })
  })

  // The real event that fired "13 min late" at 06:25 on 2026-09-25: its location is
  // the DESTINATION and its start is the DEPARTURE time, so arrival-vs-start is meaningless.
  const WILDING: CalEvent = {
    id: 'g0slpk3684ug6l0f16nbqtc238',
    summary: 'Drive to Wilding Camp (Reading → Halstead)',
    location: 'Sparrows Campsite, Froyz Hall, Pennypot Corner, Halstead CO9 1RS',
    start: { dateTime: '2026-09-25T08:00:00+01:00', timeZone: 'Europe/London' },
    end: { dateTime: '2026-09-25T11:00:00+01:00', timeZone: 'Europe/London' },
    status: 'confirmed',
    attendees: null,
    calendarId: 'yousefamar@gmail.com',
  }
  const bst = (hhmm: string) => Date.parse(`2026-09-25T${hhmm}:00+01:00`)
  const drive = (events: CalEvent[]) => ctx(events, 108 * 60) // 1 h 48 by road: "arrives" 08:13 from a 06:25 fix

  it('travel block (Wilding Camp): no arrival alert before departure; NOT LEFT once the start has passed with him still at the origin', async () => {
    const home = at(0, 1)
    const r1 = await lateCheck(drive([WILDING]), home, 60, {}, { nowMs: bst('06:25') })
    expect(r1.reports).toEqual([]) // the 06:25 false alarm
    expect(r1.considered).toBe(1)
    expect(r1.state[WILDING.id]).toMatchObject({ travel: true, origin: { lat: home.lat, lon: home.lon } })
    const r2 = await lateCheck(drive([WILDING]), home, 60, r1.state, { nowMs: bst('08:05') })
    expect(r2.reports).toEqual([]) // 5 min behind departure: within threshold
    const r3 = await lateCheck(drive([WILDING]), home, 60, r2.state, { nowMs: bst('08:13') })
    expect(r3.reports).toHaveLength(1)
    expect(r3.reports[0]).toMatchObject({ kind: 'not-left', eventId: WILDING.id, lateMin: 13, startsInMin: -13, etaMin: 108, distanceKm: 64.5, endIso: WILDING.end!.dateTime, attendees: [], reAlert: false })
    expect(r3.reports[0]!.venue).toMatchObject({ name: 'Sparrows Campsite' })
    const text = formatLateReport(r3.reports[0]!)
    expect(text).toContain('NOT LEFT: "Drive to Wilding Camp (Reading → Halstead)" was due to leave 08:00, 13 min ago')
    expect(text).toContain('heading for Sparrows Campsite, Froyz Hall')
    expect(text).toContain('Drive ETA 108 min (64.5 km) → arrives ~10:01, block ends 11:00')
    const r4 = await lateCheck(drive([WILDING]), home, 60, r3.state, { nowMs: bst('08:18') })
    expect(r4.reports).toEqual([]) // de-duped until another threshold has passed
    const r5 = await lateCheck(drive([WILDING]), home, 60, r4.state, { nowMs: bst('08:24') })
    expect(r5.reports[0]).toMatchObject({ kind: 'not-left', lateMin: 24, reAlert: true })
    expect(formatLateReport(r5.reports[0]!)).toContain('(re-alert: still there)')
    // On the road: 1 km from the origin ends the check for good, however slow the drive.
    const r6 = await lateCheck(drive([WILDING]), at(1000, 1), 60, r5.state, { nowMs: bst('08:30') })
    expect(r6.reports).toEqual([])
    expect(r6.state[WILDING.id]).toMatchObject({ departed: true })
    const r7 = await lateCheck(drive([WILDING]), at(1000, 1), 60, r6.state, { nowMs: bst('09:30') })
    expect(r7.reports).toEqual([])
  })
  it('travel block: he left on time, or was never seen before departure, or is already at the destination', async () => {
    const home = at(0, 1)
    const pre = await lateCheck(drive([WILDING]), home, 60, {}, { nowMs: bst('07:55') })
    const gone = await lateCheck(drive([WILDING]), at(2000, 1), 60, pre.state, { nowMs: bst('08:12') })
    expect(gone.reports).toEqual([])
    expect(gone.state[WILDING.id]).toMatchObject({ departed: true })
    // Hub was down before 08:00: the first post-departure fix becomes the origin, judged from the next tick on.
    const first = await lateCheck(drive([WILDING]), home, 60, {}, { nowMs: bst('08:12') })
    expect(first.reports).toEqual([])
    expect(first.state[WILDING.id]).toMatchObject({ travel: true, origin: { lat: home.lat, lon: home.lon } })
    const second = await lateCheck(drive([WILDING]), home, 60, first.state, { nowMs: bst('08:17') })
    expect(second.reports[0]).toMatchObject({ kind: 'not-left', lateMin: 17 })
    // Drove up the night before: sitting at the campsite is not "not left".
    const camp = VENUES['Sparrows Campsite, Froyz Hall, Pennypot Corner, Halstead CO9 1RS']!
    const there: Fix = { lat: camp.lat, lon: camp.lon, tst: 1, acc: 12 }
    const t1 = await lateCheck(drive([WILDING]), there, 60, {}, { nowMs: bst('07:50') })
    const t2 = await lateCheck(drive([WILDING]), there, 60, t1.state, { nowMs: bst('08:15') })
    expect(t2.reports).toEqual([])
    expect(t2.state[WILDING.id]).toMatchObject({ departed: true })
    // Destination the geocoder does not know: still reported, without a route line.
    const unknown = await lateCheck(drive([{ ...WILDING, location: 'Somewhere Google has never heard of' }]), home, 60, first.state, { nowMs: bst('08:17') })
    expect(unknown.reports[0]).toMatchObject({ kind: 'not-left', lateMin: 17, etaMin: undefined })
    expect(formatLateReport(unknown.reports[0]!)).toContain('No route: destination could not be geocoded')
  })
  it('travel by title: verb … to, or an arrow; a bare place name is a meeting', () => {
    for (const t of ['Drive to Wilding Camp (Reading → Halstead)', 'Train to London', 'Flight to Cairo (MS786)', 'Walk to the station', 'Cycle to work', 'Reading → Halstead', 'LHR -> CAI', 'Travelling to Bristol', 'Flight from LHR to CAI']) expect(TRAVEL_RE.test(t), t).toBe(true)
    for (const t of ['Meeting', 'Wilding Camp: Autumn Equinox', 'Talk to Sam about the drive', 'Dentist', 'Trip', 'Drive-in cinema', 'Tokyo Drift', 'Coffee with Tom']) expect(TRAVEL_RE.test(t), t).toBe(false)
  })
  it('travel by duration: a solo event as long as the route is a travel block; with others invited, or a different length, it is a meeting', async () => {
    const solo = ev({ id: 's', summary: 'Halstead', attendees: [{ email: 'me@x', self: true }], end: { dateTime: new Date(T0 + (15 + 73) * 60_000).toISOString() } })
    const rs = await lateCheck(ctx([solo]), at(0, 1), 60, {}, { nowMs: T0 })
    expect(rs.reports).toEqual([])
    expect(rs.state.s).toMatchObject({ travel: true, origin: { lat: HOME.lat } })
    const near = await lateCheck(ctx([solo], 85 * 60), at(0, 1), 60, {}, { nowMs: T0 }) // 73 min block vs 85 min route: within 20 %
    expect(near.state.s).toMatchObject({ travel: true })
    const padded = ev({ id: 'p', summary: 'Halstead', attendees: [{ email: 'me@x', self: true }], end: { dateTime: new Date(T0 + (15 + 100) * 60_000).toISOString() } })
    expect((await lateCheck(ctx([padded]), at(0, 1), 60, {}, { nowMs: T0 })).reports[0]).toMatchObject({ kind: 'late', eventId: 'p', lateMin: 58 })
    const withOthers = ev({ id: 'o', summary: 'Halstead', end: { dateTime: new Date(T0 + (15 + 73) * 60_000).toISOString() } })
    expect((await lateCheck(ctx([withOthers]), at(0, 1), 60, {}, { nowMs: T0 })).reports[0]).toMatchObject({ kind: 'late', eventId: 'o', attendees: ['a@b'] })
    // The classification sticks: once the start has passed, the post-departure tick needs no route.
    const stuck = await lateCheck(ctx([solo]), at(0, 1), 60, rs.state, { nowMs: T0 + 30 * 60_000 })
    expect(stuck.reports[0]).toMatchObject({ kind: 'not-left', eventId: 's', lateMin: 15 })
  })
  it('state for events no longer listed is dropped', async () => {
    const r = await lateCheck(ctx([ev()]), at(0, 1), 60, { gone: { lateMin: 20, at: 'x' }, e1: { lateMin: 58, at: 'x' } }, { nowMs: T0 })
    expect(r.state.gone).toBeUndefined()
    expect(r.state.e1).toMatchObject({ lateMin: 58 })
  })
})

describe('routes: over HTTP', () => {
  let server: Server
  let base: string
  let h: Harness
  const readBody = (req: import('node:http').IncomingMessage) => new Promise<string>((resolve) => { let s = ''; req.on('data', (c: Buffer) => { s += c }); req.on('end', () => resolve(s)) })

  beforeEach(async () => {
    h = harness([at(0, 9_940)]) // 60 s before the harness clock (10_000_000 ms)
    const ctx: LocationRouteCtx = {
      store: h.store, watcher: h.watcher,
      agentLive: (k) => h.live.has(k),
      actorOf: (req) => (req.headers['x-console-agent'] as string | undefined) || undefined,
      userFrontmatter: (slug) => USERS[slug] ?? null,
      revgeo: fakeRevgeo,
      blockedTerms: () => ['15 blakes cottages'],
      lateStateFile: join(dir, 'late.json'),
      geocode: async (q) => VENUES[q] ?? null,
      route: async (o, d) => ({ durationSec: Math.round(haversineM(o.lat, o.lon, d.lat, d.lon) / 10), distanceMeters: Math.round(haversineM(o.lat, o.lon, d.lat, d.lon)) }),
      listEvents: async () => EVENTS.slice(),
    }
    server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x')
      if (!handleLocationRoutes(req, res, url.pathname, url, ctx, readBody)) { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))
  afterAll(() => { /* dirs removed per test */ })

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: (await res.json()) as any }
  }

  it('GET /location polls on first call and reports the fix + fences inside', async () => {
    const r = await call('GET', '/location')
    expect(r.status).toBe(200)
    expect(r.json.fix).toMatchObject({ tst: 9_940 })
    expect(r.json.ageS).toBe(60)
    expect(r.json.inside).toEqual([])
    expect(r.json.polledAt).toBe(10_000_000)
  })
  it('POST /location/geofences creates (201), initialises from the last fix, upserts (200), lists with state, DELETEs', async () => {
    const c = await call('POST', '/location/geofences', { name: 'Home', lat: HOME.lat, lon: HOME.lon, radius: 150, private: true, urlToken: 'x' }, { 'x-console-agent': 'al' })
    expect(c.status).toBe(201)
    expect(c.json.fence).toMatchObject({ id: 'home', private: true, createdBy: 'al', urlToken: '<set>', state: { inside: true }, wakeLive: [{ key: 'al', live: true }] })
    expect(h.delivered).toEqual([]) // silent init
    const again = await call('POST', '/location/geofences', { id: 'home', name: 'Home', lat: HOME.lat, lon: HOME.lon, radius: 150, private: true })
    expect(again.status).toBe(200)
    expect(again.json.created).toBe(false)
    const bad = await call('POST', '/location/geofences', { name: 'x', lat: 0, lon: 0, radius: 1 })
    expect(bad.status).toBe(400)
    const list = await call('GET', '/location/geofences')
    expect(list.json.fences).toHaveLength(1)
    const now = await call('GET', '/location')
    expect(now.json.inside).toEqual([{ id: 'home', name: 'Home', private: true }])
    const t = await call('POST', '/location/geofences/home/test', { event: 'leave' })
    expect(t.status).toBe(200)
    expect(t.json.event).toMatchObject({ test: true, event: 'leave' })
    expect(h.delivered).toHaveLength(1)
    const evs = await call('GET', '/location/events?fence=home')
    expect(evs.json.events).toHaveLength(1)
    expect((await call('POST', '/location/geofences/nope/test', {})).status).toBe(404)
    expect((await call('DELETE', '/location/geofences/home')).status).toBe(200)
    expect((await call('DELETE', '/location/geofences/home')).status).toBe(404)
    expect(existsSync(join(dir, 'geofences.json'))).toBe(true)
  })
  it('POST /location/refresh re-polls', async () => {
    h.fixes.splice(0, 1, at(500, 900))
    const r = await call('POST', '/location/refresh')
    expect(r.json.fix.tst).toBe(900)
  })
  it('GET /location/for/<slug> applies the policy hub-side', async () => {
    expect((await call('GET', '/location/for/mai')).json).toMatchObject({ user: 'mai', level: 'city', say: 'Yousef is in Reading.' })
    expect((await call('GET', '/location/for/sam')).json).toMatchObject({ level: 'none', say: null })
    expect((await call('GET', '/location/for/nobody')).json).toMatchObject({ level: 'none', why: 'unknown sender (no user file)' })
    expect((await call('GET', '/location/for/nica')).json).toMatchObject({ level: 'exact', say: 'At home (Reading).' }) // censor backstop
    expect((await call('GET', '/location/for/..%2Fetc')).status).toBe(400)
  })
  it('GET /location/eta geocodes + routes from the current fix', async () => {
    const r = await call('GET', '/location/eta?to=' + encodeURIComponent('Paddington Station, London'))
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ mode: 'DRIVE', to: { name: 'Paddington' } })
    expect(r.json.durationSec).toBeGreaterThan(5000)
    expect((await call('GET', '/location/eta?to=Nowhere')).status).toBe(404)
    expect((await call('GET', '/location/eta')).status).toBe(400)
    expect((await call('GET', '/location/eta?to=x&mode=TELEPORT')).status).toBe(400)
  })
  it('GET /location/late-check persists de-dup state', async () => {
    EVENTS = [{ id: 'e9', summary: 'Trip', location: 'Paddington Station, London', start: { dateTime: new Date(Date.now() + 15 * 60_000).toISOString() }, attendees: [{ email: 'a@b' }] }]
    const r1 = await call('GET', '/location/late-check?threshold=10')
    expect(r1.json.late).toHaveLength(1)
    expect(r1.json.late[0]).toMatchObject({ eventId: 'e9', attendees: ['a@b'] })
    expect(JSON.parse(readFileSync(join(dir, 'late.json'), 'utf8'))).toHaveProperty('e9')
    const r2 = await call('GET', '/location/late-check?threshold=10')
    expect(r2.json.late).toEqual([])
    expect((await call('GET', '/location/late-check?threshold=-1')).status).toBe(400)
    EVENTS = []
  })
})
