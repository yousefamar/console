#!/usr/bin/env node
// ============================================================================
// Console Server — Local backend for the Console command center
//
// Provides REST APIs for bookmarks, feeds, and notes, plus a WebSocket relay
// for Claude Code agent sessions.
//
// Usage:
//   npx tsx server/src/index.ts [--port 9877] [--cwd /path/to/project]
// ============================================================================

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, existsSync, unlinkSync, watch } from 'node:fs'
import { execFile } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session } from './session.js'
import type { ClientMessage, HubMessage } from './protocol.js'
import { BookmarkStore } from './bookmarks.js'
import { NoteStore } from './notes.js'
import { FeedStore } from './feeds.js'
import { saveManifest, saveManifestSync, loadManifest } from './manifest.js'
import { discoverProjectDirs, listDirectories } from './projects.js'
import { handleBookmarkRoutes } from './routes/bookmarks.js'
import { handleFeedRoutes } from './routes/feeds.js'
import { handleNoteRoutes } from './routes/notes.js'
import { handleBlogRoutes } from './routes/blog.js'
import { handleClientMessage, createSession, loadSessionOrder, loadCollapsedGroups, type AgentContext } from './routes/agents.js'
import { setLastReadIndex, getLastReadIndex, setReadStateLogger, flushReadState } from './read-state.js'
import { HubCronScheduler } from './cron/scheduler.js'
import { handleCronRoutes } from './routes/cron.js'
import { AuthStore } from './auth-store.js'
import { handleAuthRoutes } from './routes/auth.js'
import { GmailClient } from './gmail-client.js'
import { handleMailRoutes } from './routes/mail.js'
import { CalendarClient } from './calendar-client.js'
import { handleCalendarRoutes } from './routes/calendar.js'
import { MatrixClient } from './matrix-client.js'
import { handleMatrixRoutes } from './routes/matrix.js'
import { AlBridge, AL_SESSION_ID } from './al-bridge.js'
import { MonzoClient } from './monzo-client.js'
import { MonzoStore } from './monzo-store.js'
import { handleMonzoRoutes } from './routes/monzo.js'
import { FinanceStore } from './finance/store.js'
import { handleFinanceRoutes } from './routes/finance.js'
import { PrefsStore } from './prefs-store.js'
import { handleConfigRoutes } from './routes/config.js'
import { DebugLog } from './debug-log.js'
import { handleDebugRoutes, handleDebugClientMessage } from './routes/debug.js'
import { handleApkRoutes } from './routes/apk.js'
import { PushServer } from './push.js'
import { handlePushRoutes } from './routes/push.js'
import { GlassesHub } from './glasses-hub.js'
import { handleGlassesRoutes } from './routes/glasses.js'
import { ServersConfig, CanvasDir } from './dashboard.js'
import { handleDashboardRoutes, handleCanvasRoutes, handleCanvasIslandRoutes } from './routes/dashboard.js'
import { GlassesResearchLog } from './glasses/research-log.js'
import { wireTouchToMic } from './glasses/touch-autowire.js'
import { SyncBus } from './sync-bus.js'
import { MailSync } from './mail/sync.js'
import { CalendarSync } from './cal/sync.js'
import { KeyBackupStore } from './matrix/key-backup-store.js'
import { HubMatrixCrypto } from './matrix/crypto.js'
import { MatrixSync } from './matrix/sync.js'
import type { DebugClientMessage } from './debug-protocol.js'

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const DEFAULT_PORT = 9877
const port = getArg('--port', DEFAULT_PORT)
const host = getArg('--host', 'localhost')
const cwd = getArg('--cwd', process.cwd())
const bookmarkVault = getArg('--bookmarks', join(homedir(), 'sync', 'brain', 'root', 'bookmarks'))
const notesVault = getArg('--notes', join(homedir(), 'sync', 'brain', 'root'))
const feedsConfigDir = getArg('--feeds', join(homedir(), '.config', 'console'))

// --------------------------------------------------------------------------
// Stores
// --------------------------------------------------------------------------

