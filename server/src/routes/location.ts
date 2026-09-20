// Location + geofences.
//
//   GET    /location                      latest fix, its age, the fences it is inside
//   POST   /location/refresh              poll the Recorder now, then as GET /location
//   GET    /location/geofences            every fence with its inside/outside state
//   GET    /location/map                  what the Map tab draws: fix, fences with
//                                         state, live-feed health (SyncBus 'location'
//                                         pushes the same as fix/fences/feed events)
//   POST   /location/geofences            upsert {id?, name, lat, lon, radius, wake?, url?,
//                                         urlToken?, private?, on?, expiresAt?, note?}
//   DELETE /location/geofences/<id>
//   POST   /location/geofences/<id>/test  {event?: enter|leave} — synthetic transition
//                                         through the real wake/POST pipeline
//   POST   /location/replay               {from?, to?, fence?, device?} — dry run:
//                                         the transitions the fences WOULD have
//                                         fired over Recorder history; no state
//                                         change, nobody woken (default: last 7 d)
//   GET    /location/events[?limit&fence] transitions, newest first
//   GET    /location/for/<user-slug>      the disclosure that person may hear
//                                         {level, why, say|null, note} — policy
//                                         from users/<slug>.md, applied HERE
//   GET    /location/eta?to=<place>[&mode] traffic-aware ETA from the current fix
//   GET    /location/late-check[?threshold&window&mode]
//                                         upcoming placed events he will be late
//                                         for; de-duped per event (state file)
//
// The raw Recorder proxy (`/owntracks/*`) stays for history browsing; this is
// the interpreted layer agents talk to.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { slugify, type FenceTrigger, type Geofence } from '../location/geofence.js'
import type { GeofenceStore } from '../location/store.js'
import type { LocationWatcher } from '../location/watcher.js'
import { disclose, levelFor, type ReverseGeocoder } from '../location/disclose.js'
import { lateCheck, type LateCtx, type LateState, type TravelMode } from '../location/late.js'

export interface LocationRouteCtx extends LateCtx {
  store: GeofenceStore
  watcher: LocationWatcher
  /** Is the session with this agentKey live right now? */
  agentLive: (agentKey: string) => boolean
  /** Actor from X-Console-Agent, for createdBy. */
  actorOf: (req: IncomingMessage) => string | undefined
  /** Parsed frontmatter of AL's users/<slug>.md, null when no such user. */
  userFrontmatter: (slug: string) => Record<string, string | string[]> | null
  revgeo: ReverseGeocoder
  /** The WhatsApp send censor's terms (his address) — the home backstop. */
  blockedTerms: () => string[]
  /** Where late-check keeps its per-event de-dup state. */
  lateStateFile: string
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const MODES = new Set<TravelMode>(['DRIVE', 'WALK', 'BICYCLE', 'TRANSIT'])

function readLateState(file: string): LateState {
  try { return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LateState) : {} } catch { return {} }
}

function writeLateState(file: string, state: LateState): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state))
  renameSync(tmp, file)
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
const TRIGGERS = new Set<FenceTrigger>(['enter', 'leave', 'both'])

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function fencesView(ctx: LocationRouteCtx) {
  const state = ctx.store.state()
  return ctx.store.fences().map((f) => ({
    ...f,
    urlToken: f.urlToken ? '<set>' : undefined,
    state: state[f.id] ?? null,
    wakeLive: f.wake.map((k) => ({ key: k, live: ctx.agentLive(k) })),
  }))
}

