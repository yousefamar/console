#!/usr/bin/env node
// ============================================================================
// Console Agent Hub — Local WebSocket server for Claude Code integration
//
// Spawns Claude CLI subprocesses with stream-json I/O and relays messages
// to/from the Console browser app over WebSocket.
//
// Usage:
//   npx tsx agent-hub/src/index.ts [--port 9877] [--cwd /path/to/project]
//
// The Console frontend connects to ws://localhost:9877 and sends/receives
// JSON messages defined in protocol.ts.
// ============================================================================

import { createServer, type IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { Session, type SessionOptions } from './session.js'
import type { ClientMessage, HubMessage, PastSession, SessionInfo, ClaudeContentBlock } from './protocol.js'
import { cwdToProjectDir } from './utils.js'
import { BookmarkStore } from './bookmarks.js'
import { NoteStore } from './notes.js'

// --------------------------------------------------------------------------
// Session manifest — persists active sessions across hub restarts
// --------------------------------------------------------------------------

const MANIFEST_PATH = join(homedir(), '.claude', 'console-hub-sessions.json')

interface ManifestEntry {
  claudeSessionId: string
  cwd: string
  prompt: string
}

function saveManifest() {
  // Deduplicate by claudeSessionId — only keep the latest session per Claude session
  const seen = new Set<string>()
  const entries: ManifestEntry[] = []
  for (const session of sessions.values()) {
    if (session.status !== 'ended' && session.claudeSessionId && !seen.has(session.claudeSessionId)) {
      seen.add(session.claudeSessionId)
      entries.push({
        claudeSessionId: session.claudeSessionId,
        cwd: session.cwd,
        prompt: session.initialPrompt,
      })
    }
  }
  try {
    writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2))
  } catch {
    // Best effort
  }
}

function loadAndClearManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return []
  try {
    const data = readFileSync(MANIFEST_PATH, 'utf-8')
    unlinkSync(MANIFEST_PATH)
    return JSON.parse(data) as ManifestEntry[]
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
// JSONL session history loader
// --------------------------------------------------------------------------

interface HistoryMessage {
  type: 'user_prompt' | 'text' | 'thinking' | 'tool_use' | 'tool_result'
  content?: string
  toolUseId?: string
  toolName?: string
  input?: Record<string, unknown>
  isError?: boolean
  images?: string[]
}

/**
 * Read a Claude JSONL session file and extract the conversation history
 * as simplified message blocks for the frontend.
 */
function loadSessionHistory(claudeSessionId: string, cwdPath: string): HistoryMessage[] {
  const encoded = cwdToProjectDir(cwdPath)
  const filePath = join(homedir(), '.claude', 'projects', encoded, `${claudeSessionId}.jsonl`)
  if (!existsSync(filePath)) return []

  const messages: HistoryMessage[] = []
  const lines = readFileSync(filePath, 'utf-8').split('\n')

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.isSidechain) continue

      if (obj.type === 'user' && !obj.isMeta) {
        const content = obj.message?.content
        if (typeof content === 'string' && !content.startsWith('<')) {
          messages.push({ type: 'user_prompt', content })
        } else if (Array.isArray(content)) {
          // Check for tool_result blocks (skip these as prompts)
          const hasToolResult = content.some((b: ClaudeContentBlock) => b.type === 'tool_result')
          if (hasToolResult) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const resultContent = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: { text: string }) => c.text).join('\n')
                    : String(block.content)
                messages.push({
                  type: 'tool_result',
                  toolUseId: block.tool_use_id,
                  content: resultContent,
                  isError: block.is_error ?? false,
                })
              }
            }
          } else {
            // User message with text/image blocks
            const textBlock = content.find((b: { type: string }) => b.type === 'text')
            if (textBlock?.text && !textBlock.text.startsWith('<')) {
              messages.push({ type: 'user_prompt', content: textBlock.text })
            }
          }
        }
      } else if (obj.type === 'assistant') {
        const content = obj.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              messages.push({ type: 'text', content: block.text })
            } else if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', content: block.thinking })
            } else if (block.type === 'tool_use') {
              messages.push({
                type: 'tool_use',
                toolUseId: block.id,
                toolName: block.name,
                input: block.input,
              })
            }
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const DEFAULT_PORT = 9877
const port = getArg('--port', DEFAULT_PORT)
const host = getArg('--host', 'localhost')
const cwd = getArg('--cwd', process.cwd())
const bookmarkVault = getArg('--bookmarks', join(homedir(), 'sync', 'brain', 'root', 'bookmarks'))
const notesVault = getArg('--notes', join(homedir(), 'sync', 'brain', 'root'))