const bookmarkStore = new BookmarkStore(bookmarkVault)
const noteStore = new NoteStore(notesVault)
const feedStore = new FeedStore(
  join(feedsConfigDir, 'feeds.json'),
  join(feedsConfigDir, 'feed-read.json'),
)
const authStore = new AuthStore()
const debugLog = new DebugLog(join(feedsConfigDir, 'debug.log'))
const debugClients = new Set<WebSocket>()
const gmailClient = new GmailClient(authStore)
const calendarClient = new CalendarClient(authStore)
const matrixClient = new MatrixClient(authStore)
const monzoClient = new MonzoClient(authStore)
const monzoStore = new MonzoStore(
  join(feedsConfigDir, 'monzo-transactions.json'),
  monzoClient,
)
const financeStore = new FinanceStore(feedsConfigDir)
const prefsStore = new PrefsStore(join(feedsConfigDir, 'prefs.json'))
const dashboardServers = new ServersConfig(join(feedsConfigDir, 'dashboard-servers.json'))
const canvasDir = new CanvasDir(join(feedsConfigDir, 'canvas'))
const pushServer = new PushServer((msg: string) => { log(msg) })
const glassesResearchLog = new GlassesResearchLog(
  join(feedsConfigDir, 'glasses-research.log'),
)
const glassesHub = new GlassesHub(pushServer, (msg: string) => { log(msg) }, glassesResearchLog)
pushServer.onInbound((ws, frame) => glassesHub.handleMessage(ws, frame))
// Auto-arm mic on right long-press (see docs/g1-mic-stt-recipe.md). Subscriber
// lives for the process lifetime; no unsubscribe needed.
wireTouchToMic(glassesHub, (msg: string) => { log(msg) })
const syncBus = new SyncBus((msg: string) => { log(msg) })
setReadStateLogger((m: string) => { log(m) })