export function parseFenceBody(raw: string, actor: string | undefined, nowMs: number): { fence: Geofence } | { error: string } {
  let body: Record<string, unknown>
  try { body = JSON.parse(raw || '{}') as Record<string, unknown> } catch { return { error: 'body must be JSON' } }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { error: 'name required' }
  const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim().toLowerCase() : slugify(name)
  if (!ID_RE.test(id)) return { error: 'id must be lowercase letters, digits and hyphens (max 40)' }
  const lat = Number(body.lat), lon = Number(body.lon), radius = Number(body.radius)
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: 'lat must be -90..90' }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { error: 'lon must be -180..180' }
  if (!Number.isFinite(radius) || radius < 10 || radius > 500_000) return { error: 'radius must be 10..500000 metres' }
  const wakeRaw = body.wake
  const wake = Array.isArray(wakeRaw) ? wakeRaw.map(String).map((s) => s.trim()).filter(Boolean)
    : typeof wakeRaw === 'string' ? wakeRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : ['al']
  const on = (typeof body.on === 'string' ? body.on : 'both') as FenceTrigger
  if (!TRIGGERS.has(on)) return { error: 'on must be enter, leave or both' }
  const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined
  if (url && !/^https?:\/\//.test(url)) return { error: 'url must be http(s)' }
  let expiresAt: number | undefined
  if (body.expiresAt != null && body.expiresAt !== '') {
    const t = typeof body.expiresAt === 'number' ? body.expiresAt : Date.parse(String(body.expiresAt))
    if (!Number.isFinite(t)) return { error: 'expiresAt must be epoch ms or an ISO datetime' }
    if (t <= nowMs) return { error: 'expiresAt is in the past' }
    expiresAt = t
  }
  const fence: Geofence = { id, name, lat, lon, radius, wake, on, createdAt: nowMs }
  if (url) fence.url = url
  if (typeof body.urlToken === 'string' && body.urlToken) fence.urlToken = body.urlToken
  if (body.private === true) fence.private = true
  if (typeof body.note === 'string' && body.note.trim()) fence.note = body.note.trim()
  if (expiresAt) fence.expiresAt = expiresAt
  if (actor) fence.createdBy = actor
  return { fence }
}

