// Map-layer routes — agent-authored GeoJSON overlays for the Map tab.
//
//   GET    /map/layers              → index (metadata only; no geojson)
//   GET    /map/layers/<slug>       → the layer's GeoJSON (may be multi-MB)
//   POST   /map/layers              → upsert { slug, geojson, style?, fit?, by? }
//   DELETE /map/layers/<slug>       → remove one layer
//   DELETE /map/layers[?group=g]    → clear all (or a group)
//
// Mutations call `onChange()` so the hub re-broadcasts the lightweight index
// over SyncBus; clients fetch each layer's GeoJSON over HTTP on demand.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MapLayerStore, LayerStyle } from '../map-layers/store.js'

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
function fail(res: ServerResponse, err: unknown, status = 500): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: (err as Error).message }))
}

export function handleMapLayerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  store: MapLayerStore,
  readBody: (req: IncomingMessage) => Promise<string>,
  onChange: () => void,
): boolean {
  if (path !== '/map/layers' && !path.startsWith('/map/layers/')) return false

  // index
  if (path === '/map/layers' && req.method === 'GET') {
    json(res, { layers: store.list() })
    return true
  }

  // upsert
  if (path === '/map/layers' && req.method === 'POST') {
    readBody(req)
      .then((body) => {
        const b = JSON.parse(body || '{}') as {
          slug?: string
          geojson?: unknown
          style?: LayerStyle
          fit?: boolean
          by?: string
        }
        if (!b.slug || !b.geojson) throw new Error('upsert requires { slug, geojson }')
        const meta = store.upsert(b.slug, b.geojson, { style: b.style, fit: b.fit, updatedBy: b.by })
        onChange()
        json(res, meta)
      })
      .catch((err) => fail(res, err, 400))
    return true
  }

  // clear all / group
  if (path === '/map/layers' && req.method === 'DELETE') {
    try {
      const removed = store.clear(url.searchParams.get('group') ?? undefined)
      onChange()
      json(res, { removed })
    } catch (err) {
      fail(res, err)
    }
    return true
  }

  // per-slug (slug may contain '/')
  const slug = decodeURIComponent(path.slice('/map/layers/'.length))
  if (req.method === 'GET') {
    const gj = store.getGeojson(slug)
    if (!gj) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'layer not found' }))
      return true
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(gj))
    return true
  }
  if (req.method === 'DELETE') {
    const ok = store.remove(slug)
    onChange()
    json(res, { removed: ok ? 1 : 0 })
    return true
  }

  return false
}
