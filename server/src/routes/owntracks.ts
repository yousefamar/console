// OwnTracks proxy.
//
// Yousef self-hosts an OwnTracks Recorder at maps.amar.io (Recorder API behind
// HTTP basic auth, see `reference_owntracks_server` memory). The Map pane needs
// his location history, but the browser can't reach it directly (CORS +
// mixed-content + we don't want the basic-auth creds in the client). So the hub
// proxies the read-only Recorder endpoints, injecting the basic-auth header from
// the auth store.
//
//   GET /owntracks/version            → Recorder /api/0/version
//   GET /owntracks/list               → users / devices
//   GET /owntracks/last[?user&device] → latest fix per device
//   GET /owntracks/locations?user&device&from&to&format=geojson → history
//
// Query params are forwarded verbatim to the Recorder.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore } from '../auth-store.js'

const ALLOWED = new Set(['version', 'list', 'last', 'locations'])

export function handleOwntracksRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  authStore: AuthStore,
): boolean {
  if (!path.startsWith('/owntracks/')) return false
  if (req.method !== 'GET') return false

  const sub = path.slice('/owntracks/'.length)
  if (!ALLOWED.has(sub)) return false

  const cfg = authStore.getOwntracksConfig()
  if (!cfg?.url) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'OwnTracks not configured' }))
    return true
  }

  void proxy(res, sub, url, cfg).catch((err: unknown) => {
    if (res.headersSent) return
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'OwnTracks upstream error', detail: (err as Error).message }))
  })
  return true
}

async function proxy(
  res: ServerResponse,
  sub: string,
  url: URL,
  cfg: { url: string; username: string; password: string },
): Promise<void> {
  const base = cfg.url.replace(/\/+$/, '')
  const target = new URL(`${base}/api/0/${sub}`)
  for (const [k, v] of url.searchParams) target.searchParams.append(k, v)

  const auth = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')
  const upstream = await fetch(target, { headers: { Authorization: `Basic ${auth}` } })
  const body = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
