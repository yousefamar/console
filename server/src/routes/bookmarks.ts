import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BookmarkStore } from '../bookmarks.js'

export function handleBookmarkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  bookmarkStore: BookmarkStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path === '/bookmarks' && req.method === 'GET') {
    bookmarkStore.list().then((bookmarks) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bookmarks))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path === '/bookmarks/tags' && req.method === 'GET') {
    bookmarkStore.getTagTree().then((tree) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(tree))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  const bookmarkMatch = path.match(/^\/bookmarks\/(.+\.md)$/)
  if (bookmarkMatch) {
    const filename = decodeURIComponent(bookmarkMatch[1]!)

    if (req.method === 'GET') {
      bookmarkStore.get(filename).then((bm) => {
        if (!bm) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(bm))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }

    if (req.method === 'PUT') {
      readBody(req).then(async (body) => {
        const updates = JSON.parse(body)
        const updated = await bookmarkStore.update(filename, updates)
        if (!updated) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(updated))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }

    if (req.method === 'DELETE') {
      bookmarkStore.delete(filename).then((deleted) => {
        if (!deleted) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }
  }

  if (path === '/bookmarks/reload' && req.method === 'POST') {
    bookmarkStore.reload().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, count: bookmarkStore.size }))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  return false
}