// Watch canvas dir + islands subdir as two separate non-recursive watchers
// because fs.watch with `recursive: true` on Linux silently stops firing
// for root-level changes once a subdir event has been delivered.
//
// On any change we debounce ~200ms then:
//  - If the islands set has items, recompose index.html (overrides any
//    direct write to index.html — the islands-mode invariant).
//  - Broadcast `dashboard.canvas_changed` so the SPA iframe live-reloads.
{
  let pending: ReturnType<typeof setTimeout> | null = null
  // Suppress one self-write echo after the composer rewrites index.html.
  let justRecomposed = false
  const schedule = (source: string, filename: string | null) => {
    // Skip the composer's own echo on index.html.
    if (source === 'root' && filename === 'index.html' && justRecomposed) {
      justRecomposed = false
      return
    }
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      // Re-check at tick time, not at event time — event-time hasIslands()
      // can race with the FS write that triggered the event.
      if (canvasDir.hasIslands()) {
        canvasDir.composeIndexHtml()
        justRecomposed = true
      }
      syncBus.broadcast('dashboard', 'canvas_changed', canvasDir.metadata())
    }, 200)
  }
  try {
    watch(canvasDir.dir, { persistent: false }, (_evt, filename) => {
      schedule('root', typeof filename === 'string' ? filename : null)
    })
    log(`[dashboard] watching canvas root: ${canvasDir.dir}`)
  } catch (e) {
    log(`[dashboard] canvas root watch failed: ${(e as Error).message}`)
  }
  try {
    watch(canvasDir.islandsDir, { persistent: false }, (_evt, filename) => {
      schedule('islands', typeof filename === 'string' ? filename : null)
    })
    log(`[dashboard] watching canvas islands: ${canvasDir.islandsDir}`)
  } catch (e) {
    log(`[dashboard] canvas islands watch failed: ${(e as Error).message}`)
  }
}
const mailSync = new MailSync(
  gmailClient,
  authStore,
  syncBus,
  pushServer,
  join(feedsConfigDir, 'mail-state.json'),
  (msg: string) => { log(msg) },
)
syncBus.register('mail', {
  syncNow: async () => mailSync.syncNow(),
})
mailSync.start()
const calSync = new CalendarSync(
  calendarClient,
  authStore,
  syncBus,
  pushServer,
  join(feedsConfigDir, 'cal-state.json'),
  (msg: string) => { log(msg) },
)
syncBus.register('cal', {
  syncNow: async () => calSync.syncNow(),
})
calSync.start()
const keyBackupStore = new KeyBackupStore(
  join(feedsConfigDir, 'matrix-key-backup.json'),
  (msg: string) => { log(msg) },
)
const hubMatrixCrypto = new HubMatrixCrypto(
  join(feedsConfigDir, 'matrix-crypto-snapshot.json'),
  (msg: string) => { log(msg) },
)
// If hub already has Matrix credentials, re-init OlmMachine on boot so
// decryption capability survives restarts without requiring re-login.
// When a snapshot exists it's restored first (fast-path: identity preserved).
// When no snapshot exists (first boot after credentials, or schema-rebuild)
// we still init with the existing device_id; OlmMachine generates fresh Olm
// account keys and re-uploads them, then we re-import the M0 key backup so
// historical room decrypts still work.
{
  const existingMatrix = authStore.getMatrixConfig()
  if (existingMatrix) {
    const snapshotExists = existsSync(join(feedsConfigDir, 'matrix-crypto-snapshot.json'))
    ;(async () => {
      await hubMatrixCrypto.init(existingMatrix.userId, existingMatrix.deviceId)
      if (snapshotExists) {
        log('[hub-crypto] re-initialized from snapshot')
      } else {
        log('[hub-crypto] re-initialized with existing device_id (fresh Olm account)')
        // Re-upload device keys + OTKs under the existing access token.
        await hubMatrixCrypto.processOutgoingRequests(
          existingMatrix.homeserver,
          existingMatrix.accessToken,
        )
        // Re-import M0 safety-net keys so decrypt still works.
        const backup = keyBackupStore.get()
        if (backup && backup.userId === existingMatrix.userId) {
          const r = await hubMatrixCrypto.importRoomKeys(backup.keys)
          log(`[hub-crypto] re-imported ${r.imported}/${r.total} room keys from M0 backup`)
        }
      }
      // Activate server-side key-backup UPLOAD on every boot. Encryption-only
      // path — uses the backup version's public key, so no recovery key
      // needed. Ensures every Megolm session the hub receives from here on
      // flows into /room_keys/keys and survives hub re-login / re-init.
      const act = await hubMatrixCrypto.activateBackupUpload(
        existingMatrix.homeserver,
        existingMatrix.accessToken,
      ).catch((e): { enabled: boolean; version?: string; reason?: string } =>
        ({ enabled: false, reason: (e as Error).message }))
      if (act.enabled) {
        log(`[hub-crypto] backup upload activated (version ${act.version})`)
        // Sweep any pre-existing sessions that weren't uploaded (e.g. keys
        // imported from M0 or received while backup was inactive).
        hubMatrixCrypto.backupPendingRoomKeys(
          existingMatrix.homeserver,
          existingMatrix.accessToken,
        ).then((n) => { if (n > 0) log(`[hub-crypto] backed up ${n} pending room keys`) })
          .catch((e) => log(`[hub-crypto] initial backup sweep failed: ${e}`))
      } else {
        log(`[hub-crypto] backup upload NOT activated: ${act.reason}`)
      }
    })().catch((e) => log(`[hub-crypto] boot init failed: ${e}`))
  }
}
// Matrix sync loop — starts once crypto is ready (polled).
const matrixSync = new MatrixSync(
  matrixClient,
  hubMatrixCrypto,
  authStore,
  syncBus,
  pushServer,
  join(feedsConfigDir, 'matrix-sync-state.json'),
  (msg: string) => { log(msg) },
)
syncBus.register('matrix', {
  syncNow: async () => matrixSync.syncNow(),
  // Point-to-point resume: caller supplies its last-seen `since`; returns the
  // delta directly instead of broadcasting. Without `since`, behaves like the
  // old `snapshot` (cold-start initial sync). Response includes `isInitial`
  // so the client can tell a resume-merge from a cold-start reset.
  resume: async (args) => matrixSync.resume(args as { since?: string } | undefined),
  state: async () => matrixSync.getState(),
  // Unified send: hub picks encrypted vs plaintext based on room state
  sendEvent: async (args) => matrixSync.sendRoomEvent(args as { roomId: string; type: string; content: Record<string, unknown> }),
  redact: async (args) => matrixSync.redactEvent(args as { roomId: string; eventId: string; reason?: string }),
  markRead: async (args) => matrixSync.markRead(args as { roomId: string; eventId: string }),
  paginate: async (args) => matrixSync.paginate(args as { roomId: string; from?: string; dir?: 'b' | 'f'; limit?: number }),
  // Discard the outbound Megolm session for a room so the next send forces
  // a fresh shareRoomKey round — used when a bridge reports FAIL_RETRIABLE.
  rotateRoomKey: async (args) => matrixSync.rotateRoomKey(args as { roomId: string }),
})
matrixSync.start()

function markAlRead() {
  const len = alBridge.getMessageLog().length
  setLastReadIndex(AL_SESSION_ID, len)
  broadcast({ type: 'session_read_state', sessionId: AL_SESSION_ID, lastReadIndex: len, messageLogLength: len })
}

function markAlUnread() {
  const len = alBridge.getMessageLog().length
  const idx = Math.max(0, len - 1)
  setLastReadIndex(AL_SESSION_ID, idx)
  broadcast({ type: 'session_read_state', sessionId: AL_SESSION_ID, lastReadIndex: idx, messageLogLength: len })
}

