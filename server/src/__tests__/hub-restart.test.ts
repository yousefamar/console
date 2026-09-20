import { describe, it, expect } from 'vitest'
import { createServer, request, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleHubRoutes } from '../routes/hub.js'

// Real in-process http server so the "reply flushed before restart fires"
// ordering is exercised on a socket, not a mock.
async function withServer(run: (base: string, restarts: () => number) => Promise<void>) {
  let restarts = 0
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (handleHubRoutes(req, res, path, { restart: () => { restarts++ }, log: () => {} })) return
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`, () => restarts)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

function call(base: string, method: string, path: string): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('POST /restart', () => {
  it('replies 202 and only then triggers the restart', async () => {
    await withServer(async (base, restarts) => {
      const res = await call(base, 'POST', '/restart')
      expect(res.status).toBe(202)
      expect(JSON.parse(res.body)).toEqual({ restarting: true })
      // The client has the full reply in hand before the restart is scheduled.
      expect(restarts()).toBe(0)
      await new Promise((r) => setTimeout(r, 120))
      expect(restarts()).toBe(1)
    })
  })

  it('rejects non-POST with 405 and never restarts', async () => {
    await withServer(async (base, restarts) => {
      const res = await call(base, 'GET', '/restart')
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('POST')
      await new Promise((r) => setTimeout(r, 120))
      expect(restarts()).toBe(0)
    })
  })

  it('ignores other paths', async () => {
    await withServer(async (base) => {
      const res = await call(base, 'POST', '/restart/now')
      expect(res.status).toBe(404)
    })
  })
})
