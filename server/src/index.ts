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
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
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
import { discoverProjectDirs } from './projects.js'
import { handleBookmarkRoutes } from './routes/bookmarks.js'
import { handleFeedRoutes } from './routes/feeds.js'
import { handleNoteRoutes } from './routes/notes.js'
import { handleClientMessage, createSession, loadSessionOrder, type AgentContext } from './routes/agents.js'
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
import { DebugLog } from './debug-log.js'
import { handleDebugRoutes, handleDebugClientMessage } from './routes/debug.js'
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
function broadcast(msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
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

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
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
  if (path.startsWith('/matrix') && handleMatrixRoutes(req, res, path, url, matrixClient, readBody)) return
  if (path.startsWith('/money') && handleMonzoRoutes(req, res, path, url, monzoClient, monzoStore, authStore, readBody, broadcast)) return
  if (path.startsWith('/bookmarks') && handleBookmarkRoutes(req, res, path, bookmarkStore, readBody)) return
  if (path.startsWith('/feeds') && handleFeedRoutes(req, res, path, url, feedStore, readBody)) return
  if (path.startsWith('/notes') && handleNoteRoutes(req, res, path, noteStore, readBody)) return
  if (path.startsWith('/debug') && handleDebugRoutes(req, res, path, url, debugClients, debugLog, readBody)) return

  res.writeHead(404)
  res.end('Not found')
}

const httpServer = tlsOpts
  ? createHttpsServer(tlsOpts, requestHandler)
  : createHttpServer(requestHandler)

// --------------------------------------------------------------------------
// WebSocket server
// --------------------------------------------------------------------------

const wss = new WebSocketServer({ server: httpServer })

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

  // Debug agent connects on /debug path
  if (urlPath === '/debug') {
    debugClients.add(ws)
    log(`[debug] Client connected (${debugClients.size} total)`)
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
      const sessionId = (msg as { sessionId: string }).sessionId
      if (msg.type === 'send_message') {
        alBridge.handleBrowserMessage('send_message', ws, msg.content, msg.images)
      } else if (msg.type === 'interrupt') {
        alBridge.handleBrowserMessage('interrupt', ws)
      } else if (msg.type === 'kill_session') {
        alBridge.handleBrowserMessage('clear', ws)
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
        log(`  Resumed: ${session.id} (claude: ${entry.claudeSessionId})`)
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