function broadcast(msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
  // Mirror selected events into the push channel so the APK foreground
  // service can surface them as system notifications when backgrounded.
  if (msg.type === 'approval_required') {
    const toolName = (msg as any).toolName as string | undefined
    const input = (msg as any).input as Record<string, unknown> | undefined
    const question = typeof input?.question === 'string' ? input.question : ''
    pushServer.broadcast({
      type: 'agent',
      title: toolName === 'AskUserQuestion' ? 'Agent needs your input' : 'Agent needs approval',
      body: question || toolName || 'Tap to respond',
      pane: 'agents',
      id: `approval:${(msg as any).requestId ?? (msg as any).sessionId}`,
    })
  } else if (msg.type === 'tool_approved' || msg.type === 'tool_denied') {
    // Dismiss the phone notification once the question is answered —
    // whether from the web app, CLI, or another client.
    const requestId = (msg as any).requestId ?? (msg as any).sessionId
    pushServer.broadcast({
      type: 'agent',
      cancel: true,
      id: `approval:${requestId}`,
    })
  }
}

const alBridge = new AlBridge({
  broadcast,
  broadcastExcept: (sender: WebSocket, msg: HubMessage) => {
    const data = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(data)
    }
  },
  log,
})

// --------------------------------------------------------------------------
// Session registry
// --------------------------------------------------------------------------

const sessions = new Map<string, Session>()
const clients = new Set<WebSocket>()

const agentCtx: AgentContext = { sessions, clients, cwd, log, truncate }

const cronScheduler = new HubCronScheduler(
  join(feedsConfigDir, 'agent-cron.json'),
  () => sessions,
  (msg) => broadcast(msg),
  (m) => log(m),
)
cronScheduler.start()

