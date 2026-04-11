// Agent session management — WebSocket message handler

import { WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Session, type SessionOptions } from '../session.js'
import type { ClientMessage, HubMessage } from '../protocol.js'
import { loadSessionHistory, listPastSessions } from '../history.js'
import { saveManifest } from '../manifest.js'

// Session order persistence
const CONFIG_DIR = join(homedir(), '.config', 'console')
const ORDER_FILE = join(CONFIG_DIR, 'agent-session-order.json')

/** Load persisted order (stored as claudeSessionIds for stability across restarts) */
function loadOrderFromDisk(): string[] {
  if (!existsSync(ORDER_FILE)) return []
  try {
    return JSON.parse(readFileSync(ORDER_FILE, 'utf-8')) as string[]
  } catch {
    return []
  }
}

function saveOrderToDisk(order: string[]) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(ORDER_FILE, JSON.stringify(order))
  } catch { /* best effort */ }
}

/** Load session order and translate claudeSessionIds → hub session IDs */
export function loadSessionOrder(sessions: Map<string, Session>): string[] {
  const claudeOrder = loadOrderFromDisk()
  if (claudeOrder.length === 0) return []
  // Map claudeSessionId → hub session ID
  const claudeToHub = new Map<string, string>()
  for (const s of sessions.values()) {
    if (s.claudeSessionId) claudeToHub.set(s.claudeSessionId, s.id)
  }
  return claudeOrder.map((cid) => claudeToHub.get(cid)).filter(Boolean) as string[]
}

/** Translate hub session IDs → claudeSessionIds and persist */
function saveSessionOrder(hubOrder: string[], sessions: Map<string, Session>) {
  const claudeOrder: string[] = []
  for (const hubId of hubOrder) {
    const session = sessions.get(hubId)
    if (session?.claudeSessionId) claudeOrder.push(session.claudeSessionId)
  }
  saveOrderToDisk(claudeOrder)
}

type LogFn = (msg: string) => void
type TruncateFn = (str: string, max: number) => string

export interface AgentContext {
  sessions: Map<string, Session>
  clients: Set<WebSocket>
  cwd: string
  log: LogFn
  truncate: TruncateFn
}

function broadcast(clients: Set<WebSocket>, msg: HubMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}

