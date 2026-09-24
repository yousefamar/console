// `con whatsapp edit` (^dry-moth): AL opened a message to Nic with "Al here"
// (his name is AL) and only delete existed. POST /whatsapp/edit replaces the
// text of a message we sent, resolving `last` from wa-history, and amends the
// history line so the envelope shows what the recipient now sees.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

const { editText, sendText } = vi.hoisted(() => ({
  editText: vi.fn(async (to: string, _id: string, _text: string) => ({ id: 'EDIT-PROTO-ID', jid: to.includes('@') ? to : `${to}@s.whatsapp.net` })),
  sendText: vi.fn(async (to: string, _text: string) => ({ id: 'SENT-1', jid: to.includes('@') ? to : `${to}@s.whatsapp.net` })),
}))

vi.mock('../al/whatsapp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../al/whatsapp.js')>()
  return { ...real, editText, sendText, findBlockedTerm: (text: string) => (/acacia house/i.test(text) ? 'acacia house' : null) }
})

import { handleAlRoutes } from '../routes/al.js'
import { record, recentThread, lastOutbound, findOutbound, amend, resetHistoryCache } from '../al/wa-history.js'

const NIC = '447700900123@s.whatsapp.net'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-edit-test-'))
  process.env.CONSOLE_WA_HISTORY_FILE = join(dir, 'wa-history.json')
  resetHistoryCache()
  editText.mockClear()
  sendText.mockClear()
})
afterEach(() => {
  delete process.env.CONSOLE_WA_HISTORY_FILE
  resetHistoryCache()
  rmSync(dir, { recursive: true, force: true })
})

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST', url: path, headers }) as unknown as IncomingMessage
  let status = 0
  let out = ''
  const done = new Promise<void>((resolve) => {
    const res = {
      writeHead(code: number) { status = code; return res },
      end(chunk?: string) { out = chunk ?? ''; resolve() },
      write(chunk: string) { out += chunk },
      get writableEnded() { return false },
      get headersSent() { return status !== 0 },
      flushHeaders() {},
    } as unknown as ServerResponse
    const handled = handleAlRoutes(req, res, path, async (r) => { let s = ''; for await (const c of r) s += c; return s })
    if (!handled) resolve()
  })
  await done
  return { status, body: out ? JSON.parse(out) : null }
}

describe('wa-history: lastOutbound / findOutbound / amend', () => {
  it('finds the newest outbound with an id, ignoring inbound and id-less lines', () => {
    record({ ts: 1, dir: 'out', jid: NIC, user: 'nic', text: 'first', via: 'al', id: 'A' })
    record({ ts: 2, dir: 'in', jid: NIC, user: 'nic', text: 'reply', id: 'IN' })
    record({ ts: 3, dir: 'out', jid: NIC, user: 'nic', text: 'no id recorded', via: 'al' })
    expect(lastOutbound('447700900123')?.id).toBe('A')
    expect(findOutbound(NIC, 'A')?.text).toBe('first')
    expect(findOutbound(NIC, 'IN')).toBeNull()
    expect(lastOutbound('447700999999')).toBeNull()
  })

  it('amend rewrites the recorded text in place and persists it', () => {
    record({ ts: 1, dir: 'out', jid: NIC, user: 'nic', text: 'Al here', via: 'al', id: 'A' })
    expect(amend(NIC, 'A', 'AL here')).toBe(true)
    expect(amend(NIC, 'nope', 'x')).toBe(false)
    resetHistoryCache()
    expect(recentThread([NIC]).map((e) => e.text)).toEqual(['AL here'])
  })
})

describe('POST /whatsapp/edit', () => {
  it('send returns the id and the edit deadline', async () => {
    const r = await post('/whatsapp/send', { to: NIC, text: 'Al here, quick one.' })
    expect(r.status).toBe(200)
    expect(r.body.id).toBe('SENT-1')
    expect(new Date(r.body.editableUntil).getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000)
    expect(lastOutbound(NIC)?.id).toBe('SENT-1')
  })

  it("'last' resolves to the newest message sent to that thread and amends history", async () => {
    await post('/whatsapp/send', { to: NIC, text: 'Al here, quick one.' })
    const r = await post('/whatsapp/edit', { to: NIC, messageId: 'last', text: 'AL here, quick one.' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, id: 'SENT-1', jid: NIC, previousText: 'Al here, quick one.' })
    expect(r.body.warning).toBeUndefined()
    expect(editText).toHaveBeenCalledWith(NIC, 'SENT-1', 'AL here, quick one.')
    expect(recentThread([NIC]).map((e) => e.text)).toEqual(['AL here, quick one.'])
  })

  it('an explicit id is sent as-is even when history never recorded it', async () => {
    const r = await post('/whatsapp/edit', { to: '447700900123', messageId: '3EB0FEED', text: 'fixed' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, id: '3EB0FEED', jid: NIC })
    expect(r.body.previousText).toBeUndefined()
    expect(editText).toHaveBeenCalledWith('447700900123', '3EB0FEED', 'fixed')
  })

  it("'last' with nothing recorded is a 404, not a blind send", async () => {
    const r = await post('/whatsapp/edit', { to: NIC, messageId: 'last', text: 'x' })
    expect(r.status).toBe(404)
    expect(editText).not.toHaveBeenCalled()
  })

  it('warns when the original is older than the 15-min window', async () => {
    record({ ts: Date.now() - 23 * 60 * 1000, dir: 'out', jid: NIC, user: 'nic', text: 'old', via: 'al', id: 'OLD' })
    const r = await post('/whatsapp/edit', { to: NIC, messageId: 'OLD', text: 'newer' })
    expect(r.status).toBe(200)
    expect(r.body.warning).toMatch(/23 min ago/)
    expect(editText).toHaveBeenCalledTimes(1)
  })

  it('runs the address censor on the replacement text', async () => {
    record({ ts: Date.now(), dir: 'out', jid: NIC, user: 'nic', text: 'hi', via: 'al', id: 'A' })
    const r = await post('/whatsapp/edit', { to: NIC, messageId: 'last', text: 'come to Acacia House' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/blocked/)
    expect(editText).not.toHaveBeenCalled()
    expect(recentThread([NIC]).map((e) => e.text)).toEqual(['hi'])
  })

  it('rejects a missing text / to', async () => {
    expect((await post('/whatsapp/edit', { to: NIC, messageId: 'last' })).status).toBe(400)
    expect((await post('/whatsapp/edit', { messageId: 'last', text: 'x' })).status).toBe(400)
  })

  it('maps a disconnected socket to 503 and leaves history untouched', async () => {
    record({ ts: Date.now(), dir: 'out', jid: NIC, user: 'nic', text: 'hi', via: 'al', id: 'A' })
    editText.mockRejectedValueOnce(new Error('WhatsApp not connected'))
    const r = await post('/whatsapp/edit', { to: NIC, messageId: 'last', text: 'hello' })
    expect(r.status).toBe(503)
    expect(recentThread([NIC]).map((e) => e.text)).toEqual(['hi'])
  })
})
