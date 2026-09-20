import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMailEnv, accountFromEnv, discoverAccounts, type ImapAccount } from '../imap/accounts.js'
import { ImapIdleWatcher, textPart, hasAttachments, toSnippet, type ImapClientLike, type ImapFetched, type ImapBodyNode } from '../imap/watcher.js'
import type { EmitInput } from '../events/types.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'imap-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const AL: ImapAccount = { name: 'al', host: 'imap.example', user: 'al@amar.io', pass: 'pw', port: 993 }

// ---- fake server + client --------------------------------------------------

interface FakeMsg { uid: number; from?: string; subject?: string; text?: string; html?: string; seen?: boolean; attachment?: boolean }

class FakeServer {
  uidValidity = 100n
  messages: FakeMsg[] = []
  idle = true
  connects = 0
  clients: FakeClient[] = []
  get uidNext(): number { return (this.messages.at(-1)?.uid ?? 0) + 1 }
  deliver(msg: FakeMsg): void {
    this.messages.push(msg)
    for (const c of this.clients) if (c.open) c.emit('exists', { path: 'INBOX', count: this.messages.length, prevCount: this.messages.length - 1 })
  }
  dropAll(): void { for (const c of [...this.clients]) c.close() }
}

class FakeClient extends EventEmitter implements ImapClientLike {
  open = false
  closed = false
  capabilities = new Map<string, boolean | number>()
  searches: string[] = []
  constructor(private readonly server: FakeServer, private readonly failConnect = false) {
    super()
    if (server.idle) this.capabilities.set('IDLE', true)
  }
  async connect(): Promise<void> {
    this.server.connects++
    if (this.failConnect) throw new Error('LOGIN failed')
    this.server.clients.push(this)
  }
  async mailboxOpen(): Promise<{ uidValidity: bigint; uidNext: number; exists: number }> {
    this.open = true
    return { uidValidity: this.server.uidValidity, uidNext: this.server.uidNext, exists: this.server.messages.length }
  }
  async search(q: { uid: string }): Promise<number[]> {
    this.searches.push(q.uid)
    const [lo, hi] = q.uid.split(':')
    const from = Number(lo)
    const all = this.server.messages.map((m) => m.uid)
    if (hi === '*') {
      // RFC 3501: `N:*` where N > max UID still matches the highest-UID message
      const max = Math.max(...all, 0)
      const hits = all.filter((u) => u >= from)
      return hits.length ? hits : max ? [max] : []
    }
    return all.filter((u) => u >= from && u <= Number(hi))
  }
  async fetchAll(range: string): Promise<ImapFetched[]> {
    const want = new Set(range.split(',').map(Number))
    return this.server.messages.filter((m) => want.has(m.uid)).map((m) => ({
      uid: m.uid,
      envelope: { subject: m.subject ?? 's', messageId: `<${m.uid}@x>`, from: [{ name: 'Sender', address: m.from ?? 'a@b.c' }], to: [{ address: 'al@amar.io' }], date: new Date(1_700_000_000_000 + m.uid) },
      flags: new Set(m.seen ? ['\\Seen'] : []),
      bodyStructure: m.html && !m.text
        ? { type: 'text/html', parameters: { charset: 'utf-8' } }
        : m.attachment
          ? { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain', parameters: { charset: 'utf-8' } }, { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'x.pdf' } }] }
          : { type: 'text/plain', parameters: { charset: 'utf-8' } },
    }))
  }
  async download(range: string, part?: string): Promise<{ content: Readable }> {
    const m = this.server.messages.find((x) => x.uid === Number(range))!
    const body = part === '1' || part === undefined ? (m.text ?? m.html ?? '') : ''
    return { content: Readable.from([Buffer.from(body)]) }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.open = false
    const i = this.server.clients.indexOf(this)
    if (i >= 0) this.server.clients.splice(i, 1)
    this.emit('close')
  }
}

function makeWatcher(server: FakeServer, cursorFile: string, over: { failFirst?: boolean; accounts?: ImapAccount[] } = {}) {
  const emitted: EmitInput[] = []
  const logs: string[] = []
  let n = 0
  const watcher = new ImapIdleWatcher({
    accounts: over.accounts ?? [AL],
    cursorFile,
    connect: () => new FakeClient(server, over.failFirst ? n++ === 0 : false),
    emit: (input) => { emitted.push(input); return null },
    log: (m) => logs.push(m),
    backoff: { minMs: 5, maxMs: 20 },
  })
  return { watcher, emitted, logs }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const readCursors = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, { uidValidity: string; lastUid: number }>

// ---- accounts ---------------------------------------------------------------

describe('imap accounts', () => {
  it('parses the al-mail.py .env shape: quotes stripped, comments and blanks ignored', () => {
    const kv = parseMailEnv(`MAIL_HOST=blizzard.mxrouting.net\nMAIL_USER=al@amar.io\nMAIL_PASS='p=a$s'\n# c\n\nMAIL_SIGNATURE="A\\nB"\n`)
    expect(kv).toEqual({ MAIL_HOST: 'blizzard.mxrouting.net', MAIL_USER: 'al@amar.io', MAIL_PASS: 'p=a$s', MAIL_SIGNATURE: 'A\\nB' })
  })
  it('an env missing a required key is not an account', () => {
    expect(accountFromEnv('x', 'MAIL_HOST=h\nMAIL_USER=u\n')).toBeNull()
    expect(accountFromEnv('x', 'MAIL_HOST=h\nMAIL_USER=u\nMAIL_PASS=p\n')).toMatchObject({ name: 'x', host: 'h', user: 'u', pass: 'p', port: 993 })
  })
  it('discovers every <name>-mail/.env under the config home, sorted, skipping incomplete ones', () => {
    for (const [name, body] of [['ceo-mail', 'MAIL_HOST=h\nMAIL_USER=ceo@amar.io\nMAIL_PASS=p'], ['al-mail', 'MAIL_HOST=h\nMAIL_USER=al@amar.io\nMAIL_PASS=p'], ['broken-mail', 'MAIL_HOST=h'], ['not-mail-dir', 'MAIL_HOST=h\nMAIL_USER=u\nMAIL_PASS=p']]) {
      mkdirSync(join(dir, name!)); writeFileSync(join(dir, name!, '.env'), body!)
    }
    mkdirSync(join(dir, 'empty-mail'))
    expect(discoverAccounts(dir).map((a) => a.name)).toEqual(['al', 'ceo'])
    expect(discoverAccounts(join(dir, 'nope'))).toEqual([])
  })
})

// ---- pure helpers ----------------------------------------------------------

describe('imap message helpers', () => {
  it('textPart prefers text/plain, falls back to html, skips attachments, "1" for single-part', () => {
    expect(textPart({ type: 'text/plain', parameters: { charset: 'iso-8859-1' } })).toEqual({ part: '1', type: 'text/plain', charset: 'iso-8859-1' })
    const alt: ImapBodyNode = { type: 'multipart/alternative', childNodes: [{ part: '1', type: 'text/html' }, { part: '2', type: 'text/plain' }] }
    expect(textPart(alt)?.part).toBe('2')
    expect(textPart({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/html' }] })?.type).toBe('text/html')
    expect(textPart({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain', disposition: 'attachment' }] })).toBeNull()
    expect(textPart(undefined)).toBeNull()
  })
  it('hasAttachments walks the tree', () => {
    expect(hasAttachments({ type: 'text/plain' })).toBe(false)
    expect(hasAttachments({ type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'image/png', disposition: 'attachment' }] })).toBe(true)
    expect(hasAttachments({ type: 'multipart/mixed', childNodes: [{ type: 'application/pdf', parameters: { name: 'a.pdf' } }] })).toBe(true)
  })
  it('toSnippet strips html and collapses whitespace, capped', () => {
    expect(toSnippet('<style>x{}</style><p>Hi&nbsp;there</p>\n<b>you</b>', 'text/html')).toBe('Hi there you')
    // a capped read that ends inside <style> (marketing mail) must not leak CSS
    expect(toSnippet('<html><head><title>t</title><style>/** Google webfonts */ .a{color:red}', 'text/html')).toBe('')
    expect(toSnippet('<p>Body</p><!-- c --><style>.x{', 'text/html')).toBe('Body')
    expect(toSnippet('a\n\n  b   c', 'text/plain')).toBe('a b c')
    expect(toSnippet('x'.repeat(500), 'text/plain')).toHaveLength(240)
  })
})

// ---- watcher ----------------------------------------------------------------

describe('ImapIdleWatcher', () => {
  it('first connect with no cursor baselines at UIDNEXT-1 and emits nothing (backfill is not news)', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 1 }, { uid: 2 }, { uid: 3 }]
    const file = join(dir, 'imap-cursors.json')
    const { watcher, emitted, logs } = makeWatcher(server, file)
    watcher.start()
    await tick()
    expect(emitted).toEqual([])
    expect(readCursors(file).al).toMatchObject({ uidValidity: '100', lastUid: 3 })
    expect(logs.some((l) => l.includes('no cursor'))).toBe(true)
    expect(watcher.status().al).toMatchObject({ connected: true, mode: 'idle', address: 'al@amar.io', emitted: 0 })
    await watcher.stop()
    expect(watcher.status().al.connected).toBe(false)
  })

  it('a new message (EXISTS) → one mail.received with summary, key and ref; cursor advances', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 10 }]
    const file = join(dir, 'imap-cursors.json')
    const { watcher, emitted } = makeWatcher(server, file)
    watcher.start()
    await tick()
    server.deliver({ uid: 11, from: 'prads@example.com', subject: 'Invoice', text: 'Hi Al,\n\nplease find  attached.', attachment: true })
    await tick()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      topic: 'mail.received', source: 'imap:al', key: 'imap:al:100:11',
      ref: 'python3 ~/exec/al-mail.py --account al read 11',
      data: { account: 'al', address: 'al@amar.io', id: '11', uid: 11, from: 'Sender <prads@example.com>', fromName: 'Sender', fromEmail: 'prads@example.com', to: 'al@amar.io', subject: 'Invoice', snippet: 'Hi Al, please find attached.', hasAttachments: true, unread: true, messageId: '<11@x>' },
    })
    expect(readCursors(file).al.lastUid).toBe(11)
    await watcher.stop()
  })

  it('html-only bodies are stripped for the snippet; a \\Seen message reports unread:false', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 1 }]
    const { watcher, emitted } = makeWatcher(server, join(dir, 'c.json'))
    watcher.start()
    await tick()
    server.deliver({ uid: 2, html: '<div><p>Hello <b>world</b></p></div>', seen: true })
    await tick()
    expect(emitted[0]!.data).toMatchObject({ snippet: 'Hello world', unread: false, hasAttachments: false })
    await watcher.stop()
  })

  it('§10.8 (F) kill-and-restart: a fresh watcher over the persisted cursor emits exactly the messages that arrived while down', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 1 }, { uid: 2 }]
    const file = join(dir, 'imap-cursors.json')
    const first = makeWatcher(server, file)
    first.watcher.start()
    await tick()
    await first.watcher.stop()
    // hub is down: three messages land, one gets expunged
    server.messages.push({ uid: 3, subject: 'while down 1' }, { uid: 4, subject: 'while down 2' }, { uid: 5, subject: 'while down 3' })
    server.messages = server.messages.filter((m) => m.uid !== 4)
    const second = makeWatcher(server, file)
    second.watcher.start()
    await tick()
    expect(second.emitted.map((e) => e.data.uid)).toEqual([3, 5])
    expect(second.emitted.map((e) => e.data.subject)).toEqual(['while down 1', 'while down 3'])
    expect(server.clients[0]!.searches[0]).toBe('3:*')
    expect(readCursors(file).al.lastUid).toBe(5)
    await second.watcher.stop()
  })

  it('the `N:*` quirk: a search above the highest UID returns that message and must not re-emit it', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 7 }]
    const file = join(dir, 'imap-cursors.json')
    writeFileSync(file, JSON.stringify({ al: { uidValidity: '100', lastUid: 7, updatedAt: 0 } }))
    const { watcher, emitted } = makeWatcher(server, file)
    watcher.start()
    await tick()
    expect(server.clients[0]!.searches).toEqual(['8:*'])
    expect(emitted).toEqual([])
    await watcher.stop()
  })

  it('UIDVALIDITY change invalidates the cursor: re-baseline silently', async () => {
    const server = new FakeServer()
    server.uidValidity = 200n
    server.messages = [{ uid: 1 }, { uid: 2 }]
    const file = join(dir, 'imap-cursors.json')
    writeFileSync(file, JSON.stringify({ al: { uidValidity: '100', lastUid: 1, updatedAt: 0 } }))
    const { watcher, emitted, logs } = makeWatcher(server, file)
    watcher.start()
    await tick()
    expect(emitted).toEqual([])
    expect(readCursors(file).al).toMatchObject({ uidValidity: '200', lastUid: 2 })
    expect(logs.some((l) => l.includes('UIDVALIDITY changed'))).toBe(true)
    await watcher.stop()
  })

  it('reconnects after a drop with backoff and catches up what arrived in between', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 1 }]
    const { watcher, emitted, logs } = makeWatcher(server, join(dir, 'c.json'))
    watcher.start()
    await tick()
    expect(server.connects).toBe(1)
    server.dropAll()
    server.messages.push({ uid: 2, subject: 'during the gap' })
    await tick(60)
    expect(server.connects).toBeGreaterThanOrEqual(2)
    expect(emitted.map((e) => e.data.uid)).toEqual([2])
    expect(logs.some((l) => /reconnecting in/.test(l))).toBe(true)
    expect(watcher.status().al.reconnects).toBeGreaterThanOrEqual(1)
    await watcher.stop()
  })

  it('a failed login is retried, not fatal', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 1 }]
    const { watcher, logs } = makeWatcher(server, join(dir, 'c.json'), { failFirst: true })
    watcher.start()
    await tick(60)
    expect(server.connects).toBeGreaterThanOrEqual(2)
    expect(watcher.status().al.connected).toBe(true)
    expect(logs.some((l) => l.includes('LOGIN failed'))).toBe(true)
    await watcher.stop()
  })

  it('a burst of EXISTS during a catch-up is coalesced into a re-run, never a parallel fetch', async () => {
    const server = new FakeServer()
    server.messages = [{ uid: 1 }]
    const { watcher, emitted } = makeWatcher(server, join(dir, 'c.json'))
    watcher.start()
    await tick()
    server.deliver({ uid: 2 }); server.deliver({ uid: 3 }); server.deliver({ uid: 4 })
    await tick(40)
    expect(emitted.map((e) => e.data.uid)).toEqual([2, 3, 4])
    expect(new Set(emitted.map((e) => e.key)).size).toBe(3)
    await watcher.stop()
  })

  it('a server without IDLE reports mode poll; no accounts → idle adapter', async () => {
    const server = new FakeServer()
    server.idle = false
    server.messages = [{ uid: 1 }]
    const { watcher } = makeWatcher(server, join(dir, 'c.json'))
    watcher.start()
    await tick()
    expect(watcher.status().al.mode).toBe('poll')
    await watcher.stop()
    const none = makeWatcher(server, join(dir, 'd.json'), { accounts: [] })
    none.watcher.start()
    expect(none.logs[0]).toContain('no *-mail accounts')
    expect(none.watcher.status()).toEqual({})
    await none.watcher.stop()
  })
})
