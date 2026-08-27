// `/public/*` canvas surface. The auth middleware lets `/public/*` through;
// this module handles published-canvas paths.
//
// NO tokens: publish = the plain slug URL is public. Unpublished slugs 404.
//
// Canonical short form:
//   GET /public/<slug>/                      → published tab, else island, else 404
//   GET /public/<slug>/<asset>               → tab asset (islands have none)
// Explicit form (disambiguates a slug published as BOTH kinds):
//   GET /public/canvas/<tab|island>/<slug>/  → that specific kind
// Legacy /public/canvas/<token>/ URLs 404 (token era retired).
//
// `/public/cron.ics?token=…` and `/public/apk/*` are dispatched BEFORE the
// short form in index.ts, so those names are effectively reserved; the short
// handler also skips them defensively.
//
// Path-traversal: asset resolution uses path.resolve and rejects anything
// outside tabsDir/<slug>/.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { resolve as resolvePath, sep } from 'node:path'
import type { CanvasDir, Island, Tab } from '../dashboard.js'
import { contentTypeFor } from '../dashboard.js'
import type { CanvasPublicRegistry, PublicKind } from '../canvas-public.js'

export interface PublicContext {
  canvas: CanvasDir
  publicRegistry: CanvasPublicRegistry
}

const RESERVED_SLUGS = new Set(['canvas', 'apk', 'cron.ics'])

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function notFoundHtml(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body style="font:13px ui-sans-serif;background:#0a0a0a;color:#e5e5e5;text-align:center;padding:80px 20px"><h2>Not found</h2><p>This canvas is not published.</p></body></html>')
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

/** Serve a published canvas page/asset. Assumes (kind, slug) is published. */
function serveCanvas(
  res: ServerResponse,
  ctx: PublicContext,
  kind: PublicKind,
  slug: string,
  remainder: string, // '' for the page root
): void {
  if (remainder === '' || remainder === 'index.html') {
    if (kind === 'island') {
      const island = ctx.canvas.listIslands().find((i) => i.slug === slug)
      if (!island) { notFoundHtml(res); return }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      })
      res.end(composePublicIsland(island))
      return
    }
    const tab = ctx.canvas.listTabs().find((t) => t.slug === slug)
    if (!tab) { notFoundHtml(res); return }
    if (!tab.hasContent) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(composePublicTabPlaceholder(tab))
      return
    }
    const buf = safeReadTabAsset(ctx.canvas, slug, 'index.html')
    if (!buf) { notFoundHtml(res); return }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    res.end(buf)
    return
  }

  // Assets: islands are inline-HTML and don't have a filesystem footprint.
  if (kind !== 'tab') {
    notFoundHtml(res)
    return
  }
  const buf = safeReadTabAsset(ctx.canvas, slug, remainder)
  if (!buf) { notFoundHtml(res); return }
  res.writeHead(200, {
    'Content-Type': contentTypeFor(remainder),
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(buf)
}

/** Explicit form: /public/canvas/<tab|island>/<slug>/... */
export function handlePublicCanvas(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: PublicContext,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!path.startsWith('/public/canvas/') && path !== '/public/canvas') return false

  const rest = path === '/public/canvas' ? '' : path.slice('/public/canvas/'.length)
  const firstSlash = rest.indexOf('/')
  const kindSeg = firstSlash === -1 ? rest : rest.slice(0, firstSlash)
  if (kindSeg !== 'tab' && kindSeg !== 'island') {
    // Includes legacy token URLs — the token era is retired.
    notFoundHtml(res)
    return true
  }
  const kind = kindSeg as PublicKind

  const afterKind = firstSlash === -1 ? '' : rest.slice(firstSlash + 1)
  if (afterKind === '') {
    notFoundHtml(res)
    return true
  }

  // No trailing slash → 301 so relative asset URLs resolve against the base.
  const slugSlash = afterKind.indexOf('/')
  if (slugSlash === -1) {
    res.writeHead(301, { Location: `/public/canvas/${kind}/${encodeURIComponent(afterKind)}/` })
    res.end()
    return true
  }

  const slug = decodeURIComponent(afterKind.slice(0, slugSlash))
  const remainder = afterKind.slice(slugSlash + 1)
  if (!ctx.publicRegistry.isPublished(kind, slug)) {
    notFoundHtml(res)
    return true
  }
  serveCanvas(res, ctx, kind, slug, remainder)
  return true
}

/**
 * Canonical short form: /public/<slug>/... — resolves tab first, then island.
 * A slug published as BOTH kinds serves the tab here; the island stays
 * reachable via the explicit /public/canvas/island/<slug>/ form.
 * Dispatched AFTER /public/{canvas,cron.ics,apk} in index.ts.
 */
export function handlePublicSlug(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: PublicContext,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (!path.startsWith('/public/')) return false

  const rest = path.slice('/public/'.length)
  if (rest === '') return false

  const firstSlash = rest.indexOf('/')
  const rawSlug = firstSlash === -1 ? rest : rest.slice(0, firstSlash)
  const slug = decodeURIComponent(rawSlug)
  if (RESERVED_SLUGS.has(slug)) return false

  const kind: PublicKind | null =
    ctx.publicRegistry.isPublished('tab', slug) ? 'tab'
    : ctx.publicRegistry.isPublished('island', slug) ? 'island'
    : null
  if (!kind) {
    notFoundHtml(res)
    return true
  }

  // No trailing slash → 301 so relative asset URLs resolve against the base.
  if (firstSlash === -1) {
    res.writeHead(301, { Location: `/public/${encodeURIComponent(slug)}/` })
    res.end()
    return true
  }

  serveCanvas(res, ctx, kind, slug, rest.slice(firstSlash + 1))
  return true
}
