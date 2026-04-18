import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrefsStore } from '../prefs-store.js'

// /config — user preferences sync channel.
//   GET  /config          → full prefs JSON
//   PUT  /config          → shallow-merge body into stored prefs, returns merged state
//
// Intentionally simple: no per-key routes, no ETag/concurrency control.
// Writes are rare (toggling a flag, checking a calendar) and last-writer-wins
// is fine for this scale — the alternative is more plumbing than it's worth.
export function handleConfigRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  prefsStore: PrefsStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path !== '/config') return false

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(prefsStore.getAll()))
    return true
  }

  if (req.method === 'PUT') {
    readBody(req).then((body) => {
      try {
        const patch = body ? JSON.parse(body) : {}
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Body must be a JSON object' }))
          return
        }
        const merged = prefsStore.merge(patch as Record<string, never>)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(merged))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  return false
}
