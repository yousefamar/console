// Hub HTTP endpoints that wrap RPC calls to the APK's pen subsystem.
//
//   GET  /pen/status                  — cached+live PenSnapshot
//   GET  /pen/devices                 — bonded/known candidate pens
//   POST /pen/connect    {mac?}       — connect (mac optional → last/known)
//   POST /pen/disconnect              — drop BLE but keep pairing
//   POST /pen/scan       {durationMs?}— trigger a BLE scan phone-side
//   GET  /pen/scan/observations       — what names were seen during scans
//   POST /pen/unlock     {password}   — unlock a password-locked pen (PIN is then
//                                       remembered + auto-sent on future connects)
//   GET  /pen/remembered              — whether an auto-unlock PIN is stored
//   POST /pen/forget                  — forget the remembered auto-unlock PIN
//   GET  /pen/stream                  — whether live-streaming-into-Notes is on
//   POST /pen/stream     {enabled}    — toggle live streaming (opt-in, persisted)
//   POST /pen/research   {verbose}    — toggle verbose RE frame forwarding
//   GET  /pen/research/log?n=100      — tail the reverse-engineering log
//
//   --- offline-data rescue (non-destructive) -----------------------------
//   POST /pen/offline/notes                      — enumerate stored notes
//   GET  /pen/offline/notes                      — cached note list
//   POST /pen/offline/pages {section,owner,note} — enumerate pages in a note
//   GET  /pen/offline/pages                      — cached page list
//   POST /pen/offline/pull  {section,owner,note,page} — pull one page's bytes
//   GET  /pen/offline/progress                   — current transfer progress
//   GET  /pen/offline/files                      — saved .bin file list
//
// The pull/notes/pages POSTs only TRIGGER the work; the actual results arrive
// async over the /push WS (mirrors scan) and are returned by the GETs. Page
// bytes stream to `~/.config/console/pen/offline/<s>-<o>-<n>-<p>.bin`.
//
// All command paths require the APK to be connected on /push (the phone is the
// BLE owner). If the APK isn't connected we 503 so the CLI/caller can present a
// useful "phone not reachable" error instead of hanging. Mirrors
// `routes/glasses.ts`.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PenHub } from '../pen-hub.js'