function broadcastExcept(clients: Set<WebSocket>, sender: WebSocket, msg: HubMessage) {
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

export function createSession(ctx: AgentContext, options: SessionOptions): Session {
  const session = new Session({ ...options, cwd: options.cwd ?? ctx.cwd })

  session.on('hub_message', (msg: HubMessage) => {
    broadcast(ctx.clients, msg)
    // Save manifest on any session state change (debounced)
    if (msg.type === 'session_init' || msg.type === 'session_ended' || msg.type === 'result') {
      saveManifest(ctx.sessions)
    }
  })

  session.on('exit', () => {
    saveManifest(ctx.sessions)
  })

  ctx.sessions.set(session.id, session)
  return session
}

export function handleClientMessage(ctx: AgentContext, ws: WebSocket, msg: ClientMessage) {
  const { sessions, clients, log, truncate } = ctx

  switch (msg.type) {
    case 'create_session': {
      const session = createSession(ctx, {
        prompt: msg.prompt,
        images: msg.images,
        cwd: msg.cwd,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt }
      broadcast(clients, createdMsg)
      session.logMessage(createdMsg)
      const promptMsg = { type: 'user_prompt' as const, sessionId: session.id, content: msg.prompt, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      broadcast(clients, promptMsg)
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
      const userMsg = { type: 'user_prompt' as const, sessionId: msg.sessionId, content: msg.content, ...(msg.images?.length ? { images: msg.images.map((img) => `data:${img.media_type};base64,${img.data}`) } : {}) }
      broadcastExcept(clients, ws, userMsg)
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
      const approvedMsg = { type: 'tool_approved' as const, sessionId: msg.sessionId, requestId: msg.requestId, toolName: '' }
      broadcast(clients, approvedMsg)
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
      broadcast(clients, deniedMsg)
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
      const session = createSession(ctx, {
        prompt: msg.prompt,
        cwd: msg.cwd,
        resume: msg.sessionId,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: msg.prompt }
      broadcast(clients, createdMsg)
      session.logMessage(createdMsg)
      log(`Session resumed: ${session.id} cwd=${session.cwd} (claude session: ${msg.sessionId})`)

      if (msg.cwd) {
        const history = loadSessionHistory(msg.sessionId, msg.cwd)
        if (history.length > 0) {
          const historyMsg = { type: 'session_history' as const, sessionId: session.id, messages: history }
          broadcast(clients, historyMsg)
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

    case 'rename_session': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      session.name = msg.name
      const renamedMsg = { type: 'session_renamed' as const, sessionId: session.id, name: msg.name }
      broadcast(clients, renamedMsg)
      session.logMessage(renamedMsg)
      saveManifest(sessions)
      log(`Session renamed: ${session.id} → "${msg.name}"`)
      break
    }

    case 'reorder_sessions': {
      saveSessionOrder(msg.order, sessions)
      broadcastExcept(clients, ws, { type: 'session_order', order: msg.order })
      log(`Session order updated (${msg.order.length} entries)`)
      break
    }

    case 'fork_session': {
      const sourceSession = sessions.get(msg.sessionId)
      if (!sourceSession) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      if (!sourceSession.claudeSessionId) {
        sendTo(ws, { type: 'hub_error', message: `Session has no Claude session ID yet` })
        return
      }
      const forkCwd = msg.cwd || sourceSession.cwd
      const forkName = sourceSession.name ? `${sourceSession.name} (fork)` : undefined
      const session = createSession(ctx, {
        prompt: '',
        cwd: forkCwd,
        resume: sourceSession.claudeSessionId,
        fork: true,
        silent: true,
        name: forkName,
      })
      const createdMsg = { type: 'session_created' as const, sessionId: session.id, cwd: session.cwd, prompt: '', name: forkName }
      broadcast(clients, createdMsg)
      session.logMessage(createdMsg)
      // Load history from source session's JSONL for the frontend
      const history = loadSessionHistory(sourceSession.claudeSessionId, forkCwd)
      if (history.length > 0) {
        const historyMsg = { type: 'session_history' as const, sessionId: session.id, messages: history }
        broadcast(clients, historyMsg)
      }
      log(`Session forked: ${session.id} from ${msg.sessionId} (claude: ${sourceSession.claudeSessionId})`)
      break
    }

    case 'generate_title': {
      const session = sessions.get(msg.sessionId)
      if (!session) {
        sendTo(ws, { type: 'hub_error', message: `Session not found: ${msg.sessionId}` })
        return
      }
      // Gather context: always start with the initial prompt, then add recent messages
      const logMessages = session.messageLog
        .filter((m) => m.type === 'user_prompt' || m.type === 'text')
        .slice(0, 6)
        .map((m) => ('content' in m ? (m as { content: string }).content : ''))
        .filter(Boolean)
      // Prepend initial prompt if not already the first log entry
      if (!logMessages[0] || logMessages[0] !== session.initialPrompt) {
        logMessages.unshift(session.initialPrompt)
      }
      const context = logMessages.join('\n---\n').slice(0, 2000)
      const dirName = session.cwd.split('/').pop() || ''
      // Gather existing session names for style reference
      const existingNames = Array.from(sessions.values())
        .filter((s) => s.name && s.id !== session.id)
        .map((s) => s.name!)
        .slice(0, 15)
      const styleHint = existingNames.length > 0
        ? `\n\nExisting session titles for style reference: ${existingNames.join(', ')}`
        : ''
      const prompt = `Generate a short 1-4 word title for this coding session. Reply with ONLY the title, nothing else. No quotes, no punctuation, no explanation.${styleHint}\n\nProject directory: ${dirName}\nUser's initial request: ${session.initialPrompt.slice(0, 500)}\n\nFull session context:\n${context}`
      execFile('claude', ['-p', '--model', 'haiku', prompt], { timeout: 15000 }, (err, stdout) => {
        const title = err ? null : stdout.trim().replace(/^["']|["']$/g, '').slice(0, 40)
        if (title) {
          session.name = title
          const renamedMsg = { type: 'session_renamed' as const, sessionId: session.id, name: title }
          broadcast(clients, renamedMsg)
          session.logMessage(renamedMsg)
          saveManifest(sessions)
          log(`Session title generated: ${session.id} → "${title}"`)
        } else {
          log(`Failed to generate title for ${session.id}: ${err?.message ?? 'empty response'}`)
        }
      })
      break
    }

    default:
      sendTo(ws, { type: 'hub_error', message: `Unknown message type: ${(msg as { type: string }).type}` })
  }
}