// Wire Al session updates to broadcast full session list
alBridge.onSessionUpdate = () => {
  const active = Array.from(sessions.values()).map((s) => s.getInfo())
  if (alBridge.isConnected()) active.unshift(alBridge.getSessionInfo())
  const listMsg: HubMessage = { type: 'sessions_list', sessions: active }
  const data = JSON.stringify(listMsg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

// --------------------------------------------------------------------------
// HTTP/HTTPS server
// --------------------------------------------------------------------------

// Use HTTPS if Tailscale certs are available
const configDir = join(homedir(), '.config', 'console')
const tsHost = 'amarhp-lin.rya-yo.ts.net'
const certPath = join(configDir, `${tsHost}.crt`)
const keyPath = join(configDir, `${tsHost}.key`)
const hasTls = existsSync(certPath) && existsSync(keyPath)
const tlsOpts = hasTls ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : null

// Browser-origin allow-list. SPA shell goes public via Tailscale Funnel on
// :8443 (same `*.ts.net` hostname as the tailnet, but reachable from
// anywhere); hub stays tailnet-only on :9877. Without this lockdown any site
// you visit while on tailnet could pivot to read your hub. Server-to-server
// clients (CLI / Al / glasses / Node WS) send no Origin header — handled
// separately for WS, harmless for HTTP since CORS only matters when a
// browser is involved.
const ALLOWED_ORIGINS = new Set([
  `https://${tsHost}:8443`,    // Funnel (public)
  `https://${tsHost}:5173`,    // Vite dev (HMR, tailnet)
  'https://localhost:5173',    // local dev
  'http://localhost:5173',     // local dev (no certs)
])

function originAllowed(origin: string | undefined): boolean {
  return !!origin && ALLOWED_ORIGINS.has(origin)
}

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  const origin = req.headers.origin
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Health check
  if (path === '/health') {
    const sessionList = Array.from(sessions.values()).map((s) => s.getInfo())
    // Include Al in session list if connected
    if (alBridge.isConnected()) sessionList.unshift(alBridge.getSessionInfo())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, version: '0.3.0', sessions: sessionList, cwd }))
    return
  }

  // Filesystem directory autocomplete for the agent prompt's "new session" picker.
  // Returns subdirectories matching `?q=<partial path>`. The prefix is split into
  // (parent dir, name fragment); we list parent and filter by case-insensitive prefix.
  if (path === '/agents/list-dirs') {
    const q = url.searchParams.get('q') ?? ''
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ dirs: listDirectories(q) }))
    return
  }

  // STT — transcribes audio via OpenAI Whisper API
  if (path === '/stt' && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks)
        // Parse multipart form data to extract the audio file
        const boundary = (req.headers['content-type'] || '').split('boundary=')[1]
        if (!boundary) { res.writeHead(400); res.end('Missing boundary'); return }
        const parts = body.toString('binary').split('--' + boundary)
        let audioData: Buffer | null = null
        for (const part of parts) {
          if (part.includes('name="file"')) {
            const headerEnd = part.indexOf('\r\n\r\n')
            if (headerEnd !== -1) {
              audioData = Buffer.from(part.slice(headerEnd + 4).replace(/\r\n$/, ''), 'binary')
            }
          }
        }
        if (!audioData || audioData.length < 100) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '' })); return }

        // Get OpenAI API key from environment
        const apiKey = process.env.OPENAI_API_KEY
        if (!apiKey) { res.writeHead(500); res.end('OPENAI_API_KEY not set'); return }

        // Build multipart form for OpenAI
        const formBoundary = '----FormBoundary' + Date.now()
        const formParts = [
          `--${formBoundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`,
          audioData,
          `\r\n--${formBoundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${formBoundary}--\r\n`,
        ]
        const formBody = Buffer.concat([Buffer.from(formParts[0] as string), formParts[1] as Buffer, Buffer.from(formParts[2] as string)])

        const apiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${formBoundary}`,
          },
          body: formBody,
        })
        if (!apiRes.ok) {
          const errText = await apiRes.text()
          log(`[stt] OpenAI error: ${apiRes.status} ${errText.slice(0, 200)}`)
          res.writeHead(500); res.end('STT failed')
          return
        }
        const result = await apiRes.json() as { text: string }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: result.text }))
      } catch (err) {
        log(`[stt] Error: ${(err as Error).message}`)
        res.writeHead(500); res.end('STT error')
      }
    })
    return
  }

  // TTS — converts text to speech via espeak-ng, returns WAV audio
  if (path === '/tts' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body)
        if (!text) { res.writeHead(400); res.end('Missing text'); return }
        const voice = 'en-GB-RyanNeural'
        const tmpFile = `/tmp/tts-${Date.now()}.mp3`
        execFile('edge-tts', ['--voice', voice, '--text', text.slice(0, 5000), '--write-media', tmpFile], { timeout: 30000 }, (err) => {
          if (err) {
            // Fallback to espeak-ng
            execFile('espeak-ng', ['--stdout', text.slice(0, 5000)], { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024, timeout: 10000 }, (err2, stdout) => {
              if (err2) { res.writeHead(500); res.end('TTS failed'); return }
              res.writeHead(200, { 'Content-Type': 'audio/wav' })
              res.end(stdout)
            })
            return
          }
          try {
            const audio = readFileSync(tmpFile)
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
            res.end(audio)
            unlinkSync(tmpFile)
          } catch { res.writeHead(500); res.end('TTS read failed') }
        })
      } catch { res.writeHead(400); res.end('Invalid JSON') }
    })
    return
  }

  // Icon proxy — serves remote images as same-origin for notification icons
  if (path === '/proxy/icon' && req.method === 'GET') {
    const iconUrl = url.searchParams.get('url')
    if (!iconUrl) {
      res.writeHead(400)
      res.end('Missing url param')
      return
    }
    try {
      const iconRes = await fetch(iconUrl)
      if (!iconRes.ok) {
        res.writeHead(iconRes.status)
        res.end()
        return
      }
      const contentType = iconRes.headers.get('content-type') || 'image/png'
      const buffer = Buffer.from(await iconRes.arrayBuffer())
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      })
      res.end(buffer)
    } catch {
      res.writeHead(502)
      res.end()
    }
    return
  }

  // Route to handlers — each returns true if it handled the request
  if (path.startsWith('/auth') && handleAuthRoutes(req, res, path, authStore, readBody, port as number)) return
  if (path.startsWith('/mail') && handleMailRoutes(req, res, path, url, gmailClient, readBody)) return
  if (path.startsWith('/cal') && handleCalendarRoutes(req, res, path, url, calendarClient, authStore, readBody)) return
  if (path.startsWith('/matrix') && handleMatrixRoutes(req, res, path, url, matrixClient, keyBackupStore, hubMatrixCrypto, authStore, matrixSync, readBody)) return
  if (path.startsWith('/money') && handleMonzoRoutes(req, res, path, url, monzoClient, monzoStore, authStore, readBody, broadcast, pushServer)) return
  if (path.startsWith('/finance') && handleFinanceRoutes(req, res, path, url, financeStore, monzoStore, monzoClient, authStore, readBody)) return
  if (path.startsWith('/bookmarks') && handleBookmarkRoutes(req, res, path, bookmarkStore, readBody)) return
  if (path.startsWith('/feeds') && handleFeedRoutes(req, res, path, url, feedStore, readBody)) return
  if (path.startsWith('/notes') && handleNoteRoutes(req, res, path, noteStore, readBody)) return
  if (path.startsWith('/blog') && handleBlogRoutes(req, res, path, noteStore, readBody)) return
  if (path.startsWith('/debug') && handleDebugRoutes(req, res, path, url, debugClients, debugLog, readBody)) return
  if (path.startsWith('/apk') && handleApkRoutes(req, res, path)) return
  if (path.startsWith('/push') && handlePushRoutes(req, res, path, pushServer, readBody)) return
  if (path.startsWith('/glasses') && handleGlassesRoutes(req, res, path, glassesHub, readBody)) return
  if (path === '/config' && handleConfigRoutes(req, res, path, prefsStore, readBody)) return
  if (path.startsWith('/dashboard/canvas/islands') && handleCanvasIslandRoutes(req, res, path, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog,
  }, readBody)) return
  if (path.startsWith('/dashboard') && handleDashboardRoutes(req, res, path, url, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog,
  }, readBody)) return
  if (path.startsWith('/canvas') && handleCanvasRoutes(req, res, path, {
    servers: dashboardServers, canvas: canvasDir, sessions, cal: calSync, debugLog,
  })) return
  if ((path === '/cron' || path === '/cron.ics' || path.startsWith('/cron/')) && handleCronRoutes(req, res, path, url, {
    scheduler: cronScheduler, getSessions: () => sessions, getAlConnected: () => alBridge.isConnected(), log,
  }, readBody)) return

  res.writeHead(404)
  res.end('Not found')
}

const httpServer = tlsOpts
  ? createHttpsServer(tlsOpts, requestHandler)
  : createHttpServer(requestHandler)

// --------------------------------------------------------------------------
// WebSocket server
// --------------------------------------------------------------------------

// WS Origin gate. Browsers always send `Origin`; Node-side clients (CLI, Al,
// glasses, debug) don't. Reject browser connections from unknown origins so a
// malicious site can't bypass CORS via WebSocket.
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info: { origin: string }) => !info.origin || originAllowed(info.origin),
})

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const urlPath = req.url ?? '/'

  // Al connects on /al path — handle separately from browser clients
  if (urlPath === '/al') {
    log('[al] Al connecting...')
    alBridge.handleAlConnection(ws)

    // Broadcast updated session list to all browser clients
    const active = Array.from(sessions.values()).map((s) => s.getInfo())
    if (alBridge.isConnected()) active.unshift(alBridge.getSessionInfo())
    const listMsg: HubMessage = { type: 'sessions_list', sessions: active }
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(listMsg))
    }
    return
  }

  // Push clients (Android foreground service) connect on /push path
  if (urlPath === '/push') {
    pushServer.attach(ws)
    return
  }

  // Glasses raw LC3 audio fanout (typically one subscriber: Al / STT bridge).
  // Frames: `{type:'audio', seq, lc3b64}`. Each frame is ~200B LC3 at ~50fps.
  // Decode to PCM happens on the *consumer* — see docs/g1-mic-stt-recipe.md.
  if (urlPath === '/glasses/mic') {
    log(`[glasses] audio subscriber connected`)
    const unsub = glassesHub.onAudio((f) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'audio', seq: f.seq, lc3b64: f.lc3b64 })) } catch { /* ignore */ }
      }
    })
    ws.on('close', () => { unsub(); log(`[glasses] audio subscriber disconnected`) })
    return
  }

  // Glasses touchbar events (taps, long-presses, swipes) fanout.
  if (urlPath === '/glasses/events') {
    log(`[glasses] event subscriber connected`)
    const unsubTouch = glassesHub.onTouch((f) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'touch', arm: f.arm, subcmd: f.subcmd })) } catch { /* ignore */ }
      }
    })
    ws.on('close', () => { unsubTouch(); log(`[glasses] event subscriber disconnected`) })
    return
  }

  // Sync bus — service event streams + RPC for hub-owned services
  if (urlPath === '/sync') {
    syncBus.attach(ws)
    return
  }

  // Debug agent connects on /debug path
  if (urlPath === '/debug') {
    // Stash the upgrade request's User-Agent on the socket so debug RPCs can
    // target a specific client (desktop browser vs. APK WebView vs. mobile
    // browser) by substring. `.ua` is read in handleDebugRoutes via the
    // `(ws as any).ua` cast.
    ;(ws as any).ua = (req.headers['user-agent'] as string | undefined) ?? ''
    debugClients.add(ws)
    log(`[debug] Client connected (${debugClients.size} total): ${(ws as any).ua.slice(0, 80)}`)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as DebugClientMessage
        handleDebugClientMessage(msg, debugLog)
      } catch { /* ignore malformed */ }
    })
    ws.on('close', () => {
      debugClients.delete(ws)
      log(`[debug] Client disconnected (${debugClients.size} remaining)`)
    })
    return
  }

  // STT WebSocket relay — bridges browser audio to OpenAI Realtime Transcription API
  if (urlPath === '/stt') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'error', message: 'OPENAI_API_KEY not set' }))
      ws.close()
      return
    }
    log('[stt] Client connected, opening OpenAI realtime transcription...')
    // gpt-realtime-whisper streams transcript deltas word-by-word as audio
    // arrives (vs gpt-4o-mini-transcribe's bursty sentence-boundary commits).
    // Session payload shape changed in the May 2026 voice-intelligence drop —
    // nested under `audio.input.*` and the message type is now `session.update`,
    // not `transcription_session.update`.
    const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime/transcription', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
    })

    // Periodically commit the audio buffer to force transcription during continuous speech
    let commitInterval: ReturnType<typeof setInterval> | null = null

    openaiWs.on('open', () => {
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              // Client (AgentPromptInput) captures via AudioContext at 24000 Hz
              // mono PCM16; keep these in sync if either side changes.
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'gpt-realtime-whisper', language: 'en' },
              turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
              noise_reduction: { type: 'near_field' },
            },
          },
        },
      }))
    })

    openaiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        // Log all event types for debugging (except session updates which are noisy)
        if (msg.type && !msg.type.startsWith('transcription_session')) {
          log(`[stt] event: ${msg.type}`)
        }
        if (msg.type === 'conversation.item.input_audio_transcription.delta') {
          ws.send(JSON.stringify({ type: 'interim', text: msg.delta || '' }))
        } else if (msg.type === 'conversation.item.input_audio_transcription.completed') {
          ws.send(JSON.stringify({ type: 'final', text: msg.transcript || '' }))
        } else if (msg.type === 'conversation.item.input_audio_transcription.failed') {
          // Log the full failure payload — OpenAI puts the reason inside `error`
          log(`[stt] transcription failed: ${JSON.stringify(msg).slice(0, 500)}`)
          ws.send(JSON.stringify({ type: 'error', message: msg.error?.message || 'Transcription failed' }))
        } else if (msg.type === 'error') {
          log(`[stt] OpenAI error: ${JSON.stringify(msg.error)}`)
          ws.send(JSON.stringify({ type: 'error', message: msg.error?.message || 'Transcription error' }))
        }
      } catch { /* ignore */ }
    })

    openaiWs.on('close', (code, reason) => {
      log(`[stt] OpenAI WS closed code=${code} reason=${reason?.toString().slice(0, 200) || '(none)'}`)
      if (commitInterval) clearInterval(commitInterval)
      ws.close()
    })
    openaiWs.on('error', (err) => {
      log(`[stt] OpenAI WS error: ${(err as Error).message}`)
      if (commitInterval) clearInterval(commitInterval)
      ws.close()
    })
    openaiWs.on('unexpected-response', (_req, res) => {
      log(`[stt] OpenAI WS handshake failed: HTTP ${res.statusCode} ${res.statusMessage}`)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'audio' && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.data }))
        }
      } catch { /* ignore */ }
    })

    ws.on('close', () => {
      log('[stt] Client disconnected')
      if (commitInterval) clearInterval(commitInterval)
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close()
    })
    return
  }

  // Browser client
  clients.add(ws)
  log(`Client connected from ${req.socket.remoteAddress} (${clients.size} total)`)

  // Send project directories on connect
  const dirs = discoverProjectDirs()
  sendTo(ws, { type: 'project_dirs', dirs })

  // Send current session list (including Al if connected)
  const active = Array.from(sessions.values()).map((s) => s.getInfo())
  if (alBridge.isConnected()) active.unshift(alBridge.getSessionInfo())
  sendTo(ws, { type: 'sessions_list', sessions: active })

  // Send session order (translated from persisted claudeSessionIds to current hub IDs)
  const order = loadSessionOrder(sessions)
  if (order.length > 0) {
    sendTo(ws, { type: 'session_order', order })
  }

  // Send collapsed-groups state (keyed by cwd, stable across restarts)
  const collapsed = loadCollapsedGroups()
  if (collapsed.length > 0) {
    sendTo(ws, { type: 'collapsed_groups', collapsed })
  }

  // Replay last REPLAY_LIMIT messages per session (older messages loaded on scroll-up)
  const REPLAY_LIMIT = 50
  for (const session of sessions.values()) {
    const log = session.messageLog
    if (log.length > 0) {
      const start = Math.max(0, log.length - REPLAY_LIMIT)
      for (let i = start; i < log.length; i++) {
        sendTo(ws, log[i]!)
      }
    }
  }

  // Replay last REPLAY_LIMIT Al messages
  if (alBridge.isConnected()) {
    const alLog = alBridge.getMessageLog()
    const start = Math.max(0, alLog.length - REPLAY_LIMIT)
    for (let i = start; i < alLog.length; i++) {
      sendTo(ws, alLog[i]!)
    }
  }

  ws.on('message', (data) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(data.toString()) as ClientMessage
    } catch {
      sendTo(ws, { type: 'hub_error', message: 'Invalid JSON' })
      return
    }

    // Handle older message pagination (works for both Al and regular sessions)
    if (msg.type === 'get_older_messages') {
      const PAGE = (msg as any).limit || 50
      const beforeIndex = (msg as any).beforeIndex as number
      const sessionId = (msg as any).sessionId as string
      const log = sessionId === AL_SESSION_ID
        ? alBridge.getMessageLog()
        : sessions.get(sessionId)?.messageLog
      if (log) {
        const end = Math.min(beforeIndex, log.length)
        const start = Math.max(0, end - PAGE)
        const slice = log.slice(start, end)
        sendTo(ws, { type: 'older_messages', sessionId, messages: slice, hasMore: start > 0 })
      } else {
        sendTo(ws, { type: 'older_messages', sessionId, messages: [], hasMore: false })
      }
      return
    }

    // Route Al-targeted messages to the bridge
    if ('sessionId' in msg && (msg as { sessionId?: string }).sessionId === AL_SESSION_ID) {
      if (msg.type === 'send_message') {
        alBridge.handleBrowserMessage('send_message', ws, msg.content, msg.images)
        markAlRead()
      } else if (msg.type === 'interrupt') {
        alBridge.handleBrowserMessage('interrupt', ws)
      } else if (msg.type === 'kill_session') {
        alBridge.handleBrowserMessage('clear', ws)
      } else if (msg.type === 'mark_session_read') {
        markAlRead()
      } else if (msg.type === 'mark_session_unread') {
        markAlUnread()
      }
      return
    }

    handleClientMessage(agentCtx, ws, msg)
  })

  ws.on('close', () => {
    clients.delete(ws)
    log(`Client disconnected (${clients.size} remaining)`)
  })

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`)
    clients.delete(ws)
  })
})

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

