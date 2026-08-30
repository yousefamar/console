// Property search routes (house hunt across Rightmove / IS24 / immobiliare).
//
// GET    /property/searches               — list saved searches
// POST   /property/searches               — create one
// GET    /property/searches/:id           — one search incl. last results
// PATCH  /property/searches/:id           — edit (criteria, label, enabled, …)
// DELETE /property/searches/:id           — remove (drops its map layer too)
// POST   /property/searches/:id/run       — poll now
// POST   /property/searches/:id/backfill  — one-off deeper pull, merges silently
// POST   /property/searches/:id/dismiss   — hide (or restore) one listing's pin
// POST   /property/searches/:id/reseed    — force re-seed after a map-layer content fix
// POST   /property/count                  — ad-hoc count, nothing saved
// GET    /property/listings               — merged newest listings across searches

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MapLayerStore } from '../map-layers/store.js'
import type { PropertySearchStore, CreatePropertySearchInput, Country } from '../property/store.js'
import type { PropertySync } from '../property/sync.js'
import type { Criteria, Listing } from '../property/types.js'

const COUNTRIES = ['UK', 'DE', 'IT'] as const

export function handlePropertyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  deps: {
    searches: PropertySearchStore
    sync: PropertySync
    mapLayers: MapLayerStore
    onLayersChange: () => void
    readBody: (req: IncomingMessage) => Promise<string>
  },
): boolean {
  const { searches, sync, mapLayers, onLayersChange, readBody } = deps

  const json = (data: unknown, status = 200): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const error = (status: number, message: string): void => json({ error: message }, status)
  const handleAsync = (fn: () => Promise<void>): boolean => {
    fn().catch((err: Error) => error((err as Error & { status?: number }).status ?? 500, err.message || String(err)))
    return true
  }

  if (path === '/property/searches' && req.method === 'GET') {
    json({ searches: searches.list() })
    return true
  }

  if (path === '/property/searches' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse((await readBody(req)) || '{}') as CreatePropertySearchInput
      if (!body.country || !COUNTRIES.includes(body.country)) return error(400, `country must be one of ${COUNTRIES.join('|')}`)
      if (!body.layer) return error(400, 'layer required (a map-layer slug supplying the polygon)')
      if (!mapLayers.getMeta(body.layer)) return error(400, `map layer '${body.layer}' not found`)
      const s = searches.create(body)
      sync.broadcastChange('created', s)
      json(s, 201)
    })
  }

  if (path === '/property/count' && req.method === 'POST') {
    return handleAsync(async () => {
      const body = JSON.parse((await readBody(req)) || '{}') as {
        country?: Country
        layer?: string
        maxRings?: number
        criteria?: Criteria
      }
      if (!body.country || !COUNTRIES.includes(body.country)) return error(400, `country must be one of ${COUNTRIES.join('|')}`)
      if (!body.layer) return error(400, 'layer required')
      const total = await sync.count(body.country, body.layer, body.criteria ?? {}, body.maxRings)
      json({ country: body.country, total })
    })
  }

  // Merged newest-first feed across every search — what the Map tab's side
  // panel renders without having to fan out per search.
  if (path === '/property/listings' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') ?? '60', 10) || 60
    const country = url.searchParams.get('country')
    const rows: Array<Listing & { searchId: string }> = []
    for (const s of searches.list()) {
      if (country && s.country !== country) continue
      for (const l of s.lastResults ?? []) rows.push({ ...l, searchId: s.id })
    }
    rows.sort((a, b) => (b.listedAt ?? '').localeCompare(a.listedAt ?? ''))
    json({ listings: rows.slice(0, limit) })
    return true
  }

  const match = path.match(/^\/property\/searches\/([^/]+)(\/(run|backfill|dismiss|reseed))?$/)
  if (match) {
    const id = decodeURIComponent(match[1]!)
    const verb = match[3]

    if (verb === 'run' && req.method === 'POST') {
      return handleAsync(async () => {
        const updated = await sync.pollOne(id)
        if (!updated) return error(404, 'search not found')
        json(updated)
      })
    }

    if (verb === 'backfill' && req.method === 'POST') {
      return handleAsync(async () => {
        const updated = await sync.backfill(id)
        if (!updated) return error(404, 'search not found')
        json(updated)
      })
    }

    if (verb === 'dismiss' && req.method === 'POST') {
      return handleAsync(async () => {
        const body = JSON.parse((await readBody(req)) || '{}') as { listingId?: string; dismissed?: boolean }
        if (!body.listingId) return error(400, 'listingId required')
        const updated = sync.dismiss(id, body.listingId, body.dismissed ?? true)
        if (!updated) return error(404, 'search not found')
        json(updated)
      })
    }

    if (verb === 'reseed' && req.method === 'POST') {
      return handleAsync(async () => {
        const updated = sync.reseed(id)
        if (!updated) return error(404, 'search not found')
        json(updated)
      })
    }

    if (!verb && req.method === 'GET') {
      const s = searches.get(id)
      if (!s) {
        error(404, 'search not found')
        return true
      }
      json(s)
      return true
    }

    if (!verb && req.method === 'PATCH') {
      return handleAsync(async () => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const s = searches.update(id, body)
        if (!s) return error(404, 'search not found')
        sync.broadcastChange('updated', s)
        json(s)
      })
    }

    if (!verb && req.method === 'DELETE') {
      const s = searches.get(id)
      if (!s) {
        error(404, 'search not found')
        return true
      }
      searches.remove(id)
      // Its pins are meaningless without the search.
      for (const layer of mapLayers.list()) {
        if (layer.group === 'property' && layer.name.endsWith(id.slice(3))) mapLayers.remove(layer.slug)
      }
      onLayersChange()
      sync.broadcastChange('deleted', { id })
      json({ ok: true })
      return true
    }
  }

  return false
}
