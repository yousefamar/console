// Hub HTTP endpoints that wrap RPC calls to the APK's glasses subsystem.
//
//   GET  /glasses/status                  — cached+live GlassesSnapshot
//   POST /glasses/text     {text}         — write a line to the display
//   POST /glasses/clear                   — blank the display (G1 "exit")
//   POST /glasses/bmp      {bmp: b64}     — 1-bpp 576x136 BMP
//   POST /glasses/notify   {appIdentifier, title, subtitle, message} → {msgId}
//   POST /glasses/notify/dismiss {msgId} — clear that card (0x4C)
//   POST /glasses/unpair   {confirm:true} — glasses forget the bond (0x47)
//   POST /glasses/mic      {active}       — start/stop mic stream
//   POST /glasses/disconnect              — DND: drop BLE but keep pairing
//   POST /glasses/scan     {durationMs?}  — trigger a BLE scan phone-side
//   POST /glasses/scan/stop               — stop the in-flight scan
//   GET  /glasses/scan/observations       — what names were seen during scans
//   POST /glasses/research {verbose}      — toggle verbose RE frame forwarding
//   GET  /glasses/research/log?n=100      — tail the reverse-engineering log
//   POST /glasses/nav/start               — native turn-by-turn card (0x0A, §18): enter
//   POST /glasses/nav/step     {direction, road, distance, eta?, remaining?, speed?, x?, y?}
//   POST /glasses/nav/arrived  {status: 1|2, prompt}
//   POST /glasses/nav/exit
//   POST /glasses/nav/map      {panoramic?, planes: b64}   — two 1-bpp planes
//   The nav routes return the firmware ack ({ok, status, ack}); 422 when the
//   frame would be refused before it is written (field over its buffer).
//   GET  /glasses/teleprompt              — {active, page, pages, title} (no APK needed)
//   POST /glasses/teleprompt/start {text, title?, multipart?} — native teleprompter (0x09, §20):
//                                         paginate + show page 1; touchbar taps page from then on
//   POST /glasses/teleprompt/next|prev|exit
//   POST /glasses/teleprompt/goto  {page}  (1-based)
//   POST /glasses/timer        {duration:"10m"|seconds:600} — native countdown (0x07, §21);
//                                         reply = firmware ack + {seconds, display}; 400 when
//                                         the duration doesn't parse or exceeds 99:59:59
//   POST /glasses/timer/cancel            — enable=0: the lens leaves the countdown screen
//
// All require the APK to be connected on /push (the phone is the BLE owner).
// If the APK isn't connected we 503 so the CLI/caller can present a useful
// "phone not reachable" error instead of hanging.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { GlassesHub, GlassesNotifyRequest, GlassesNavStep } from '../glasses-hub.js'
import type { GlassesConfig } from '../glasses/config.js'
import type { TeleprompterController } from '../glasses/teleprompter.js'
import { parseDuration, formatDuration, COUNTDOWN_MAX_SECONDS } from '../glasses/timer.js'

