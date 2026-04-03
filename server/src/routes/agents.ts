// Agent session management — WebSocket message handler

import { WebSocket } from 'ws'
import { Session, type SessionOptions } from '../session.js'
import type { ClientMessage, HubMessage } from '../protocol.js'
import { loadSessionHistory, listPastSessions } from '../history.js'
import { saveManifest } from '../manifest.js'

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
    if (msg.type === 'session_init') {
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

    default:
      sendTo(ws, { type: 'hub_error', message: `Unknown message type: ${(msg as { type: string }).type}` })
  }
}
