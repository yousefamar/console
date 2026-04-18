// HTTP routes for the push notification channel.
//
//   POST /push/send     — emit a notification to every connected push client
//   GET  /push/status   — { clients: number }
//
// The WebSocket half (`/push`) lives in `server/src/index.ts` where the
// WebSocket upgrade handler dispatches by path. Browser clients don't need
// these endpoints — they use the Notification API directly. This is the
// seam the Android foreground service + CLI + webhooks push through.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PushServer, PushMessage } from '../push.js'

export function handlePushRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  pushServer: PushServer,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path === '/push/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ clients: pushServer.clientCount() }))
    return true
  }

  if (path === '/push/send' && req.method === 'POST') {
    readBody(req).then((body) => {
      const parsed = JSON.parse(body) as Partial<PushMessage>
      if (!parsed.title || !parsed.body) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'title and body required' }))
        return
      }
      const msg: PushMessage = {
        type: (parsed.type ?? 'generic'),
        title: parsed.title,
        body: parsed.body,
        pane: parsed.pane,
        id: parsed.id,
        data: parsed.data,
      }
      pushServer.broadcast(msg)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, delivered: pushServer.clientCount() }))
    }).catch((err: Error) => {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    })
    return true
  }

  return false
}
