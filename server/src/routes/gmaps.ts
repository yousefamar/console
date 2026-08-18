// Google Maps Platform proxy routes.
//
// GET  /gmaps/status                         — { configured }
// POST /gmaps/credentials                    — set/rotate the Maps Platform key
// GET  /gmaps/search?q=…[&lat&lon&radius]    — Places API (New) text search
// POST /gmaps/directions                     — Routes API computeRoutes
//        body { origin:{lat,lon}, destination:{lat,lon}, mode?, alternatives?, departureTime? }
//        departureTime (RFC3339 UTC) only affects TRANSIT — see gmaps/client.ts
//
// Pure read proxy: search results + routes live in the client store and render
// as dedicated MapLibre sources (like geocache/meetup pins), not persisted
// agent layers. The Cloud key never reaches the browser.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore } from '../auth-store.js'
import type { GoogleMapsClient, TravelMode } from '../gmaps/client.js'

export function handleGmapsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  deps: {
    authStore: AuthStore
    gmaps: GoogleMapsClient
    readBody: (req: IncomingMessage) => Promise<string>
  },
): boolean {
  const { authStore, gmaps, readBody } = deps

  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const error = (status: number, message: string) => json({ error: message }, status)
  const handleAsync = (fn: () => Promise<void>) => {
    fn().catch((err: Error) => {
      const status = (err as any).status || 500
      error(status, err.message || String(err))
    })
    return true
  }

  if (path === '/gmaps/status' && req.method === 'GET') {
    json({ configured: gmaps.isConfigured() })
    return true
  }

  if (path === '/gmaps/credentials' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req) || '{}') as { apiKey?: string }
      if (!body.apiKey || typeof body.apiKey !== 'string') return error(400, 'apiKey required')
      authStore.setGoogleMapsKey(body.apiKey.trim())
      json({ ok: true })
    })
  }

  if (path === '/gmaps/credentials' && req.method === 'DELETE') {
    authStore.clearGoogleMaps()
    json({ ok: true, configured: false })
    return true
  }

  if (path === '/gmaps/search' && req.method === 'GET') {
    return handleAsync(async () => {
      const q = url.searchParams.get('q')?.trim()
      if (!q) return error(400, 'q (query) required')
      const lat = numParam(url, 'lat')
      const lon = numParam(url, 'lon')
      const radius = numParam(url, 'radius')
      const bias = lat != null && lon != null ? { lat, lon, radiusMeters: radius ?? undefined } : undefined
      const results = await gmaps.searchText(q, bias)
      json({ results })
    })
  }

  if (path === '/gmaps/autocomplete' && req.method === 'GET') {
    return handleAsync(async () => {
      const input = url.searchParams.get('q')?.trim()
      if (!input) return json({ suggestions: [] })
      const lat = numParam(url, 'lat')
      const lon = numParam(url, 'lon')
      const radius = numParam(url, 'radius')
      const sessionToken = url.searchParams.get('session') ?? undefined
      const suggestions = await gmaps.autocomplete(input, {
        lat: lat ?? undefined,
        lon: lon ?? undefined,
        radiusMeters: radius ?? undefined,
        sessionToken,
      })
      json({ suggestions })
    })
  }

  if (path.startsWith('/gmaps/place/') && req.method === 'GET') {
    return handleAsync(async () => {
      const placeId = decodeURIComponent(path.slice('/gmaps/place/'.length))
      if (!placeId) return error(400, 'place id required')
      const sessionToken = url.searchParams.get('session') ?? undefined
      const place = await gmaps.placeDetails(placeId, sessionToken)
      json({ place })
    })
  }

  if (path === '/gmaps/directions' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req) || '{}') as {
        origin?: { lat?: number; lon?: number }
        destination?: { lat?: number; lon?: number }
        mode?: TravelMode
        alternatives?: boolean
        departureTime?: string
      }
      const o = body.origin, d = body.destination
      if (o?.lat == null || o?.lon == null || d?.lat == null || d?.lon == null) {
        return error(400, 'origin{lat,lon} and destination{lat,lon} required')
      }
      const routes = await gmaps.computeRoutes({
        origin: { lat: o.lat, lon: o.lon },
        destination: { lat: d.lat, lon: d.lon },
        travelMode: body.mode,
        alternatives: body.alternatives,
        departureTime: body.departureTime,
      })
      json({ routes })
    })
  }

  return false
}

function numParam(url: URL, key: string): number | null {
  const v = url.searchParams.get(key)
  if (v == null || v === '') return null
  const n = Number(v)
  return isNaN(n) ? null : n
}
