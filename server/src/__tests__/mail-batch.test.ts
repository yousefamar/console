import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleMailRoutes, mapConcurrent } from '../routes/mail.js'
import { DedupStore } from '../dedup-store.js'

// Minimal req/res fakes for the route handler.
function fakeReq(method: string, body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter
  ;(req as any).method = method
  ;(req as any).headers = {}
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  return req
}

function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: any }> } {
  let resolve: (v: { status: number; body: any }) => void
  const done = new Promise<{ status: number; body: any }>((r) => { resolve = r })
  let status = 200
  const res = {
    writeHead: (s: number) => { status = s },
    end: (data?: string) => resolve({ status, body: data ? JSON.parse(data) : null }),
  } as unknown as ServerResponse
  return { res, done }
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
  })

describe('mapConcurrent', () => {
  it('respects the concurrency cap and preserves order', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    const results = await mapConcurrent(items, 6, async (i) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return i * 2
    })
    expect(maxInFlight).toBeLessThanOrEqual(6)
    expect(results).toEqual(items.map((i) => i * 2))
  })
})

describe('GET /mail/threads?full=1', () => {
  let dir: string
  let gmail: any

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mailbatch-'))
    gmail = {
      listThreads: vi.fn(async () => ({
        threads: [{ id: 't1' }, { id: 't2' }, { id: 't3' }],
        nextPageToken: 'page2',
      })),
      getThread: vi.fn(async (id: string) => ({ id, messages: [{ id: `${id}-m1` }] })),
      getProfile: vi.fn(async () => ({ historyId: '999' })),
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns full threads + historyId in one response', async () => {
    const { res, done } = fakeRes()
    const url = new URL('http://x/mail/threads?full=1&limit=50')
    handleMailRoutes(fakeReq('GET'), res, '/mail/threads', url, gmail, readBody)
    const { status, body } = await done
    expect(status).toBe(200)
    expect(body.threads).toHaveLength(3)
    expect(body.threads[0].messages).toBeDefined()
    expect(body.historyId).toBe('999')
    expect(body.nextPageToken).toBe('page2')
    // Full list defaults q to in:inbox
    expect(gmail.listThreads.mock.calls[0][0].q).toBe('in:inbox')
  })

  it('a failed individual thread fetch is dropped, not fatal', async () => {
    gmail.getThread = vi.fn(async (id: string) => {
      if (id === 't2') throw new Error('410 gone')
      return { id, messages: [] }
    })
    const { res, done } = fakeRes()
    handleMailRoutes(fakeReq('GET'), res, '/mail/threads', new URL('http://x/mail/threads?full=1'), gmail, readBody)
    const { body } = await done
    expect(body.threads.map((t: any) => t.id)).toEqual(['t1', 't3'])
  })

  it('plain (non-full) form is unchanged', async () => {
    const { res, done } = fakeRes()
    handleMailRoutes(fakeReq('GET'), res, '/mail/threads', new URL('http://x/mail/threads?maxResults=10'), gmail, readBody)
    const { body } = await done
    expect(body.threads).toEqual([{ id: 't1' }, { id: 't2' }, { id: 't3' }])
    expect(gmail.getThread).not.toHaveBeenCalled()
  })
})

describe('POST /mail/threads/batch', () => {
  it('hydrates the requested ids', async () => {
    const gmail: any = {
      getThread: vi.fn(async (id: string) => ({ id })),
    }
    const { res, done } = fakeRes()
    handleMailRoutes(
      fakeReq('POST', JSON.stringify({ ids: ['a', 'b'] })),
      res, '/mail/threads/batch', new URL('http://x/mail/threads/batch'), gmail, readBody,
    )
    const { body } = await done
    expect(body.threads.map((t: any) => t.id)).toEqual(['a', 'b'])
  })
})

describe('mail send clientToken dedup', () => {
  let dir: string
  let dedup: DedupStore
  let gmail: any

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'maildedup-'))
    dedup = new DedupStore(join(dir, 'dedup.json'))
    gmail = {
      sendEmail: vi.fn(async () => ({ id: 'msg-1', threadId: 'thr-1' })),
    }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function send(token?: string) {
    const { res, done } = fakeRes()
    const body = JSON.stringify({ to: 'a@b.c', subject: 'hi', body: 'text', clientToken: token })
    handleMailRoutes(fakeReq('POST', body), res, '/mail/send', new URL('http://x/mail/send'), gmail, readBody, dedup)
    return done
  }

  it('same token twice → one send, same result', async () => {
    const first = await send('tok-1')
    const second = await send('tok-1')
    expect(gmail.sendEmail).toHaveBeenCalledTimes(1)
    expect(second.body).toEqual(first.body)
  })

  it('replay survives a store reload (persisted)', async () => {
    await send('tok-2')
    const reloaded = new DedupStore(join(dir, 'dedup.json'))
    expect(reloaded.get('tok-2')).toEqual({ id: 'msg-1', threadId: 'thr-1' })
  })

  it('no token → every call sends', async () => {
    await send(undefined)
    await send(undefined)
    expect(gmail.sendEmail).toHaveBeenCalledTimes(2)
  })

  it('a failed send is not recorded — retry executes', async () => {
    gmail.sendEmail.mockRejectedValueOnce(new Error('503'))
    const first = await send('tok-3')
    expect(first.status).toBe(500)
    const second = await send('tok-3')
    expect(second.status).toBe(200)
    expect(gmail.sendEmail).toHaveBeenCalledTimes(2)
  })
})

describe('DedupStore pruning', () => {
  it('drops entries past maxAge on load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dedupprune-'))
    try {
      const path = join(dir, 'd.json')
      const store = new DedupStore(path, 1000)
      store.record('old', { v: 1 })
      // Simulate age by rewriting the file with an old ts.
      const fs = require('node:fs')
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
      data.old.ts = Date.now() - 10_000
      fs.writeFileSync(path, JSON.stringify(data))
      const reloaded = new DedupStore(path, 1000)
      expect(reloaded.get('old')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
