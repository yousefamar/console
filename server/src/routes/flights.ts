// Flight search + watchlist routes.
//
// GET  /flights/status                       — { configured }
// GET  /flights/explore?from=LHR&...         — ad-hoc anywhere/region discovery
// GET  /flights/search?from=LHR&to=JFK&...   — ad-hoc point-to-point search
// GET  /flights/watchlists                   — list saved watchlists
// POST /flights/watchlists                   — create one
// PATCH  /flights/watchlists/:id             — update (label, threshold, query fields)
// DELETE /flights/watchlists/:id             — remove
// POST /flights/watchlists/:id/run           — poll immediately (returns updated state)
// POST /flights/credentials                  — set/rotate SerpApi key
// POST /flights/map                          — render legs as an animated arc map layer

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore } from '../auth-store.js'
import type { SerpApiClient, ExploreQuery, SearchQuery, RegionKey, TripDuration } from '../flights/serpapi.js'
import type { WatchlistStore, CreateWatchlistInput } from '../flights/store.js'
import type { FlightSync } from '../flights/sync.js'
import type { MapLayerStore } from '../map-layers/store.js'
import { legsToGeoJSON, type FlightLeg } from '../flights/arcs.js'

export function handleFlightRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  deps: {
    authStore: AuthStore
    serpApi: SerpApiClient
    watchlists: WatchlistStore
    sync: FlightSync
    mapLayers: MapLayerStore
    onLayersChange: () => void
    readBody: (req: IncomingMessage) => Promise<string>
  },
): boolean {
  const { authStore, serpApi, watchlists, sync, mapLayers, onLayersChange, readBody } = deps

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

  // --------------------------------------------------------------------------
  // Status / credentials
  // --------------------------------------------------------------------------

  if (path === '/flights/status' && req.method === 'GET') {
    json({ configured: serpApi.isConfigured() })
    return true
  }

  if (path === '/flights/credentials' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req) || '{}') as { apiKey?: string }
      if (!body.apiKey || typeof body.apiKey !== 'string') {
        return error(400, 'apiKey required')
      }
      authStore.setSerpApiKey(body.apiKey.trim())
      json({ ok: true })
    })
  }

  // --------------------------------------------------------------------------
  // Map layer — render a set of legs as animated great-circle arcs.
  // Reuses the agent map-layers transport (persistence + sync + toggle).
  // --------------------------------------------------------------------------

  if (path === '/flights/map' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req) || '{}') as {
        name?: string
        legs?: FlightLeg[]
        color?: string
        fit?: boolean
      }
      if (!Array.isArray(body.legs) || body.legs.length === 0) {
        return error(400, 'legs[] required')
      }
      const name = (body.name || 'trip').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'trip'
      const { geojson, skipped } = legsToGeoJSON(body.legs, body.color || '#22d3ee')
      const slug = `flights/${name}`
      mapLayers.upsert(slug, geojson, {
        style: {
          animated: true,
          lineColor: body.color || '#22d3ee',
          lineWidth: 2,
          color: body.color || '#22d3ee',
          size: 3,
          popup: ['route', 'price', 'date', 'flight'],
        },
        fit: body.fit ?? true,
        updatedBy: 'flights',
      })
      onLayersChange()
      json({ slug, skipped })
    })
  }

  if (path === '/flights/map' && req.method === 'DELETE') {
    const removed = mapLayers.clear('flights')
    onLayersChange()
    json({ removed })
    return true
  }

  // --------------------------------------------------------------------------
  // Ad-hoc queries
  // --------------------------------------------------------------------------

  if (path === '/flights/explore' && req.method === 'GET') {
    return handleAsync(async () => {
      const q = parseExploreParams(url)
      const result = await serpApi.explore(q)
      json(result)
    })
  }

  if (path === '/flights/search' && req.method === 'GET') {
    return handleAsync(async () => {
      const q = parseSearchParams(url)
      const result = await serpApi.search(q)
      json(result)
    })
  }

  // --------------------------------------------------------------------------
  // Watchlist CRUD
  // --------------------------------------------------------------------------

  if (path === '/flights/watchlists' && req.method === 'GET') {
    json({ watchlists: watchlists.list() })
    return true
  }

  if (path === '/flights/watchlists' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse(await readBody(req) || '{}') as CreateWatchlistInput
      if (!body.kind || !body.origin) return error(400, 'kind and origin required')
      const wl = watchlists.create(body)
      sync.broadcastChange('created', wl)
      json(wl, 201)
    })
  }

  // /flights/watchlists/:id and /flights/watchlists/:id/run
  const wlMatch = path.match(/^\/flights\/watchlists\/([^/]+)(\/run)?$/)
  if (wlMatch) {
    const id = decodeURIComponent(wlMatch[1]!)
    const isRun = !!wlMatch[2]

    if (isRun && req.method === 'POST') {
      return handleAsync(async () => {
        const updated = await sync.pollOne(id)
        if (!updated) return error(404, 'watchlist not found')
        json(updated)
      })
    }

    if (!isRun && req.method === 'GET') {
      const wl = watchlists.get(id)
      if (!wl) { error(404, 'watchlist not found'); return true }
      json(wl)
      return true
    }

    if (!isRun && req.method === 'PATCH') {
      return handleAsync(async () => {
        const body = JSON.parse(await readBody(req) || '{}')
        const wl = watchlists.update(id, body)
        if (!wl) return error(404, 'watchlist not found')
        sync.broadcastChange('updated', wl)
        json(wl)
      })
    }

    if (!isRun && req.method === 'DELETE') {
      const ok = watchlists.remove(id)
      if (!ok) { error(404, 'watchlist not found'); return true }
      sync.broadcastChange('deleted', { id })
      json({ ok: true })
      return true
    }
  }

  return false
}

// --------------------------------------------------------------------------
// Query-string parsers
// --------------------------------------------------------------------------

function parseExploreParams(url: URL): ExploreQuery {
  const sp = url.searchParams
  const from = sp.get('from') || sp.get('departure_id')
  if (!from) throw apiErr(400, 'from is required (origin airport code)')
  const month = sp.get('month')
  const duration = sp.get('duration')
  return {
    departureId: from,
    arrivalId: sp.get('to') || sp.get('arrival_id') || undefined,
    region: (sp.get('region') as RegionKey | null) || undefined,
    arrivalAreaId: sp.get('arrival_area_id') || undefined,
    month: month != null ? parseInt(month, 10) : undefined,
    duration: (duration as TripDuration | null) || undefined,
    currency: sp.get('currency') || undefined,
  }
}

function parseSearchParams(url: URL): SearchQuery {
  const sp = url.searchParams
  const from = sp.get('from') || sp.get('departure_id')
  const to = sp.get('to') || sp.get('arrival_id')
  const date = sp.get('date') || sp.get('outbound_date')
  if (!from || !to || !date) throw apiErr(400, 'from, to, and date are required')
  return {
    departureId: from,
    arrivalId: to,
    outboundDate: date,
    returnDate: sp.get('return') || sp.get('return_date') || undefined,
    travelClass: sp.get('class') ? parseInt(sp.get('class')!, 10) as 1|2|3|4 : undefined,
    adults: sp.get('adults') ? parseInt(sp.get('adults')!, 10) : undefined,
    currency: sp.get('currency') || undefined,
  }
}

function apiErr(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number }
  e.status = status
  return e
}
