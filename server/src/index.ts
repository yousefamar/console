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

import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session } from './session.js'
import type { ClientMessage, HubMessage } from './protocol.js'
import { BookmarkStore } from './bookmarks.js'
import { NoteStore } from './notes.js'
import { FeedStore } from './feeds.js'
import { saveManifest, loadAndClearManifest } from './manifest.js'
import { discoverProjectDirs } from './projects.js'
import { handleBookmarkRoutes } from './routes/bookmarks.js'
import { handleFeedRoutes } from './routes/feeds.js'
import { handleNoteRoutes } from './routes/notes.js'
import { handleClientMessage, createSession, type AgentContext } from './routes/agents.js'
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
// HTTP server
// --------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
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

  // Route to handlers — each returns true if it handled the request
  if (path.startsWith('/auth') && handleAuthRoutes(req, res, path, authStore, readBody, port as number)) return
  if (path.startsWith('/mail') && handleMailRoutes(req, res, path, url, gmailClient, readBody)) return
  if (path.startsWith('/cal') && handleCalendarRoutes(req, res, path, url, calendarClient, authStore, readBody)) return
  if (path.startsWith('/matrix') && handleMatrixRoutes(req, res, path, url, matrixClient, readBody)) return
  if (path.startsWith('/money') && handleMonzoRoutes(req, res, path, url, monzoClient, monzoStore, authStore, readBody, broadcast)) return
  if (path.startsWith('/bookmarks') && handleBookmarkRoutes(req, res, path, bookmarkStore, readBody)) return
  if (path.startsWith('/feeds') && handleFeedRoutes(req, res, path, url, feedStore, readBody)) return
  if (path.startsWith('/notes') && handleNoteRoutes(req, res, path, noteStore, readBody)) return

  res.writeHead(404)
  res.end('Not found')
})

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

  // Replay coalesced message logs for all active sessions
  for (const session of sessions.values()) {
    if (session.messageLog.length > 0) {
      for (const msg of session.messageLog) {
        sendTo(ws, msg)
      }
    }
  }

  // Replay Al's message log
  if (alBridge.isConnected()) {
    for (const msg of alBridge.getMessageLog()) {
      sendTo(ws, msg)
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
  log(`Console Server running on http://${host}:${port}`)
  log(`Working directory: ${cwd}`)
  log(`WebSocket: ws://${host}:${port}`)
  log(`Health check: http://${host}:${port}/health`)

  // Restore sessions from manifest
  const manifest = loadAndClearManifest()
  if (manifest.length > 0) {
    log(`Restoring ${manifest.length} session(s) from manifest...`)
    for (const entry of manifest) {
      try {
        const session = createSession(agentCtx, {
          prompt: entry.prompt,
          cwd: entry.cwd,
          resume: entry.claudeSessionId,
          silent: true,
        })
        log(`  Resumed: ${session.id} (claude: ${entry.claudeSessionId})`)
      } catch (err) {
        log(`  Failed to resume ${entry.claudeSessionId}: ${(err as Error).message}`)
      }
    }
  }

  log('')
  log('Waiting for Console to connect...')
})

// Graceful shutdown
process.on('SIGINT', () => {
  log('\nShutting down...')
  saveManifest(sessions)
  for (const session of sessions.values()) session.kill()
  authStore.destroy()
  httpServer.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  saveManifest(sessions)
  for (const session of sessions.values()) session.kill()
  authStore.destroy()
  httpServer.close()
  process.exit(0)
})

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