// --------------------------------------------------------------------------
// Bookmark store
// --------------------------------------------------------------------------

const bookmarkStore = new BookmarkStore(bookmarkVault)
const noteStore = new NoteStore(notesVault)

// --------------------------------------------------------------------------
// Project directory discovery
// --------------------------------------------------------------------------

/**
 * Decode a Claude projects folder name back to a real filesystem path.
 * e.g. `-home-amar-proj-code-artanis-home-page` → `/home/amar/proj/code/artanis/home-page`
 *
 * Uses backtracking: at each segment boundary (hyphen), try inserting `/` first
 * and check if the prefix exists on disk. If not, treat the hyphen as literal.
 */
function decodeClaudePath(encoded: string): string | null {
  // Remove leading hyphen — it represents the root `/`
  if (!encoded.startsWith('-')) return null
  const rest = encoded.slice(1)
  const parts = rest.split('-')
  if (parts.length === 0) return null

  // Backtracking decoder
  function solve(index: number, currentPath: string): string | null {
    if (index >= parts.length) {
      // Reached end — check if the full path exists
      return existsSync(currentPath) ? currentPath : null
    }

    const segment = parts[index]!

    // Option 1: Start a new path segment (insert `/`)
    const withSlash = currentPath + '/' + segment
    // Only check existence for intermediate directories (not the final path yet)
    if (index < parts.length - 1) {
      // Try extending with more hyphens first before checking slash
      // But prioritize the slash path if the directory exists
      if (existsSync(withSlash)) {
        const result = solve(index + 1, withSlash)
        if (result) return result
      }
    } else {
      const result = solve(index + 1, withSlash)
      if (result) return result
    }

    // Option 2: Append as hyphenated continuation of current segment
    if (currentPath.length > 0) {
      const withHyphen = currentPath + '-' + segment
      const result = solve(index + 1, withHyphen)
      if (result) return result
    }

    // Option 1 fallback: try slash even if intermediate doesn't exist yet
    if (index < parts.length - 1 && !existsSync(withSlash)) {
      const result = solve(index + 1, withSlash)
      if (result) return result
    }

    return null
  }

  return solve(0, '')
}

/**
 * Discover project directories from `~/.claude/projects/`.
 * Each subdirectory name is an encoded path. Decode and filter to real directories.
 */
function discoverProjectDirs(): string[] {
  const projectsDir = join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsDir)) return []

  try {
    const entries = readdirSync(projectsDir, { withFileTypes: true })
    const dirs: string[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // Filter out worktree entries
      if (entry.name.includes('-worktrees-')) continue

      const decoded = decodeClaudePath(entry.name)
      if (decoded && existsSync(decoded)) {
        dirs.push(decoded)
      }
    }

    return dirs.sort()
  } catch {
    return []
  }
}

// --------------------------------------------------------------------------
// Session registry
// --------------------------------------------------------------------------

const sessions = new Map<string, Session>()
const clients = new Set<WebSocket>()

function createSession(options: SessionOptions): Session {
  const session = new Session({ ...options, cwd: options.cwd ?? cwd })

  session.on('hub_message', (msg: HubMessage) => {
    broadcast(msg)
    // Save manifest when we learn the claude session ID
    if (msg.type === 'session_init') {
      saveManifest()
    }
  })

  session.on('exit', () => {
    saveManifest()
  })

  sessions.set(session.id, session)
  return session
}

