// Hub HTTP endpoints that wrap RPC calls to the APK's glasses subsystem.
//
//   GET  /glasses/status                  — cached+live GlassesSnapshot
//   POST /glasses/text     {text}         — write a line to the display
//   POST /glasses/clear                   — blank the display (G1 "exit")
//   POST /glasses/bmp      {bmp: b64}     — 1-bpp 576x136 BMP
//   POST /glasses/notify   {appIdentifier, title, subtitle, message}
//   POST /glasses/mic      {active}       — start/stop mic stream
//   POST /glasses/disconnect              — DND: drop BLE but keep pairing
//   POST /glasses/scan     {durationMs?}  — trigger a BLE scan phone-side
//   POST /glasses/scan/stop               — stop the in-flight scan
//   GET  /glasses/scan/observations       — what names were seen during scans
//   POST /glasses/research {verbose}      — toggle verbose RE frame forwarding
//   GET  /glasses/research/log?n=100      — tail the reverse-engineering log
//
// All require the APK to be connected on /push (the phone is the BLE owner).
// If the APK isn't connected we 503 so the CLI/caller can present a useful
// "phone not reachable" error instead of hanging.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GlassesHub, GlassesNotifyRequest } from '../glasses-hub.js'

export function handleGlassesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  glassesHub: GlassesHub,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/glasses')) return false

  // --- scan observations (in-memory ring buffer; no APK needed) -----------
  if (path === '/glasses/scan/observations' && req.method === 'GET') {
    const obs = glassesHub.getScanObservations()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obs))
    return true
  }

  // --- research log tail (local file; no APK needed) ----------------------
  // Always succeeds (even if the APK isn't connected) because we're just
  // reading what the APK *has* sent in the past.
  if (path === '/glasses/research/log' && req.method === 'GET') {
    const url = new URL(req.url ?? '', 'http://x')
    const n = Math.max(1, Math.min(5000, Number(url.searchParams.get('n') ?? '100')))
    const entries = glassesHub.tailResearchLog(n)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(entries))
    return true
  }

  // --- read-only status ----------------------------------------------------
  if (path === '/glasses/status' && req.method === 'GET') {
    ;(async () => {
      if (!glassesHub.hasClient()) {
        // Still return the last cached snapshot if we have one — useful for
        // debugging "was the APK recently connected?".
        const { state, ageMs } = glassesHub.getCachedState()
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'APK not connected', cached: state, cachedAgeMs: ageMs }))
        return
      }
      try {
        const state = await glassesHub.status()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state))
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return true
  }

  // --- generic command dispatcher -----------------------------------------
  const command = (() => {
    if (req.method !== 'POST') return null
    switch (path) {
      case '/glasses/text':       return 'text'
      case '/glasses/clear':      return 'clear'
      case '/glasses/bmp':        return 'bmp'
      case '/glasses/notify':     return 'notify'
      case '/glasses/mic':        return 'mic'
      case '/glasses/disconnect': return 'disconnect'
      case '/glasses/scan':       return 'scan'
      case '/glasses/scan/stop':  return 'scanStop'
      case '/glasses/research':   return 'research'
      default: return null
    }
  })()
  if (!command) return false

  ;(async () => {
    if (!glassesHub.hasClient()) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'APK not connected' }))
      return
    }
    try {
      const body = command === 'clear' || command === 'disconnect'
        ? {}
        : JSON.parse(await readBody(req) || '{}')
      switch (command) {
        case 'text': {
          const text = String(body.text ?? '')
          if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'text required' })); return }
          await glassesHub.sendText(text)
          break
        }
        case 'clear':
          await glassesHub.clear()
          break
        case 'bmp': {
          const bmp = String(body.bmp ?? '')
          if (!bmp) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bmp (base64) required' })); return }
          await glassesHub.sendBmp(bmp)
          break
        }
        case 'notify': {
          const n: GlassesNotifyRequest = {
            appIdentifier: String(body.appIdentifier ?? 'com.console'),
            title: String(body.title ?? ''),
            subtitle: String(body.subtitle ?? ''),
            message: String(body.message ?? ''),
            timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
          }
          if (!n.title && !n.message) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title or message required' })); return }
          await glassesHub.notify(n)
          break
        }
        case 'mic':
          await glassesHub.setMic(!!body.active)
          break
        case 'disconnect':
          await glassesHub.disconnect()
          break
        case 'scan': {
          const durationMs = typeof body.durationMs === 'number' ? body.durationMs : 15_000
          await glassesHub.startScan(durationMs)
          break
        }
        case 'scanStop':
          await glassesHub.stopScan()
          break
        case 'research':
          // Body shape: { verbose: boolean }. When true, the APK also
          // forwards heartbeat frames to the research log.
          await glassesHub.setResearch(!!body.verbose)
          break
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  })()
  return true
}
