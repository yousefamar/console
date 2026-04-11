// Debug routes — HTTP endpoints for Claude Code + WS message handler for browser debug agents

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocket } from 'ws'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { DebugClientMessage } from '../debug-protocol.js'
import type { DebugLog } from '../debug-log.js'

// Pending RPC requests (eval, state, screenshot)
const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}>()

const SCREENSHOT_DIR = join(homedir(), '.config', 'console', 'screenshots')

function sendToFirstClient(clients: Set<WebSocket>, msg: Record<string, unknown>): boolean {
  for (const ws of clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(msg))
      return true
    }
  }
  return false
}

function broadcastDebug(clients: Set<WebSocket>, msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

function rpcRequest(clients: Set<WebSocket>, msg: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = msg.id as string
    if (!sendToFirstClient(clients, msg)) {
      reject(new Error('No debug client connected'))
      return
    }
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error('Debug RPC timeout'))
    }, timeoutMs)
    pendingRequests.set(id, { resolve, timer })
  })
}

// Handle debug messages from browser WS clients
export function handleDebugClientMessage(
  msg: DebugClientMessage,
  debugLog: DebugLog,
): void {
  switch (msg.type) {
    case 'debug_events':
      debugLog.appendBatch(msg.events)
      break

    case 'debug_eval_result': {
      const pending = pendingRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingRequests.delete(msg.id)
        pending.resolve({ result: msg.result, error: msg.error })
      }
      break
    }

    case 'debug_state': {
      const pending = pendingRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingRequests.delete(msg.id)
        pending.resolve(msg.stores)
      }
      break
    }

    case 'debug_screenshot': {
      const pending = pendingRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.resolve({ error: msg.error })
        } else {
          // Save base64 PNG to file
          try {
            mkdirSync(SCREENSHOT_DIR, { recursive: true })
            const filename = `debug-${Date.now()}.png`
            const filePath = join(SCREENSHOT_DIR, filename)
            const base64 = msg.dataUrl.replace(/^data:image\/png;base64,/, '')
            writeFileSync(filePath, Buffer.from(base64, 'base64'))
            pending.resolve({ path: filePath })
          } catch (err) {
            pending.resolve({ error: (err as Error).message })
          }
        }
      }
      break
    }
  }
}

// HTTP routes for Claude Code
export function handleDebugRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  debugClients: Set<WebSocket>,
  debugLog: DebugLog,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  // GET /debug/log — last N events
  if (path === '/debug/log' && req.method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '100')
    const lines = debugLog.readTail(n)
    const events = lines.map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    json(events)
    return true
  }

  // POST /debug/eval — execute JS in browser
  if (path === '/debug/eval' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      try {
        const { code } = JSON.parse(body) as { code: string }
        const id = randomUUID()
        const result = await rpcRequest(debugClients, { type: 'debug_eval', id, code })
        json(result)
      } catch (err) {
        json({ error: (err as Error).message }, 500)
      }
    }).catch((err) => {
      json({ error: (err as Error).message }, 500)
    })
    return true
  }

  // GET /debug/state — get Zustand store state
  if (path === '/debug/state' && req.method === 'GET') {
    const stores = url.searchParams.get('stores')?.split(',')
    const id = randomUUID()
    rpcRequest(debugClients, { type: 'debug_get_state', id, stores })
      .then((result) => json(result))
      .catch((err) => json({ error: (err as Error).message }, 500))
    return true
  }

  // POST /debug/screenshot — capture page screenshot
  if (path === '/debug/screenshot' && req.method === 'POST') {
    const id = randomUUID()
    rpcRequest(debugClients, { type: 'debug_screenshot', id }, 30000)
      .then((result) => json(result))
      .catch((err) => json({ error: (err as Error).message }, 500))
    return true
  }

  // POST /debug/toggle — enable/disable debug streaming
  if (path === '/debug/toggle' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { enabled } = JSON.parse(body) as { enabled: boolean }
      broadcastDebug(debugClients, { type: 'debug_toggle', enabled })
      json({ ok: true, enabled })
    }).catch((err) => {
      json({ error: (err as Error).message }, 400)
    })
    return true
  }

  // GET /debug/status — connection info
  if (path === '/debug/status' && req.method === 'GET') {
    json({
      clients: debugClients.size,
      logLines: debugLog.getLineCount(),
      pendingRequests: pendingRequests.size,
    })
    return true
  }

  return false
}
