// Geocaching.com routes — the hub-side API over the pycaching port.
//
//   GET  /geocaching/status                    login state + daily budget + cache count
//   POST /geocaching/credentials               { username, password } | { cookie }
//   POST /geocaching/fetch-area                { bbox:[s,w,n,e], max? } | { lat, lon, radiusKm, max? }
//   GET  /geocaching/caches                    summary snapshot (all stored caches)
//   GET  /geocaching/cache/<code>              full detail (lazy-loaded + cached)
//   GET  /geocaching/cache/<code>/logs         recent logs for one cache
//
// All gc.com network access is rate-limited inside the client. Fetches are
// manual (this route), never scheduled.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GeocachingClient } from '../geocaching/client.js'
import type { BBox } from '../geocaching/types.js'

function fail(res: ServerResponse, err: unknown): void {
  const e = err as Error
  const status =
    e.name === 'CaptchaRequiredError' || e.name === 'LoginFailedError' || e.name === 'GeocachingAuthError'
      ? 400
      : e.name === 'RateLimitExceededError'
        ? 429
        : 500
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: e.message, kind: e.name }))
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Approximate bounding box around a centre point + radius (km). */
function bboxFromRadius(lat: number, lon: number, radiusKm: number): BBox {
  const dLat = radiusKm / 111
  const dLon = radiusKm / (111 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon]
}

export function handleGeocachingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  client: GeocachingClient,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/geocaching')) return false

  if (path === '/geocaching/status' && req.method === 'GET') {
    json(res, client.getStatus())
    return true
  }

  if (path === '/geocaching/credentials' && req.method === 'POST') {
    readBody(req)
      .then(async (body) => {
        const creds = JSON.parse(body || '{}') as { username?: string; password?: string; cookie?: string }
        const status = await client.setCredentials(creds)
        json(res, status)
      })
      .catch((err) => fail(res, err))
    return true
  }

  if (path === '/geocaching/fetch-area' && req.method === 'POST') {
    readBody(req)
      .then(async (body) => {
        const b = JSON.parse(body || '{}') as {
          bbox?: BBox
          lat?: number
          lon?: number
          radiusKm?: number
          max?: number
        }
        let bbox: BBox
        if (Array.isArray(b.bbox) && b.bbox.length === 4) {
          bbox = b.bbox
        } else if (typeof b.lat === 'number' && typeof b.lon === 'number') {
          bbox = bboxFromRadius(b.lat, b.lon, b.radiusKm ?? 5)
        } else {
          throw new Error('fetch-area requires { bbox } or { lat, lon, radiusKm }')
        }
        const result = await client.fetchArea(bbox, { max: b.max })
        json(res, result)
      })
      .catch((err) => fail(res, err))
    return true
  }

  if (path === '/geocaching/caches' && req.method === 'GET') {
    json(res, client.getSnapshot())
    return true
  }

  // /geocaching/cache/<code>  and  /geocaching/cache/<code>/logs
  const cacheMatch = /^\/geocaching\/cache\/([A-Za-z0-9]+)(\/logs)?$/.exec(path)
  if (cacheMatch && req.method === 'GET') {
    const code = cacheMatch[1].toUpperCase()
    const logsOnly = !!cacheMatch[2]
    client
      .getCacheDetail(code)
      .then((cache) => {
        if (logsOnly) json(res, { code, logs: cache.detail?.logs ?? [] })
        else json(res, cache)
      })
      .catch((err) => fail(res, err))
    return true
  }

  return false
}