export function handleGlassesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  glassesHub: GlassesHub,
  readBody: (req: IncomingMessage) => Promise<string>,
  config: GlassesConfig,
  teleprompter: TeleprompterController | null = null,
): boolean {
  if (!path.startsWith('/glasses')) return false

  // --- native countdown timer (0x07) — docs/g1-protocol.md §21 ------------------
  if ((path === '/glasses/timer' || path === '/glasses/timer/cancel') && req.method === 'POST') {
    ;(async () => {
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      try {
        let seconds: number | null = null
        if (path === '/glasses/timer') {
          const body = JSON.parse(await readBody(req) || '{}')
          seconds = typeof body.seconds === 'number' ? body.seconds : parseDuration(String(body.duration ?? ''))
          if (seconds === null || !Number.isInteger(seconds) || seconds < 1 || seconds > COUNTDOWN_MAX_SECONDS) {
            return json(400, { error: `duration required — "10m", "1h30m", "90 seconds" or seconds 1..${COUNTDOWN_MAX_SECONDS} (99:59:59)` })
          }
        }
        if (!glassesHub.hasClient()) return json(503, { error: 'APK not connected' })
        const ack = await glassesHub.countdownTimer(seconds)
        return json(200, { ...ack, display: seconds === null ? null : formatDuration(seconds) })
      } catch (err) {
        return json(502, { error: (err as Error).message })
      }
    })()
    return true
  }

  // --- native teleprompter (0x09) — hub-side session, firmware ack in replies -
  if (path === '/glasses/teleprompt' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(teleprompter ? teleprompter.status() : { active: false, page: 0, pages: 0, title: null }))
    return true
  }
  if (path.startsWith('/glasses/teleprompt/') && req.method === 'POST') {
    const verb = path.slice('/glasses/teleprompt/'.length)
    if (!['start', 'next', 'prev', 'exit', 'goto'].includes(verb)) return false
    ;(async () => {
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      if (!teleprompter) return json(501, { error: 'teleprompter not wired' })
      if (verb !== 'exit' && !glassesHub.hasClient()) return json(503, { error: 'APK not connected' })
      try {
        const body = verb === 'start' || verb === 'goto' ? JSON.parse(await readBody(req) || '{}') : {}
        switch (verb) {
          case 'start': {
            const text = String(body.text ?? '')
            if (!text.trim()) return json(400, { error: 'text required' })
            return json(200, await teleprompter.start(text, { title: body.title ? String(body.title) : undefined, multipart: !!body.multipart }))
          }
          case 'next': return json(200, await teleprompter.next())
          case 'prev': return json(200, await teleprompter.prev())
          case 'goto': {
            const page = Number(body.page)
            if (!Number.isInteger(page) || page < 1) return json(422, { error: 'page must be a 1-based integer' })
            return json(200, await teleprompter.goto(page - 1))
          }
          case 'exit': return json(200, await teleprompter.stop())
        }
      } catch (err) {
        json(502, { error: (err as Error).message })
      }
    })()
    return true
  }

  // --- HUD + notification config (no APK needed; pure hub state) -----------
  if (path === '/glasses/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(config.get()))
    return true
  }
  if (path === '/glasses/config' && req.method === 'POST') {
    ;(async () => {
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const prevAngle = config.get().headUpAngleDeg
        const merged = config.merge(body)
        // Push a runtime head-up-angle change to the glasses if connected.
        if (merged.headUpAngleDeg !== prevAngle && glassesHub.hasClient()) {
          glassesHub.setHeadUpAngle(merged.headUpAngleDeg).catch(() => {})
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(merged))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return true
  }

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
        // Also ask what's on the lens (0x39) — the snapshot only carries the
        // last known value because the glasses never push it. Best-effort: a
        // BLE timeout must not fail the whole status call, so fall back to
        // whatever the APK's snapshot already had.
        let runningApp = state.runningApp ?? null
        try {
          runningApp = (await glassesHub.systemStatus(4_000)).runningApp
        } catch { /* keep the cached value */ }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...state, runningApp, runningAppLabel: describeRunningApp(runningApp) }))
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return true
  }

  // --- native navigation card (0x0A) — replies carry the firmware ack -------
  if (path.startsWith('/glasses/nav/') && req.method === 'POST') {
    const verb = path.slice('/glasses/nav/'.length)
    if (!['start', 'step', 'arrived', 'exit', 'map'].includes(verb)) return false
    ;(async () => {
      if (!glassesHub.hasClient()) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'APK not connected' }))
        return
      }
      const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
      try {
        const body = verb === 'start' || verb === 'exit' ? {} : JSON.parse(await readBody(req) || '{}')
        switch (verb) {
          case 'start': return json(200, await glassesHub.navStart())
          case 'exit': return json(200, await glassesHub.navExit())
          case 'step': {
            const step = parseNavStep(body)
            if (typeof step === 'string') return json(422, { error: step })
            return json(200, await glassesHub.navStep(step))
          }
          case 'arrived': {
            const status = Number(body.status ?? 1)
            const prompt = String(body.prompt ?? '')
            if (status !== 1 && status !== 2) return json(422, { error: 'status must be 1 (arrived) or 2 (complete)' })
            if (Buffer.byteLength(prompt, 'utf8') > NAV_PROMPT_MAX) return json(422, { error: `prompt exceeds ${NAV_PROMPT_MAX} bytes` })
            return json(200, await glassesHub.navArrived(status, prompt))
          }
          case 'map': {
            const planes = String(body.planes ?? '')
            const panoramic = !!body.panoramic
            const want = panoramic ? NAV_PANORAMIC_RAW : NAV_OVERVIEW_RAW
            const got = planes ? Buffer.from(planes, 'base64').length : 0
            if (got !== want) return json(422, { error: `planes must decode to exactly ${want} bytes (two 1-bpp planes), got ${got}` })
            return json(200, await glassesHub.navMap(panoramic, planes))
          }
        }
      } catch (err) {
        json(502, { error: (err as Error).message })
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
      case '/glasses/notify/dismiss': return 'notifyDismiss'
      case '/glasses/unpair':     return 'unpair'
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
      // Extra fields merged into the {ok:true} reply (e.g. the allocated msgId).
      let extra: Record<string, unknown> = {}
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
            // Default to the whitelisted id — firmware drops 0x4B for any
            // app_identifier not in the on-connect whitelist (io.amar.console).
            appIdentifier: String(body.appIdentifier ?? 'io.amar.console'),
            displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
            title: String(body.title ?? ''),
            subtitle: String(body.subtitle ?? ''),
            message: String(body.message ?? ''),
            timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
          }
          if (!n.title && !n.message) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'title or message required' })); return }
          // Returns the msgId the card was pushed under — the caller needs it
          // to dismiss the card later.
          extra = await glassesHub.notify(n)
          break
        }
        case 'notifyDismiss': {
          const msgId = Number(body.msgId)
          if (!Number.isInteger(msgId) || msgId < 0 || msgId > 255) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'msgId (0..255, from the notify response) required' }))
            return
          }
          await glassesHub.dismissNotification(msgId)
          extra = { msgId }
          break
        }
        case 'unpair': {
          // Destructive and physical to undo — never on an implicit call.
          if (body.confirm !== true) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'confirm: true required — the glasses forget the bond and re-pairing needs the case' }))
            return
          }
          await glassesHub.unpairGlasses()
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
      res.end(JSON.stringify({ ok: true, ...extra }))
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  })()
  return true
}

