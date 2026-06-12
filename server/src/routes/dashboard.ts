// Dashboard routes — snapshot, alerts, servers CRUD, canvas static + clear.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  gatherSnapshot,
  gatherAlerts,
  contentTypeFor,
  type ServersConfig,
  type CanvasDir,
} from '../dashboard.js'
import type { Session } from '../session.js'
import type { CalendarSync } from '../cal/sync.js'
import type { DebugLog } from '../debug-log.js'
import type { CanvasPublicTokens } from '../canvas-public-tokens.js'

export interface DashboardCtx {
  servers: ServersConfig
  canvas: CanvasDir
  sessions: Map<string, Session>
  cal: CalendarSync
  debugLog: DebugLog
  publicTokens: CanvasPublicTokens
}

function publicShareUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/public/canvas/${encodeURIComponent(token)}/`
}

/**
 * Public origin used in canvas share-URL output. Same hostname Caddy serves
 * the SPA + /hub/* + /public/* from; override via CONSOLE_PUBLIC_ORIGIN.
 */
export function resolvePublicOrigin(): string {
  return process.env.CONSOLE_PUBLIC_ORIGIN || 'https://con.amar.io'
}

export function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: DashboardCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  // ---- snapshot ----
  if (path === '/dashboard/snapshot' && req.method === 'GET') {
    gatherSnapshot({ servers: ctx.servers, sessions: ctx.sessions }).then((snap) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(snap))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  // ---- alerts ----
  if (path === '/dashboard/alerts' && req.method === 'GET') {
    try {
      const alerts = gatherAlerts({ sessions: ctx.sessions, cal: ctx.cal, debugLog: ctx.debugLog })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ alerts }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return true
  }

  // ---- servers ----
  if (path === '/dashboard/servers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ servers: ctx.servers.list() }))
    return true
  }

  if (path === '/dashboard/servers' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { name, url: u, expectStatus } = JSON.parse(body) as { name?: string; url?: string; expectStatus?: number }
      if (!name || !u) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'name and url required' }))
        return
      }
      const server = ctx.servers.add(name, u, expectStatus)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(server))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  const serverIdMatch = path.match(/^\/dashboard\/servers\/([^/]+)$/)
  if (serverIdMatch && req.method === 'DELETE') {
    const ok = ctx.servers.remove(serverIdMatch[1]!)
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return true
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  return false
}

/** Serve canvas dir as static files at /canvas/* */
export function handleCanvasRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: DashboardCtx,
): boolean {
  if (!path.startsWith('/canvas')) return false

  // Metadata (used by the dashboard card to show "last updated")
  if (path === '/canvas/_meta' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(ctx.canvas.metadata()))
    return true
  }

  // Wipe canvas back to placeholder
  if (path === '/canvas' && req.method === 'DELETE') {
    ctx.canvas.clear()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  // Static file serve. `/canvas` and `/canvas/` redirect to index.html implicitly.
  if (req.method === 'GET') {
    const rel = path.slice('/canvas'.length) || '/index.html'
    const buf = ctx.canvas.read(rel === '/' ? 'index.html' : rel)
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return true
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(rel),
      // Don't cache — agents may rewrite at any time and the iframe reloads via WS.
      'Cache-Control': 'no-store',
    })
    res.end(buf)
    return true
  }

  return false
}

/** Island CRUD — agents collaborate by each owning a slug. */
export function handleCanvasIslandRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: DashboardCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/dashboard/canvas/islands')) return false
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (path === '/dashboard/canvas/islands' && req.method === 'GET') {
    json({ islands: ctx.canvas.listIslands() })
    return true
  }

  if (path === '/dashboard/canvas/islands' && req.method === 'POST') {
    readBody(req).then((body) => {
      let parsed: { slug?: string; html?: string; meta?: Record<string, unknown> }
      try { parsed = JSON.parse(body) } catch { return json({ error: 'invalid json' }, 400) }
      if (!parsed.slug || typeof parsed.html !== 'string') return json({ error: 'slug and html required' }, 400)
      try {
        const saved = ctx.canvas.writeIsland(parsed.slug, parsed.html, parsed.meta as Record<string, never> | undefined)
        json({ slug: saved })
      } catch (err) {
        json({ error: (err as Error).message }, 400)
      }
    }).catch((err) => json({ error: (err as Error).message }, 500))
    return true
  }

  if (path === '/dashboard/canvas/islands' && req.method === 'DELETE') {
    ctx.canvas.clearIslands()
    json({ ok: true })
    return true
  }

  // publish / unpublish / url — toggle public share for a specific island
  const publishMatch = path.match(/^\/dashboard\/canvas\/islands\/([^/]+)\/publish$/)
  if (publishMatch) {
    const slug = decodeURIComponent(publishMatch[1]!)
    const origin = resolvePublicOrigin()
    if (req.method === 'POST') {
      const entry = ctx.publicTokens.publish('island', slug)
      json({ kind: entry.kind, slug: entry.slug, token: entry.token, url: publicShareUrl(origin, entry.token), createdAt: entry.createdAt })
      return true
    }
    if (req.method === 'GET') {
      const entry = ctx.publicTokens.getBySlug('island', slug)
      if (!entry) { json({ error: 'not published' }, 404); return true }
      json({ kind: entry.kind, slug: entry.slug, token: entry.token, url: publicShareUrl(origin, entry.token), createdAt: entry.createdAt })
      return true
    }
    if (req.method === 'DELETE') {
      const ok = ctx.publicTokens.unpublish('island', slug)
      json({ ok })
      return true
    }
  }

  const m = path.match(/^\/dashboard\/canvas\/islands\/([^/]+)$/)
  if (m && req.method === 'DELETE') {
    const ok = ctx.canvas.removeIsland(decodeURIComponent(m[1]!))
    if (!ok) {
      json({ error: 'not found' }, 404)
    } else {
      json({ ok: true })
    }
    return true
  }

  return false
}

/** Tab CRUD — each tab is a sandboxed sub-canvas owned by one agent. */
export function handleCanvasTabRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: DashboardCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/dashboard/canvas/tabs')) return false
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (path === '/dashboard/canvas/tabs' && req.method === 'GET') {
    json({ tabs: ctx.canvas.listTabs() })
    return true
  }

  if (path === '/dashboard/canvas/tabs' && req.method === 'POST') {
    readBody(req).then((body) => {
      let parsed: { slug?: string; html?: string; meta?: Record<string, unknown> }
      try { parsed = JSON.parse(body) } catch { return json({ error: 'invalid json' }, 400) }
      if (!parsed.slug || typeof parsed.html !== 'string') return json({ error: 'slug and html required' }, 400)
      try {
        const saved = ctx.canvas.writeTab(parsed.slug, parsed.html, parsed.meta as Record<string, never> | undefined)
        // Recompose root so the shell picks up the new/updated tab.
        ctx.canvas.composeIndexHtml()
        json({ slug: saved })
      } catch (err) {
        json({ error: (err as Error).message }, 400)
      }
    }).catch((err) => json({ error: (err as Error).message }, 500))
    return true
  }

  if (path === '/dashboard/canvas/tabs' && req.method === 'DELETE') {
    ctx.canvas.clearTabs()
    ctx.canvas.composeIndexHtml()
    json({ ok: true })
    return true
  }

  // publish / unpublish / url — toggle public share for a specific tab
  const publishMatch = path.match(/^\/dashboard\/canvas\/tabs\/([^/]+)\/publish$/)
  if (publishMatch) {
    const slug = decodeURIComponent(publishMatch[1]!)
    const origin = resolvePublicOrigin()
    if (req.method === 'POST') {
      const entry = ctx.publicTokens.publish('tab', slug)
      json({ kind: entry.kind, slug: entry.slug, token: entry.token, url: publicShareUrl(origin, entry.token), createdAt: entry.createdAt })
      return true
    }
    if (req.method === 'GET') {
      const entry = ctx.publicTokens.getBySlug('tab', slug)
      if (!entry) { json({ error: 'not published' }, 404); return true }
      json({ kind: entry.kind, slug: entry.slug, token: entry.token, url: publicShareUrl(origin, entry.token), createdAt: entry.createdAt })
      return true
    }
    if (req.method === 'DELETE') {
      const ok = ctx.publicTokens.unpublish('tab', slug)
      json({ ok })
      return true
    }
  }

  const m = path.match(/^\/dashboard\/canvas\/tabs\/([^/]+)$/)
  if (m && req.method === 'DELETE') {
    const ok = ctx.canvas.removeTab(decodeURIComponent(m[1]!))
    if (!ok) {
      json({ error: 'not found' }, 404)
      return true
    }
    ctx.canvas.composeIndexHtml()
    json({ ok: true })
    return true
  }

  return false
}
