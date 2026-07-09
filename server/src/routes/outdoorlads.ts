// OutdoorLads events routes — hub-side over the public RSS feed.
//
//   GET  /outdoorlads/events[?force=1]   parsed upcoming events + fetchedAt
//   GET  /outdoorlads/status             cache count + last fetch + feed URL
//
// Calendar-only source (no coords). The client filters (e.g. camping) and feeds
// the Calendar tab's read-only overlay. Fetch is TTL-cached; never background-polled.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OutdoorLadsStore } from '../outdoorlads.js'

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function handleOutdoorLadsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  store: OutdoorLadsStore,
): boolean {
  if (!path.startsWith('/outdoorlads')) return false

  if (path === '/outdoorlads/status' && req.method === 'GET') {
    json(res, store.getStatus())
    return true
  }

  if (path.startsWith('/outdoorlads/events') && req.method === 'GET') {
    const force = /[?&]force=1\b/.test(path)
    store
      .getEvents(force)
      .then((events) => json(res, { events, fetchedAt: store.getStatus().fetchedAt }))
      .catch((err) => json(res, { error: (err as Error).message }, 502))
    return true
  }

  return false
}
