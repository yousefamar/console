// Eventbrite organiser-follow routes.
//
//   GET    /eventbrite/status                 configured? + organisers + cache count (token never returned)
//   GET    /eventbrite/events[?force=1]       live events across followed organisers
//   POST   /eventbrite/organizers  {ref}      follow by organiser id / organiser URL / event URL
//   DELETE /eventbrite/organizers/:id         unfollow
//   POST   /eventbrite/token       {token}    set/rotate the personal OAuth token
//
// Calendar-only source; the client adapts + registers the overlay.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventbriteStore } from '../eventbrite.js'

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function handleEventbriteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  store: EventbriteStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/eventbrite')) return false
  const clean = path.split('?')[0]!

  if (clean === '/eventbrite/status' && req.method === 'GET') {
    json(res, store.getStatus())
    return true
  }

  if (clean === '/eventbrite/events' && req.method === 'GET') {
    const force = /[?&]force=1\b/.test(path)
    store.getEvents(force)
      .then((events) => json(res, { events, fetchedAt: store.getStatus().fetchedAt }))
      .catch((err) => json(res, { error: (err as Error).message }, 502))
    return true
  }

  if (clean === '/eventbrite/organizers' && req.method === 'POST') {
    readBody(req).then(async (raw) => {
      const body = JSON.parse(raw || '{}') as { ref?: string }
      if (!body.ref) return json(res, { error: 'ref required (organiser id, organiser URL, or event URL)' }, 400)
      const org = await store.addOrganizer(body.ref)
      json(res, { organizer: org, organizers: store.organizers() })
    }).catch((err) => json(res, { error: (err as Error).message }, 400))
    return true
  }

  const del = clean.match(/^\/eventbrite\/organizers\/(\d+)$/)
  if (del && req.method === 'DELETE') {
    json(res, { removed: store.removeOrganizer(del[1]!), organizers: store.organizers() })
    return true
  }

  if (clean === '/eventbrite/token' && req.method === 'POST') {
    readBody(req).then((raw) => {
      const body = JSON.parse(raw || '{}') as { token?: string }
      if (!body.token?.trim()) return json(res, { error: 'token required' }, 400)
      store.setToken(body.token)
      json(res, { configured: true })
    }).catch((err) => json(res, { error: (err as Error).message }, 400))
    return true
  }

  return false
}
