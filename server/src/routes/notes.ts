import type { IncomingMessage, ServerResponse } from 'node:http'
import { NoteStore, NoteConflictError, contentTypeFor } from '../notes.js'

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function wantsBinary(req: IncomingMessage): boolean {
  return (req.url ?? '').includes('binary=1')
}

export function handleNoteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  noteStore: NoteStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path === '/notes' && req.method === 'GET') {
    // `?since=<ms>` — changed-files listing + deletion tombstones, the cheap
    // offline-client polling primitive. Plain form stays the full listing.
    const sinceParam = /[?&]since=(\d+)/.exec(req.url ?? '')?.[1]
    if (sinceParam) {
      noteStore.listSince(Number(sinceParam)).then((delta) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(delta))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }
    noteStore.list().then((files) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(files))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path === '/notes/vault-path' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ path: noteStore.vaultPath }))
    return true
  }

  if (path.startsWith('/notes/file/') && req.method === 'GET') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
    if (wantsBinary(req)) {
      noteStore.readBinary(filePath).then((buf) => {
        res.writeHead(200, { 'Content-Type': contentTypeFor(filePath), 'Content-Length': buf.length })
        res.end(buf)
      }).catch((err) => {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }
    noteStore.read(filePath).then((content) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content }))
    }).catch((err) => {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path.startsWith('/notes/file/') && req.method === 'PUT') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
    if (wantsBinary(req)) {
      readRawBody(req).then(async (buf) => {
        await noteStore.writeBinary(filePath, buf)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      })
      return true
    }
    readBody(req).then(async (body) => {
      const { content, baseMtime } = JSON.parse(body) as { content: string; baseMtime?: number }
      // Conditional write: stale baseMtime → 409 with the server copy so the
      // client can merge instead of clobbering (offline-edit safety). No
      // baseMtime → legacy last-writer-wins (SPA/CLI unchanged).
      const { mtime } = await noteStore.writeConditional(filePath, content, baseMtime)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, mtime }))
    }).catch((err) => {
      if (err instanceof NoteConflictError) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'conflict', serverMtime: err.serverMtime, serverContent: err.serverContent }))
        return
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  // Sibling assets dir (~/sync/brain/assets — Obsidian attachments + Eleventy
  // passthrough assets live OUTSIDE the vault root). GET serves raw bytes,
  // PUT writes them (used by image paste/camera upload).
  if (path.startsWith('/notes/asset/') && req.method === 'GET') {
    const assetPath = decodeURIComponent(path.slice('/notes/asset/'.length))
    noteStore.readAsset(assetPath).then((buf) => {
      res.writeHead(200, {
        'Content-Type': contentTypeFor(assetPath),
        'Content-Length': buf.length,
        'Cache-Control': 'max-age=3600',
      })
      res.end(buf)
    }).catch((err) => {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path.startsWith('/notes/asset/') && req.method === 'PUT') {
    const assetPath = decodeURIComponent(path.slice('/notes/asset/'.length))
    readRawBody(req).then(async (buf) => {
      await noteStore.writeAsset(assetPath, buf)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path.startsWith('/notes/file/') && req.method === 'DELETE') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
    noteStore.delete(filePath).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path.startsWith('/notes/mkdir/') && req.method === 'POST') {
    const dirPath = decodeURIComponent(path.slice('/notes/mkdir/'.length))
    noteStore.createDir(dirPath).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path === '/notes/rename' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      const { from, to } = JSON.parse(body)
      await noteStore.rename(from, to)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  return false
}