export function handleLocationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: LocationRouteCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path !== '/location' && !path.startsWith('/location/')) return false
  const run = (fn: () => Promise<void>) => {
    fn().catch((err: unknown) => { if (!res.headersSent) send(res, 500, { error: (err as Error).message }) })
    return true
  }

  if (path === '/location' && req.method === 'GET') {
    return run(async () => {
      if (!ctx.watcher.current().fix) await ctx.watcher.tick()
      send(res, 200, { ...ctx.watcher.current(), ...ctx.watcher.status() })
    })
  }

  if (path === '/location/refresh' && req.method === 'POST') {
    return run(async () => {
      await ctx.watcher.tick()
      send(res, 200, { ...ctx.watcher.current(), ...ctx.watcher.status() })
    })
  }

  if (path === '/location/geofences' && req.method === 'GET') {
    send(res, 200, { fences: fencesView(ctx) })
    return true
  }

  if (path === '/location/map' && req.method === 'GET') {
    const state = ctx.store.state()
    send(res, 200, {
      ...ctx.watcher.current(),
      live: ctx.watcher.status().live,
      fences: ctx.store.fences().map((f) => ({ id: f.id, name: f.name, lat: f.lat, lon: f.lon, radius: f.radius, private: !!f.private, note: f.note ?? null, wake: f.wake, expiresAt: f.expiresAt ?? null, state: state[f.id] ?? null })),
    })
    return true
  }

  if (path === '/location/geofences' && req.method === 'POST') {
    return run(async () => {
      const parsed = parseFenceBody(await readBody(req), ctx.actorOf(req), Date.now())
      if ('error' in parsed) return send(res, 400, { error: parsed.error })
      const existed = !!ctx.store.fence(parsed.fence.id)
      const fence = ctx.store.upsert(parsed.fence)
      // initialise its state from the last known fix, silently (poll first if none yet)
      const fix = ctx.store.lastFix()
      if (fix) await ctx.watcher.applyFix(fix)
      else await ctx.watcher.tick()
      ctx.watcher.fencesChanged()
      const view = fencesView(ctx).find((f) => f.id === fence.id)
      send(res, existed ? 200 : 201, { fence: view, created: !existed })
    })
  }

  const m = /^\/location\/geofences\/([^/]+)(\/test)?$/.exec(path)
  if (m) {
    const id = decodeURIComponent(m[1]!)
    if (!m[2] && req.method === 'DELETE') {
      if (!ctx.store.remove(id)) { send(res, 404, { error: `no fence "${id}"` }); return true }
      ctx.watcher.fencesChanged()
      send(res, 200, { removed: id })
      return true
    }
    if (m[2] && req.method === 'POST') {
      return run(async () => {
        const body = JSON.parse((await readBody(req)) || '{}') as { event?: string }
        const event = body.event === 'leave' ? 'leave' : 'enter'
        const ev = await ctx.watcher.test(id, event)
        if (!ev) return send(res, 404, { error: `no fence "${id}"` })
        send(res, 200, { event: ev })
      })
    }
  }

  if (path === '/location/replay' && req.method === 'POST') {
    return run(async () => {
      const body = JSON.parse((await readBody(req)) || '{}') as { from?: string | number; to?: string | number; fence?: string; device?: string; user?: string }
      const parseT = (v: string | number | undefined, fallback: number): number | null => {
        if (v == null || v === '') return fallback
        if (typeof v === 'number') return v > 1e11 ? Math.round(v / 1000) : v
        if (/^\d+$/.test(v)) return parseT(Number(v), fallback)
        const t = Date.parse(v)
        return Number.isFinite(t) ? Math.round(t / 1000) : null
      }
      const nowTst = Math.round(Date.now() / 1000)
      const to = parseT(body.to, nowTst)
      const from = parseT(body.from, nowTst - 7 * 86400)
      if (from == null || to == null) return send(res, 400, { error: 'from/to must be ISO datetimes or unix seconds' })
      if (to <= from) return send(res, 400, { error: 'to must be after from' })
      if (to - from > 92 * 86400) return send(res, 400, { error: 'window must be 92 days or less' })
      if (body.fence && !ctx.store.fence(body.fence)) return send(res, 404, { error: `no fence "${body.fence}"` })
      const devices = body.device ? [{ user: body.user ?? 'amar', device: body.device }] : undefined
      send(res, 200, await ctx.watcher.dryReplay(from, to, { fenceId: body.fence, devices }))
    })
  }

  if (path === '/location/events' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
    send(res, 200, { events: ctx.store.events({ limit, fenceId: url.searchParams.get('fence') }) })
    return true
  }

  const forMatch = /^\/location\/for\/([^/]+)$/.exec(path)
  if (forMatch && req.method === 'GET') {
    return run(async () => {
      const slug = decodeURIComponent(forMatch[1]!)
      if (!SLUG_RE.test(slug)) return send(res, 400, { error: 'bad user slug' })
      if (!ctx.watcher.current().fix) await ctx.watcher.tick()
      const policy = levelFor(ctx.userFrontmatter(slug))
      const d = await disclose(policy, ctx.watcher.current(), ctx.revgeo, ctx.blockedTerms())
      send(res, 200, { user: slug, ...d })
    })
  }

  if (path === '/location/eta' && req.method === 'GET') {
    return run(async () => {
      const to = url.searchParams.get('to')?.trim()
      if (!to) return send(res, 400, { error: 'to (place) required' })
      const modeRaw = (url.searchParams.get('mode') ?? 'DRIVE').toUpperCase() as TravelMode
      if (!MODES.has(modeRaw)) return send(res, 400, { error: 'mode must be DRIVE, WALK, BICYCLE or TRANSIT' })
      if (!ctx.watcher.current().fix) await ctx.watcher.tick()
      const cur = ctx.watcher.current()
      if (!cur.fix) return send(res, 503, { error: 'no current fix' })
      const venue = await ctx.geocode(to, cur.fix)
      if (!venue) return send(res, 404, { error: `nothing found for "${to}"` })
      const r = await ctx.route(cur.fix, venue, modeRaw)
      if (!r) return send(res, 404, { error: 'no route' })
      const now = Date.now()
      send(res, 200, { from: { lat: cur.fix.lat, lon: cur.fix.lon, ageS: cur.ageS }, to: venue, mode: modeRaw, durationSec: r.durationSec, distanceMeters: r.distanceMeters, description: r.description ?? null, arriveAt: new Date(now + r.durationSec * 1000).toISOString() })
    })
  }

  if (path === '/location/late-check' && req.method === 'GET') {
    return run(async () => {
      const threshold = Number(url.searchParams.get('threshold') ?? 10)
      const window = Number(url.searchParams.get('window') ?? 180)
      const modeRaw = (url.searchParams.get('mode') ?? 'DRIVE').toUpperCase() as TravelMode
      if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(window) || window <= 0) return send(res, 400, { error: 'threshold ≥ 0 and window > 0 (minutes)' })
      if (!MODES.has(modeRaw)) return send(res, 400, { error: 'mode must be DRIVE, WALK, BICYCLE or TRANSIT' })
      if (!ctx.watcher.current().fix) await ctx.watcher.tick()
      const cur = ctx.watcher.current()
      const result = await lateCheck(ctx, cur.fix, cur.ageS, readLateState(ctx.lateStateFile), { thresholdMin: threshold, windowMin: window, mode: modeRaw })
      writeLateState(ctx.lateStateFile, result.state)
      send(res, 200, { late: result.reports, considered: result.considered, skipped: result.skipped ?? null, thresholdMin: threshold, windowMin: window, mode: modeRaw })
    })
  }

  return false
}