// Firmware buffer sizes (docs/g1-protocol.md §18): a field one byte over is refused whole.
const NAV_FIELD_MAX = 0x18 - 1
const NAV_ROAD_MAX = 0x40 - 1
const NAV_PROMPT_MAX = 0x40 - 1
const NAV_OVERVIEW_RAW = 17 * 136 * 2
const NAV_PANORAMIC_RAW = 61 * 136 * 2

/** Validate a nav step body against the firmware's limits. Returns the step or an error string. */
export function parseNavStep(body: Record<string, unknown>): GlassesNavStep | string {
  const direction = Number(body.direction)
  if (!Number.isInteger(direction) || direction < 1 || direction > 35) return 'direction must be an integer 1..35'
  const str = (k: string) => (body[k] == null ? '' : String(body[k]))
  const step: GlassesNavStep = {
    direction,
    road: str('road'), distance: str('distance'), eta: str('eta'), remaining: str('remaining'), speed: str('speed'),
    x: body.x == null ? 0 : Number(body.x), y: body.y == null ? 0 : Number(body.y),
  }
  if (!step.road && !step.distance) return 'road or distance required'
  for (const [k, max] of [['road', NAV_ROAD_MAX], ['distance', NAV_FIELD_MAX], ['eta', NAV_FIELD_MAX], ['remaining', NAV_FIELD_MAX], ['speed', NAV_FIELD_MAX]] as const) {
    if (Buffer.byteLength(step[k] ?? '', 'utf8') > max) return `${k} exceeds ${max} UTF-8 bytes`
  }
  if (!Number.isInteger(step.x) || !Number.isInteger(step.y) || step.x! < 0 || step.x! > 488 || step.y! < 0 || step.y! > 136) return 'x must be 0..488 and y 0..136'
  return step
}

/**
 * Human label for a `0x39` running-app id. The numeric ids are the firmware's
 * own `E_ID_*` feature enum, which we haven't mapped beyond idle — so anything
 * else is reported as its raw id rather than guessed at.
 */
export function describeRunningApp(appId: number | null): string {
  if (appId == null) return 'unknown'
  if (appId === 0) return 'idle'
  if (appId === 0xFF) return 'none'
  return `app ${appId}`
}
