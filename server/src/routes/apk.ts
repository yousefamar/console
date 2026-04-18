// APK distribution routes.
//
// The Android shell (`android/`) loads the web app from the tailnet URL, but
// the native shell itself needs a channel for updates. The hub exposes:
//
//   GET /apk/latest.json   — metadata: { versionCode, versionName, sha256, url, changelog? }
//   GET /apk/<filename>    — APK binary served from ~/.config/console/apk/
//
// Drop a signed APK into `~/.config/console/apk/` with a matching `latest.json`
// and the installed APK polls this endpoint on launch; when a newer
// `versionCode` is advertised, the native shell shows an "Update available"
// banner that kicks off an `ACTION_INSTALL_PACKAGE` intent.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const APK_DIR = join(homedir(), '.config', 'console', 'apk')

export function handleApkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  if (!path.startsWith('/apk/')) return false
  if (req.method !== 'GET') return false

  // GET /apk/latest.json
  if (path === '/apk/latest.json') {
    const p = join(APK_DIR, 'latest.json')
    if (!existsSync(p)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No release published' }))
      return true
    }
    const body = readFileSync(p, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    res.end(body)
    return true
  }

  // GET /apk/<filename> — only serve files from APK_DIR, no traversal.
  const filename = basename(path.slice('/apk/'.length))
  if (!filename || !filename.endsWith('.apk')) {
    res.writeHead(400)
    res.end('Bad Request')
    return true
  }
  const file = join(APK_DIR, filename)
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end('Not Found')
    return true
  }
  const stat = statSync(file)
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': String(stat.size),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
  return true
}