export function handlePenRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  penHub: PenHub,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/pen')) return false

  // --- scan observations (in-memory ring buffer; no APK needed) -----------
  if (path === '/pen/scan/observations' && req.method === 'GET') {
    const obs = penHub.getScanObservations()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obs))
    return true
  }

  // --- research log tail (local file; no APK needed) ----------------------
  // Always succeeds (even if the APK isn't connected) because we're just
  // reading what the APK *has* sent in the past.
  if (path === '/pen/research/log' && req.method === 'GET') {
    const url = new URL(req.url ?? '', 'http://x')
    const n = Math.max(1, Math.min(5000, Number(url.searchParams.get('n') ?? '100')))
    const entries = penHub.tailResearchLog(n)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(entries))
    return true
  }

  // --- remembered auto-unlock PIN (hub-local; no APK needed) --------------
  if (path === '/pen/remembered' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ remembered: penHub.hasRememberedPassword() }))
    return true
  }
  if (path === '/pen/forget' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(penHub.forgetPassword()))
    return true
  }

  // --- live-stream opt-in (hub-local toggle) ------------------------------
  if (path === '/pen/stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ streaming: penHub.isStreamEnabled(), active: penHub.isStreamingActive() }))
    return true
  }
  if (path === '/pen/stream' && req.method === 'POST') {
    ;(async () => {
      const body = JSON.parse((await readBody(req)) || '{}')
      const result = penHub.setStreamEnabled(body.enabled === true)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    })()
    return true
  }

  // --- offline-data: cached results (no APK needed) -----------------------
  // These return whatever the APK has already streamed back. The POST
  // triggers (handled in the dispatcher below) need a connected APK; the GETs
  // just read the hub's cache, so they always succeed.
  if (path === '/pen/offline/notes' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ notes: penHub.getOfflineNotes() }))
    return true
  }
  if (path === '/pen/offline/pages' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(penHub.getOfflinePages() ?? { pages: [] }))
    return true
  }
  if (path === '/pen/offline/progress' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(penHub.getOfflineProgress() ?? { active: false }))
    return true
  }
  if (path === '/pen/offline/files' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ files: penHub.listOfflineFiles() }))
    return true
  }

  // --- read-only status ----------------------------------------------------
  if (path === '/pen/status' && req.method === 'GET') {
    ;(async () => {
      if (!penHub.hasClient()) {
        // Still return the last cached snapshot if we have one — useful for
        // debugging "was the APK recently connected?".
        const { state, ageMs } = penHub.getCachedState()
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'APK not connected', cached: state, cachedAgeMs: ageMs }))
        return
      }
      try {
        const state = await penHub.status()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(state))
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return true
  }

  // --- known/candidate devices ---------------------------------------------
  if (path === '/pen/devices' && req.method === 'GET') {
    ;(async () => {
      if (!penHub.hasClient()) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'APK not connected' }))
        return
      }
      try {
        const result = await penHub.listDevices()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
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
      case '/pen/connect':       return 'connect'
      case '/pen/disconnect':    return 'disconnect'
      case '/pen/scan':          return 'scan'
      case '/pen/unlock':        return 'unlock'
      case '/pen/research':      return 'research'
      case '/pen/offline/notes': return 'offlineNotes'
      case '/pen/offline/pages': return 'offlinePages'
      case '/pen/offline/pull':  return 'offlinePull'
      case '/pen/raw':           return 'raw'
      default: return null
    }
  })()
  if (!command) return false

  ;(async () => {
    if (!penHub.hasClient()) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'APK not connected' }))
      return
    }
    try {
      const body = command === 'disconnect' || command === 'offlineNotes'
        ? {}
        : JSON.parse(await readBody(req) || '{}')
      let result: unknown
      switch (command) {
        case 'connect': {
          const mac = typeof body.mac === 'string' && body.mac ? body.mac : undefined
          result = await penHub.connect(mac)
          break
        }
        case 'disconnect':
          result = await penHub.disconnect()
          break
        case 'scan': {
          const durationMs = typeof body.durationMs === 'number' ? body.durationMs : 15_000
          result = await penHub.scan(durationMs)
          break
        }
        case 'unlock': {
          const password = String(body.password ?? '')
          if (!password) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'password required' })); return }
          result = await penHub.unlock(password)
          break
        }
        case 'research':
          // Body shape: { verbose: boolean }. When true, the APK also
          // forwards heartbeat frames to the research log.
          result = await penHub.setResearch(!!body.verbose)
          break
        case 'raw': {
          const cmd = Number(body.cmd)
          if (!Number.isInteger(cmd) || cmd < 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'cmd required (integer)' }))
            return
          }
          result = await penHub.sendRaw(cmd, String(body.data ?? ''))
          break
        }
        case 'offlineNotes':
          // Triggers enumeration; results arrive async via pen_offline_notes.
          result = await penHub.reqOfflineNotes()
          break
        case 'offlinePages': {
          const section = Number(body.section)
          const owner = Number(body.owner)
          const note = Number(body.note)
          if (![section, owner, note].every(Number.isFinite)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'section, owner, note required (numbers)' }))
            return
          }
          result = await penHub.reqOfflinePages(section, owner, note)
          break
        }
        case 'offlinePull': {
          const section = Number(body.section)
          const owner = Number(body.owner)
          const note = Number(body.note)
          const page = Number(body.page)
          if (![section, owner, note, page].every(Number.isFinite)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'section, owner, note, page required (numbers)' }))
            return
          }
          result = await penHub.pullPage(section, owner, note, page)
          break
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result ?? { ok: true }))
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  })()
  return true
}
