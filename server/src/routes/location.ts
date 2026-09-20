// Location + geofences.
//
//   GET    /location                      latest fix, its age, the fences it is inside
//   POST   /location/refresh              poll the Recorder now, then as GET /location
//   GET    /location/geofences            every fence with its inside/outside state
//   POST   /location/geofences            upsert {id?, name, lat, lon, radius, wake?, url?,
//                                         urlToken?, private?, on?, expiresAt?, note?}
//   DELETE /location/geofences/<id>
//   POST   /location/geofences/<id>/test  {event?: enter|leave} — synthetic transition
//                                         through the real wake/POST pipeline
//   GET    /location/events[?limit&fence] transitions, newest first
//
// The raw Recorder proxy (`/owntracks/*`) stays for history browsing; this is
// the interpreted layer agents talk to.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { slugify, type FenceTrigger, type Geofence } from '../location/geofence.js'
import type { GeofenceStore } from '../location/store.js'
import type { LocationWatcher } from '../location/watcher.js'

export interface LocationRouteCtx {
  store: GeofenceStore
  watcher: LocationWatcher
  /** Is the session with this agentKey live right now? */
  agentLive: (agentKey: string) => boolean
  /** Actor from X-Console-Agent, for createdBy. */
  actorOf: (req: IncomingMessage) => string | undefined
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
      const view = fencesView(ctx).find((f) => f.id === fence.id)
      send(res, existed ? 200 : 201, { fence: view, created: !existed })
    })
  }

  const m = /^\/location\/geofences\/([^/]+)(\/test)?$/.exec(path)
  if (m) {
    const id = decodeURIComponent(m[1]!)
    if (!m[2] && req.method === 'DELETE') {
      if (!ctx.store.remove(id)) { send(res, 404, { error: `no fence "${id}"` }); return true }
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

  if (path === '/location/events' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
    send(res, 200, { events: ctx.store.events({ limit, fenceId: url.searchParams.get('fence') }) })
    return true
  }

  return false
}
