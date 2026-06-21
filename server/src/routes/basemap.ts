// Basemap tile serving (HTTP Range capable).
//
// The Map pane renders a MapLibre GL dark vector map from a self-hosted
// Protomaps PMTiles archive (no third-party tile key). The `pmtiles` protocol
// reads the archive via HTTP Range requests, so this route — unlike the rest of
// the hub's whole-file serving — must honour `Range:` with `206 Partial
// Content` + `Content-Range`, and answer `HEAD` (pmtiles probes the file length).
//
//   GET|HEAD /basemap/<region>.pmtiles            (loopback)
//   GET|HEAD /public/basemap/<region>.pmtiles     (public alias, Caddy-reachable)
//
// Files live in ~/.config/console/basemap/ (mirrors the apk/ convention).
// Generate them with `con basemap update` (pmtiles extract from a global build).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'

const BASEMAP_DIR = join(homedir(), '.config', 'console', 'basemap')

export function handleBasemapRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  if (!path.startsWith('/basemap/')) return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  const filename = basename(path.slice('/basemap/'.length))
  if (!filename || extname(filename) !== '.pmtiles') {
    res.writeHead(400)
    res.end('Bad Request')
    return true
  }
  const file = join(BASEMAP_DIR, filename)
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end('Not Found')
    return true
  }

  const stat = statSync(file)
  const total = stat.size
  const isHead = req.method === 'HEAD'
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': 'public, max-age=86400',
  }

  const rangeHeader = req.headers['range']

  // No / multi / malformed range → serve the whole file as 200.
  const match = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (!match || (match[1] === '' && match[2] === '')) {
    res.writeHead(200, { ...baseHeaders, 'Content-Length': String(total) })
    if (isHead) { res.end(); return true }
    createReadStream(file).pipe(res)
    return true
  }

  let start: number
  let end: number
  if (match[1] === '') {
    // suffix range: last N bytes
    start = Math.max(0, total - parseInt(match[2], 10))
    end = total - 1
  } else {
    start = parseInt(match[1], 10)
    end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1)
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${total}` })
    res.end()
    return true
  }

  const chunkSize = end - start + 1
  res.writeHead(206, {
    ...baseHeaders,
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': String(chunkSize),
  })
  if (isHead) { res.end(); return true }
  createReadStream(file, { start, end }).pipe(res)
  return true
}
