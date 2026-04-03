import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FeedStore } from '../feeds.js'

export function handleFeedRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  feedStore: FeedStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path === '/feeds' && req.method === 'GET') {
    try {
      const feeds = feedStore.list()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(feeds))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return true
  }

  if (path === '/feeds' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { xmlUrl, title, folder, fullText } = JSON.parse(body)
      const feed = await feedStore.add(xmlUrl, title, folder, fullText)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(feed))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path === '/feeds/import-opml' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { opmlXml } = JSON.parse(body)
      const added = feedStore.importOpml(opmlXml)
      const all = feedStore.list()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ added: added.length, total: all.length, feeds: all }))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path === '/feeds/export-opml' && req.method === 'GET') {
    try {
      const opml = feedStore.exportOpml()
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(opml)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return true
  }

  if (path === '/feeds/read' && req.method === 'GET') {
    try {
      const read = feedStore.getRead()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(read))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return true
  }

  if (path === '/feeds/read' && req.method === 'PUT') {
    readBody(req).then((body) => {
      const { add, remove } = JSON.parse(body)
      const read = feedStore.syncRead(add, remove)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(read))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path.startsWith('/feeds/items') && req.method === 'GET') {
    const since = url.searchParams.get('since') || undefined
    feedStore.fetchAllSince(since).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  const feedMatch = path.match(/^\/feeds\/([a-f0-9]+)$/)
  if (feedMatch) {
    const feedId = feedMatch[1]!

    if (req.method === 'GET') {
      feedStore.fetchFeed(feedId).then((items) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(items))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }

    if (req.method === 'DELETE') {
      const deleted = feedStore.delete(feedId)
      if (!deleted) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
        return true
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return true
    }

    if (req.method === 'PUT') {
      readBody(req).then((body) => {
        const updates = JSON.parse(body)
        const updated = feedStore.update(feedId, updates)
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
  }

  const feedItemsMatch = path.match(/^\/feeds\/([a-f0-9]+)\/items$/)
  if (feedItemsMatch && req.method === 'GET') {
    feedStore.fetchFeed(feedItemsMatch[1]!).then((items) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(items))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  return false
}