function broadcast(msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

/** Broadcast to all clients except the sender (sender already has local state) */
function broadcastExcept(sender: WebSocket, msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

function sendTo(ws: WebSocket, msg: HubMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// --------------------------------------------------------------------------
// HTTP server + WebSocket
// --------------------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  // CORS headers for all requests
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

  if (path === '/health') {
    const sessionList = Array.from(sessions.values()).map((s) => s.getInfo())
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      version: '0.1.0',
      sessions: sessionList,
      cwd,
    }))
    return
  }

  // ------ Bookmark REST API ------

  if (path === '/bookmarks' && req.method === 'GET') {
    try {
      const bookmarks = await bookmarkStore.list()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bookmarks))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  if (path === '/bookmarks/tags' && req.method === 'GET') {
    try {
      const tree = await bookmarkStore.getTagTree()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(tree))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  const bookmarkMatch = path.match(/^\/bookmarks\/(.+\.md)$/)
  if (bookmarkMatch) {
    const filename = decodeURIComponent(bookmarkMatch[1]!)

    if (req.method === 'GET') {
      try {
        const bm = await bookmarkStore.get(filename)
        if (!bm) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(bm))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
      return
    }

    if (req.method === 'PUT') {
      try {
        const body = await readBody(req)
        const updates = JSON.parse(body)
        const updated = await bookmarkStore.update(filename, updates)
        if (!updated) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(updated))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
      return
    }

    if (req.method === 'DELETE') {
      try {
        const deleted = await bookmarkStore.delete(filename)
        if (!deleted) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
      return
    }
  }

  if (path === '/bookmarks/reload' && req.method === 'POST') {
    try {
      await bookmarkStore.reload()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, count: bookmarkStore.size }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // -----------------------------------------------------------------------
  // Notes API — file browser/editor for Obsidian vault (hub fallback)
  // -----------------------------------------------------------------------

  if (path === '/notes' && req.method === 'GET') {
    try {
      const files = await noteStore.list()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(files))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  if (path.startsWith('/notes/file/') && req.method === 'GET') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
    try {
      const content = await noteStore.read(filePath)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content }))
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  if (path.startsWith('/notes/file/') && req.method === 'PUT') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
    try {
      const body = await readBody(req)
      const { content } = JSON.parse(body)
      await noteStore.write(filePath, content)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  if (path.startsWith('/notes/file/') && req.method === 'DELETE') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
    try {
      await noteStore.delete(filePath)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  if (path.startsWith('/notes/mkdir/') && req.method === 'POST') {
    const dirPath = decodeURIComponent(path.slice('/notes/mkdir/'.length))
    try {
      await noteStore.createDir(dirPath)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  if (path === '/notes/rename' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const { from, to } = JSON.parse(body)
      await noteStore.rename(from, to)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  clients.add(ws)
  log(`Client connected from ${req.socket.remoteAddress} (${clients.size} total)`)

  // Send project directories on connect
  const dirs = discoverProjectDirs()
  sendTo(ws, { type: 'project_dirs', dirs })

  // Send current session list
  const active = Array.from(sessions.values()).map((s) => s.getInfo())
  sendTo(ws, { type: 'sessions_list', sessions: active })

  // Replay coalesced message logs for all active sessions
  for (const session of sessions.values()) {
    if (session.messageLog.length > 0) {
      for (const msg of session.messageLog) {
        sendTo(ws, msg)
      }
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
    handleClientMessage(ws, msg)
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
// Client message handler
// --------------------------------------------------------------------------

function handleClientMessage(ws: WebSocket, msg: ClientMessage) {
  switch (msg.type) {
    case 'create_session': {
      const session = createSession({
        prompt: msg.prompt,
        images: msg.images,
        cwd: msg.cwd,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt }
      broadcast(createdMsg)
      session.logMessage(createdMsg)
      // Log the initial user prompt so it appears in replay
      const promptMsg = { type: 'user_prompt' as const, sessionId: session.id, content: msg.prompt, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      broadcast(promptMsg)
      session.logMessage(promptMsg)
      log(`Session created: ${session.id} cwd=${session.cwd} (prompt: "${truncate(msg.prompt, 50)}"${msg.images?.length ? ` +${msg.images.length} image(s)` : ''})`)
      break
    }

    case 'send_message': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // Broadcast user prompt to all clients (sender already shows it locally)
      const userMsg = { type: 'user_prompt' as const, sessionId: msg.sessionId, content: msg.content, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      broadcastExcept(ws, userMsg)
      session.logMessage(userMsg)
      session.sendMessage(msg.content, msg.images)
      break
    }

    case 'approve_tool': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        log(`  ERROR: session not found!`)
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // Broadcast approval to all clients so they dismiss the approval UI
      const approvedMsg = { type: 'tool_approved' as const, sessionId: msg.sessionId, requestId: msg.requestId, toolName: '' }
      broadcast(approvedMsg)
      session.logMessage(approvedMsg)
      session.approveTool(msg.requestId, msg.modifiedInput)
      break
    }

    case 'deny_tool': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      const deniedMsg = { type: 'tool_denied' as const, sessionId: msg.sessionId, requestId: msg.requestId, toolName: '', reason: msg.reason }
      broadcast(deniedMsg)
      session.logMessage(deniedMsg)
      session.denyTool(msg.requestId, msg.reason)
      break
    }

    case 'interrupt': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.interrupt()
      break
    }

    case 'kill_session': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.kill()
      log(`Session killed: ${session.id}`)
      break
    }

    case 'list_sessions': {
      const active = Array.from(sessions.values()).map((s) => s.getInfo())
      sendTo(ws, { type: 'sessions_list', sessions: active })
      break
    }

    case 'resume_session': {
      const session = createSession({
        prompt: msg.prompt,
        cwd: msg.cwd,
        resume: msg.sessionId,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt }
      broadcast(createdMsg)
      session.logMessage(createdMsg)
      log(`Session resumed: ${session.id} cwd=${session.cwd} (claude session: ${msg.sessionId})`)

      // Load and send history from JSONL to all clients
      if (msg.cwd) {
        const history = loadSessionHistory(msg.sessionId, msg.cwd)
        if (history.length > 0) {
          const historyMsg = { type: 'session_history' as const, sessionId: session.id, messages: history }
          broadcast(historyMsg)
          log(`  Loaded ${history.length} history messages`)
        }
      }
      break
    }

    case 'list_past_sessions': {
      listPastSessions(msg.cwd).then((pastSessions) => {
        sendTo(ws, { type: 'past_sessions', sessions: pastSessions })
      }).catch((err) => {
        log(`Failed to list past sessions: ${(err as Error).message}`)
        sendTo(ws, { type: 'past_sessions', sessions: [] })
      })
      break
    }

    case 'get_session_history': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      if (session.claudeSessionId) {
        const history = loadSessionHistory(session.claudeSessionId, session.cwd)
        if (history.length > 0) {
          sendTo(ws, { type: 'session_history', sessionId: session.id, messages: history })
        }
      }
      break
    }

    default:
      sendTo(ws, { type: 'hub_error', message: `Unknown message type: ${(msg as { type: string }).type}` })
  }
}

// --------------------------------------------------------------------------
// Start
// --------------------------------------------------------------------------

httpServer.listen(port, host, () => {
  log(`Console Agent Hub running on http://${host}:${port}`)
  log(`Working directory: ${cwd}`)
  log(`WebSocket: ws://${host}:${port}`)
  log(`Health check: http://${host}:${port}/health`)

  // Restore sessions from manifest (saved before last shutdown)
  const manifest = loadAndClearManifest()
  if (manifest.length > 0) {
    log(`Restoring ${manifest.length} session(s) from manifest...`)
    for (const entry of manifest) {
      try {
        const session = createSession({
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
  saveManifest()
  for (const session of sessions.values()) {
    session.kill()
  }
  httpServer.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  saveManifest()
  for (const session of sessions.values()) {
    session.kill()
  }
  httpServer.close()
  process.exit(0)
})

// --------------------------------------------------------------------------
// Past session discovery (reads Claude's own JSONL session files)
// --------------------------------------------------------------------------

/**
 * List past Claude sessions for a given working directory.
 * Reads JSONL files from `~/.claude/projects/<encoded-path>/`.
 */
async function listPastSessions(cwdPath: string): Promise<PastSession[]> {
  const encoded = cwdToProjectDir(cwdPath)
  const projectDir = join(homedir(), '.claude', 'projects', encoded)

  if (!existsSync(projectDir)) return []

  const entries = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'))
  const sessions: PastSession[] = []

  for (const file of entries) {
    const sessionId = basename(file, '.jsonl')
    const filePath = join(projectDir, file)

    try {
      const stat = statSync(filePath)
      const prompt = await extractFirstPrompt(filePath)
      if (prompt) {
        sessions.push({
          sessionId,
          prompt,
          date: stat.mtimeMs,
        })
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by date descending, limit to 20
  sessions.sort((a, b) => b.date - a.date)
  return sessions.slice(0, 20)
}

/**
 * Extract the first user prompt from a Claude JSONL session file.
 * Reads line-by-line and returns the first user message text that doesn't start with `<`.
 */
function extractFirstPrompt(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })

    let found = false

    rl.on('line', (line) => {
      if (found) return
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && obj.message?.role === 'user') {
          const content = obj.message.content
          let text: string | undefined
          if (typeof content === 'string') {
            text = content
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: { type: string }) => b.type === 'text')
            text = textBlock?.text
          }
          if (text && !text.startsWith('<')) {
            found = true
            rl.close()
            resolve(text.slice(0, 200))
          }
        }
      } catch {
        // Skip non-JSON lines
      }
    })

    rl.on('close', () => {
      if (!found) resolve(null)
    })

    rl.on('error', () => {
      if (!found) resolve(null)
    })
  })
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

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
