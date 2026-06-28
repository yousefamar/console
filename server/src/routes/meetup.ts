// Meetup events routes — hub-side over the anonymous web GraphQL endpoint.
//
//   GET  /meetup/status                 daily request budget + cached-event count + lastFetch
//   POST /meetup/fetch-area             { bbox:[s,w,n,e] | lat,lon,radiusMiles } + filters
//   GET  /meetup/events                 summary snapshot (all stored, upcoming, events)
//   GET  /meetup/event/<id>             full detail (lazy-loaded + cached)
//
// All Meetup network access is rate-limited inside the client. Fetches are
// manual (this route), never scheduled — we don't background-poll Meetup.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MeetupClient, MeetupFetchOpts } from '../meetup/client.js'
import type { MeetupEventType } from '../meetup/types.js'

function fail(res: ServerResponse, err: unknown): void {
  const e = err as Error
  const status =
    e.name === 'RateLimitExceededError' ? 429 : e.name === 'MeetupError' ? 502 : 500
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: e.message, kind: e.name }))
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Centre + radius (miles) from a [s,w,n,e] bounding box. */
function centerRadiusFromBbox(bbox: [number, number, number, number]): { lat: number; lon: number; radiusMiles: number } {
  const [s, w, n, e] = bbox
  const lat = (s + n) / 2
  const lon = (w + e) / 2
  const latMi = ((n - s) / 2) * 69
  const lonMi = ((e - w) / 2) * 69 * Math.cos((lat * Math.PI) / 180)
  return { lat, lon, radiusMiles: Math.min(100, Math.max(1, Math.hypot(latMi, lonMi))) }
}

function normType(v: unknown): MeetupEventType | undefined {
  const s = String(v ?? '').toUpperCase()
  return s === 'PHYSICAL' || s === 'ONLINE' || s === 'HYBRID' ? (s as MeetupEventType) : undefined
}

export function handleMeetupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  client: MeetupClient,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/meetup')) return false

  if (path === '/meetup/status' && req.method === 'GET') {
    json(res, client.getStatus())
    return true
  }

  if (path === '/meetup/fetch-area' && req.method === 'POST') {
    readBody(req)
      .then(async (body) => {
        const b = JSON.parse(body || '{}') as {
          bbox?: [number, number, number, number]
          lat?: number
          lon?: number
          radiusMiles?: number
          radius?: number
          query?: string
          type?: string
          eventType?: string
          days?: number
          startDate?: string
          endDate?: string
          categoryId?: string
          maxPages?: number
          pages?: number
        }
        let center: { lat: number; lon: number; radiusMiles: number }
        if (Array.isArray(b.bbox) && b.bbox.length === 4) {
          center = centerRadiusFromBbox(b.bbox)
        } else if (typeof b.lat === 'number' && typeof b.lon === 'number') {
          center = { lat: b.lat, lon: b.lon, radiusMiles: b.radiusMiles ?? b.radius ?? 10 }
        } else {
          throw new Error('fetch-area requires { bbox } or { lat, lon, radiusMiles }')
        }
        const opts: MeetupFetchOpts = {
          lat: center.lat,
          lon: center.lon,
          radiusMiles: center.radiusMiles,
          query: b.query,
          eventType: normType(b.type ?? b.eventType),
          categoryId: b.categoryId,
          maxPages: b.maxPages ?? b.pages,
        }
        if (b.startDate) opts.startDate = b.startDate
        if (typeof b.days === 'number' && b.days > 0) {
          opts.startDate = opts.startDate ?? new Date().toISOString()
          opts.endDate = new Date(Date.now() + b.days * 86_400_000).toISOString()
        }
        if (b.endDate) opts.endDate = b.endDate
        const result = await client.fetchArea(opts)
        json(res, result)
      })
      .catch((err) => fail(res, err))
    return true
  }

  if (path === '/meetup/events' && req.method === 'GET') {
    json(res, client.getSnapshot())
    return true
  }

  const eventMatch = /^\/meetup\/event\/([A-Za-z0-9!-]+)$/.exec(path)
  if (eventMatch && req.method === 'GET') {
    client
      .getEventDetail(eventMatch[1])
      .then((ev) => {
        if (!ev) {
          json(res, { error: 'event not found', kind: 'NotFound' }, 404)
        } else {
          json(res, ev)
        }
      })
      .catch((err) => fail(res, err))
    return true
  }

  return false
}
