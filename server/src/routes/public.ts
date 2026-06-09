// `/public/*` canvas surface. The auth middleware lets `/public/*` through;
// this module is the only thing handling `/public/canvas/<token>/...` paths.
//
// `/public/cron.ics?token=…` and `/public/apk/*` are handled by aliasing the
// path in the request dispatcher (server/src/index.ts) and letting the
// existing cron/apk handlers run. That keeps a single source of truth for
// each route's auth model (the cron token / public APK assets) and avoids
// re-wrapping their handler signatures here.
//
// Routes:
//   GET /public/canvas/<token>           → 301 → /public/canvas/<token>/
//   GET /public/canvas/<token>/          → standalone tab / island page
//   GET /public/canvas/<token>/<asset>   → static asset under tabs/<slug>/
//
// Path-traversal: asset resolution uses path.resolve and rejects anything
// outside tabsDir/<slug>/.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import type { CanvasDir, Island, Tab } from '../dashboard.js'
import { contentTypeFor } from '../dashboard.js'
import type { CanvasPublicTokens } from '../canvas-public-tokens.js'

export interface PublicContext {
  canvas: CanvasDir
  publicTokens: CanvasPublicTokens
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function notFoundHtml(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body style="font:13px ui-sans-serif;background:#0a0a0a;color:#e5e5e5;text-align:center;padding:80px 20px"><h2>Not found</h2><p>This share link is invalid or has been revoked.</p></body></html>')
}

function composePublicIsland(island: Island): string {
  const title = island.meta.title ?? island.slug
  const accent = island.meta.accent || '#262626'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;min-height:100%;background:#0a0a0a;color:#e5e5e5;font:13px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
  body{padding:24px;max-width:960px;margin:0 auto}
  header{display:flex;align-items:baseline;gap:10px;border-bottom:2px solid ${escapeHtml(accent)};padding-bottom:6px;margin-bottom:14px;font-size:11px;color:#a3a3a3}
  header h1{margin:0;font-size:14px;font-weight:500;color:#e5e5e5}
  ::-webkit-scrollbar{width:8px;height:8px}
  ::-webkit-scrollbar-thumb{background:#262626;border-radius:4px}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1></header>
<div class="body">${island.html}</div>
</body></html>
`
}

function composePublicTabPlaceholder(tab: Tab): string {
  const title = tab.meta.title ?? tab.slug
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:13px ui-sans-serif,system-ui;background:#0a0a0a;color:#a3a3a3;text-align:center;padding:80px 20px}</style>
</head><body><h2>${escapeHtml(title)}</h2><p>This tab has no content yet.</p></body></html>`
}

function safeReadTabAsset(canvas: CanvasDir, slug: string, asset: string): Buffer | null {
  // Normalize and resolve INSIDE tabs/<slug>/. Reject anything that escapes
  // via "..", absolute paths, or any other shenanigans.
  if (!asset || asset === '/' || asset.includes('\0')) return null
  const cleaned = asset.replace(/^\/+/, '')
  const base = resolvePath(canvas.tabsDir, slug)
  const full = resolvePath(base, cleaned)
  if (full !== base && !full.startsWith(base + sep)) return null
  try {
    const st = statSync(full)
    if (!st.isFile()) return null
    return readFileSync(full)
  } catch {
    return null
  }
}

export function handlePublicCanvas(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: PublicContext,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!path.startsWith('/public/canvas/') && path !== '/public/canvas') return false

  if (path === '/public/canvas') {
    notFoundHtml(res)
    return true
  }

  const rest = path.slice('/public/canvas/'.length)
  if (rest === '') {
    notFoundHtml(res)
    return true
  }

  // `/public/canvas/<token>` (no trailing slash) → 301 to `/public/canvas/<token>/`
  // so relative asset URLs in the tab's HTML (`<img src="pic.png">`) resolve
  // against the right base.
  const firstSlash = rest.indexOf('/')
  if (firstSlash === -1) {
    res.writeHead(301, { Location: `/public/canvas/${encodeURIComponent(rest)}/` })
    res.end()
    return true
  }

  const token = decodeURIComponent(rest.slice(0, firstSlash))
  const remainder = rest.slice(firstSlash + 1) // may be '' for trailing slash
  const entry = ctx.publicTokens.resolve(token)
  if (!entry) {
    notFoundHtml(res)
    return true
  }

  // Token URL root or explicit index.html — compose the standalone page.
  if (remainder === '' || remainder === 'index.html') {
    if (entry.kind === 'island') {
      const island = ctx.canvas.listIslands().find((i) => i.slug === entry.slug)
      if (!island) { notFoundHtml(res); return true }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      })
      res.end(composePublicIsland(island))
      return true
    }
    const tab = ctx.canvas.listTabs().find((t) => t.slug === entry.slug)
    if (!tab) { notFoundHtml(res); return true }
    if (!tab.hasContent) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(composePublicTabPlaceholder(tab))
      return true
    }
    const buf = safeReadTabAsset(ctx.canvas, entry.slug, 'index.html')
    if (!buf) { notFoundHtml(res); return true }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(buf)
    return true
  }

  // Tab assets: islands are inline-HTML and don't have a filesystem footprint
  // to serve relative paths from. v1 explicitly rejects island asset paths.
  if (entry.kind !== 'tab') {
    notFoundHtml(res)
    return true
  }
  const buf = safeReadTabAsset(ctx.canvas, entry.slug, remainder)
  if (!buf) { notFoundHtml(res); return true }
  res.writeHead(200, {
    'Content-Type': contentTypeFor(remainder),
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(buf)
  return true
}