httpServer.listen(port, host, () => {
  const proto = tlsOpts ? 'https' : 'http'
  const wsproto = tlsOpts ? 'wss' : 'ws'
  log(`Console Server running on ${proto}://${host}:${port}`)
  log(`Working directory: ${cwd}`)
  log(`WebSocket: ${wsproto}://${host}:${port}`)
  log(`Health check: ${proto}://${host}:${port}/health`)
  if (tlsOpts) log(`TLS: using ${certPath}`)

  // Restore sessions from manifest
  const manifest = loadManifest()
  if (manifest.length > 0) {
    log(`Restoring ${manifest.length} session(s) from manifest...`)
    for (const entry of manifest) {
      try {
        const session = createSession(agentCtx, {
          prompt: entry.prompt,
          cwd: entry.cwd,
          resume: entry.claudeSessionId,
          silent: true,
          name: entry.name,
        })
        // If the session was mid-turn when the hub stopped, nudge it to
        // continue where it left off. Silent resume alone leaves it idle.
        if (entry.wasRunning) {
          setTimeout(() => {
            if (session.status !== 'ended') {
              const content = 'The hub was restarted, which interrupted you. Continue.'
              // Mirror the UI send-message path: broadcast + log so the prompt
              // appears in the conversation view, not just on Claude's stdin.
              const userMsg = { type: 'user_prompt' as const, sessionId: session.id, content }
              broadcast(userMsg)
              session.logMessage(userMsg)
              session.sendMessage(content)
            }
          }, 1_000)
          log(`  Resumed + continued: ${session.id} (claude: ${entry.claudeSessionId})`)
        } else {
          log(`  Resumed: ${session.id} (claude: ${entry.claudeSessionId})`)
        }
      } catch (err) {
        log(`  Failed to resume ${entry.claudeSessionId}: ${(err as Error).message}`)
      }
    }
    // Save manifest immediately so restored sessions are persisted
    saveManifest(sessions)
  }

  log('')
  log('Waiting for Console to connect...')
})

// Graceful shutdown — save manifest synchronously before exit
function shutdown() {
  log('\nShutting down — saving manifest...')
  saveManifestSync(sessions)
  flushReadState()
  cronScheduler.flush()
  for (const session of sessions.values()) session.kill()
  authStore.destroy()
  httpServer.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)


// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

function sendTo(ws: WebSocket, msg: HubMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ${msg}`)
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function getArg(flag: string, fallback: string): string
function getArg(flag: string, fallback: number): number
function getArg(flag: string, fallback: string | number): string | number {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx >= process.argv.length - 1) return fallback
  const val = process.argv[idx + 1]!
  return typeof fallback === 'number' ? parseInt(val, 10) : val
}
