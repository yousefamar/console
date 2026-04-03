import type { IncomingMessage, ServerResponse } from 'node:http'
import type { NoteStore } from '../notes.js'

export function handleNoteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  noteStore: NoteStore,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (path === '/notes' && req.method === 'GET') {
    noteStore.list().then((files) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(files))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
    return true
  }

  if (path.startsWith('/notes/file/') && req.method === 'GET') {
    const filePath = decodeURIComponent(path.slice('/notes/file/'.length))
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
    readBody(req).then(async (body) => {
      const { content } = JSON.parse(body)
      await noteStore.write(filePath, content)
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
