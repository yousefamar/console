import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { evaluate, haversineM, leaveMarginM, fixTooCoarse, buildGeofenceEnvelope, slugify, fencesContaining, type Fix, type Geofence } from '../location/geofence.js'
import { GeofenceStore } from '../location/store.js'
import { LocationWatcher } from '../location/watcher.js'
import { fixFromRecorder } from '../location/recorder.js'
import { handleLocationRoutes, parseFenceBody, type LocationRouteCtx } from '../routes/location.js'

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
    const edge = evaluate([fence()], s0, at(170, 200)) // 150 + 30 margin = 180
    expect(edge.events).toEqual([])
    expect(edge.state.home!.inside).toBe(true)
    const out = evaluate([fence()], edge.state, at(190, 300))
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

describe('routes: over HTTP', () => {
  let server: Server
  let base: string
  let h: Harness
  const readBody = (req: import('node:http').IncomingMessage) => new Promise<string>((resolve) => { let s = ''; req.on('data', (c: Buffer) => { s += c }); req.on('end', () => resolve(s)) })

  beforeEach(async () => {
    h = harness([at(0, 100)])
    const ctx: LocationRouteCtx = {
      store: h.store, watcher: h.watcher,
      agentLive: (k) => h.live.has(k),
      actorOf: (req) => (req.headers['x-console-agent'] as string | undefined) || undefined,
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
    expect(r.json.fix).toMatchObject({ tst: 100 })
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
})
