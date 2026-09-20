// ImapIdleWatcher — one persistent IMAP connection per agent mailbox, sitting
// in IDLE; every new message becomes a `mail.received` event. Replaces the
// `al-mail.py watch` crons that spawned a Python process every 5 min per box.
//
// Cursor = (UIDVALIDITY, last UID) per account in `imap-cursors.json`. On
// connect: no cursor (or UIDVALIDITY changed) → baseline silently at UIDNEXT-1
// (backfill is not news); cursor present → `UID SEARCH <last+1>:*` emits
// exactly what arrived while the hub was down. The bus dedups (topic,key)
// across a restart, so a re-read UID is dropped, not doubled.
//
// The client is injected so tests drive a fake; production hands in imapflow,
// which owns IDLE itself: auto-IDLE when the connection goes quiet, re-issued
// every `maxIdleTime`, NOOP keepalive on socket timeout, NOOP polling when a
// server lacks IDLE. This class owns connect/reconnect, the cursor, catch-up.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import type { ImapAccount } from './accounts.js'
import type { EmitInput, HubEvent } from '../events/types.js'

export interface ImapAddress { name?: string | undefined; address?: string | undefined }
export interface ImapEnvelope {
  date?: Date | string | undefined
  subject?: string | undefined
  messageId?: string | undefined
  inReplyTo?: string | undefined
  from?: ImapAddress[] | undefined
  to?: ImapAddress[] | undefined
}
export interface ImapBodyNode {
  part?: string | undefined
  type: string
  parameters?: Record<string, string> | undefined
  disposition?: string | undefined
  dispositionParameters?: Record<string, string> | undefined
  childNodes?: ImapBodyNode[] | undefined
}
export interface ImapFetched {
  uid: number
  envelope?: ImapEnvelope | undefined
  bodyStructure?: ImapBodyNode | undefined
  flags?: Set<string> | undefined
  internalDate?: Date | string | undefined
}

/** The slice of imapflow's `ImapFlow` the watcher touches — structurally satisfied by the real client. */
export interface ImapClientLike {
  connect(): Promise<void>
  mailboxOpen(path: string, options?: { readOnly?: boolean | undefined }): Promise<{ uidValidity: bigint | number; uidNext: number; exists: number }>
  search(query: { uid: string }, options?: { uid?: boolean | undefined }): Promise<number[] | false | undefined>
  fetchAll(range: string, query: Record<string, boolean>, options?: { uid?: boolean | undefined }): Promise<ImapFetched[]>
  download(range: string, part?: string | undefined, options?: { uid?: boolean | undefined; maxBytes?: number | undefined }): Promise<{ content: Readable }>
  close(): void
  on(event: 'exists', fn: (data: { path: string; count: number; prevCount: number }) => void): unknown
  on(event: 'close', fn: () => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  capabilities: Map<string, boolean | number>
}

export interface ImapCursor { uidValidity: string; lastUid: number; updatedAt: number }

export interface ImapWatcherCtx {
  accounts: ImapAccount[]
  cursorFile: string
  connect: (account: ImapAccount) => ImapClientLike
  emit: (input: EmitInput) => HubEvent | null
  log: (msg: string) => void
  /** Reconnect backoff bounds; doubles per failure, resets after a connection that lived a minute. */
  backoff?: { minMs: number; maxMs: number }
  now?: () => number
}

export interface ImapAccountStatus {
  address: string
  connected: boolean
  /** `idle` when the server advertises IDLE, `poll` when imapflow fell back to NOOP polling. */
  mode: 'idle' | 'poll' | null
  since: number | null
  cursor: ImapCursor | null
  lastError: string | null
  lastEventAt: number | null
  emitted: number
  reconnects: number
}

export const SNIPPET_CHARS = 240
/** Cap on the text part fetched for the snippet (a partial FETCH server-side; marketing html front-loads KBs of CSS). */
const SNIPPET_BYTES = 32 * 1024
const DEFAULT_BACKOFF = { minMs: 5_000, maxMs: 5 * 60_000 }
const STABLE_MS = 60_000

/** First text part to preview — plain wins, html is the fallback. `part` is `'1'` for a non-multipart message. */
export function textPart(node: ImapBodyNode | undefined): { part: string; type: string; charset: string } | null {
  if (!node) return null
  const flat: ImapBodyNode[] = []
  const walk = (n: ImapBodyNode) => { flat.push(n); for (const c of n.childNodes ?? []) walk(c) }
  walk(node)
  const pick = (type: string) => flat.find((n) => n.type.toLowerCase() === type && n.disposition?.toLowerCase() !== 'attachment')
  const hit = pick('text/plain') ?? pick('text/html')
  if (!hit) return null
  return { part: hit.part ?? '1', type: hit.type.toLowerCase(), charset: hit.parameters?.charset ?? 'utf-8' }
}

export function hasAttachments(node: ImapBodyNode | undefined): boolean {
  if (!node) return false
  if (node.disposition?.toLowerCase() === 'attachment' || node.dispositionParameters?.filename || node.parameters?.name) return true
  return (node.childNodes ?? []).some(hasAttachments)
}

/** Collapse a text or html body into a one-line preview. */
export function toSnippet(text: string, type: string): string {
  let s = text
  if (type === 'text/html') {
    // A capped read can cut inside <head>/<style>: strip terminated blocks, then anything unterminated to the end.
    s = s.replace(/<head\b[\s\S]*?<\/head>/gi, ' ').replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<(head|style|script)\b[\s\S]*$/i, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
  }
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS - 1)}…` : s
}

function decodeBytes(buf: Buffer, charset: string): string {
  try { return new TextDecoder(charset).decode(buf) } catch { return buf.toString('utf8') }
}

/** Drain the (already server-capped) part; never destroy early — imapflow tracks the open download. */
async function readCapped(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks).subarray(0, max)
}

function formatAddress(a: ImapAddress | undefined): string {
  if (!a) return ''
  if (a.name && a.address) return `${a.name} <${a.address}>`
  return a.address ?? a.name ?? ''
}

interface Live {
  client: ImapClientLike | null
  status: ImapAccountStatus
  catchingUp: Promise<void> | null
  rerun: boolean
  removed: boolean
}

export class ImapIdleWatcher {
  private cursors: Record<string, ImapCursor>
  private readonly live = new Map<string, Live>()
  private stopped = true
  private loops: Promise<void>[] = []

  constructor(private readonly ctx: ImapWatcherCtx) {
    this.cursors = this.loadCursors()
    for (const a of ctx.accounts) this.register(a)
  }

  private register(a: ImapAccount): Live {
    const l: Live = {
      client: null, catchingUp: null, rerun: false, removed: false,
      status: { address: a.user, connected: false, mode: null, since: null, cursor: this.cursors[a.name] ?? null, lastError: null, lastEventAt: null, emitted: 0, reconnects: 0 },
    }
    this.live.set(a.name, l)
    return l
  }

  private now(): number { return this.ctx.now ? this.ctx.now() : Date.now() }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (!this.ctx.accounts.length) { this.ctx.log('[imap] no *-mail accounts configured — adapter idle'); return }
    this.loops = this.ctx.accounts.map((a) => this.runAccount(a))
  }

  has(name: string): boolean { return this.live.has(name) && !this.live.get(name)!.removed }

  /** Start watching a mailbox provisioned after boot. No-op if the name is already live. */
  addAccount(a: ImapAccount): void {
    if (this.has(a.name)) return
    this.ctx.accounts.push(a)
    this.register(a)
    if (!this.stopped) this.loops.push(this.runAccount(a))
  }

  /** Close a mailbox's connection and let its loop exit; the cursor is dropped so a re-add baselines afresh. */
  removeAccount(name: string): void {
    const l = this.live.get(name)
    if (!l) return
    l.removed = true
    try { l.client?.close() } catch { /* already gone */ }
    this.live.delete(name)
    const i = this.ctx.accounts.findIndex((a) => a.name === name)
    if (i >= 0) this.ctx.accounts.splice(i, 1)
    if (this.cursors[name]) { delete this.cursors[name]; this.saveCursors() }
  }

  /** Closes every connection; resolves once each account loop has exited. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const l of this.live.values()) { try { l.client?.close() } catch { /* already gone */ } }
    await Promise.allSettled(this.loops)
    this.loops = []
  }

  status(): Record<string, ImapAccountStatus> {
    const out: Record<string, ImapAccountStatus> = {}
    for (const [name, l] of this.live) out[name] = { ...l.status, cursor: this.cursors[name] ?? null }
    return out
  }

  /** Re-check one account now (an `exists` arrived, or a caller wants a poll). Resolves when the catch-up finishes. */
  async check(name: string): Promise<void> {
    const l = this.live.get(name)
    const acct = this.ctx.accounts.find((a) => a.name === name)
    if (!l?.client || !acct) return
    return this.catchUp(acct, l)
  }

  // ---- connection loop ---------------------------------------------------

  private async runAccount(account: ImapAccount): Promise<void> {
    const l = this.live.get(account.name)!
    const backoff = this.ctx.backoff ?? DEFAULT_BACKOFF
    let wait = backoff.minMs
    while (!this.stopped && !l.removed) {
      const connectedAt = this.now()
      let closed!: () => void
      const gone = new Promise<void>((resolve) => { closed = resolve })
      const client = this.ctx.connect(account)
      l.client = client
      client.on('error', (err) => { l.status.lastError = err.message })
      client.on('close', () => { l.status.connected = false; closed() })
      // imapflow only emits `exists` when the open mailbox's count changes, so
      // this is safe before mailboxOpen; a burst during the initial catch-up
      // just marks it for a re-run.
      client.on('exists', () => { void this.catchUp(account, l) })
      try {
        await client.connect()
        const box = await client.mailboxOpen('INBOX', { readOnly: true })
        l.status.connected = true
        l.status.since = this.now()
        l.status.mode = client.capabilities.has('IDLE') ? 'idle' : 'poll'
        const prev = this.cursors[account.name]
        const validity = String(box.uidValidity)
        if (!prev || prev.uidValidity !== validity) {
          this.setCursor(account.name, { uidValidity: validity, lastUid: Math.max(0, box.uidNext - 1), updatedAt: this.now() })
          this.ctx.log(`[imap] ${account.name}: ${prev ? 'UIDVALIDITY changed — ' : 'no cursor — '}baseline at uid ${box.uidNext - 1}, nothing emitted (backfill)`)
        } else {
          await this.catchUp(account, l)
        }
        this.ctx.log(`[imap] ${account.name}: connected (${l.status.mode}), cursor uid ${this.cursors[account.name]!.lastUid}`)
        await gone
      } catch (err) {
        l.status.lastError = (err as Error).message
        this.ctx.log(`[imap] ${account.name}: ${(err as Error).message}`)
      } finally {
        l.status.connected = false
        l.client = null
        try { client.close() } catch { /* already closed */ }
      }
      if (this.stopped || l.removed) break
      if (this.now() - connectedAt > STABLE_MS) wait = backoff.minMs
      l.status.reconnects++
      this.ctx.log(`[imap] ${account.name}: disconnected${l.status.lastError ? ` (${l.status.lastError})` : ''} — reconnecting in ${Math.round(wait / 1000)} s`)
      await new Promise((r) => setTimeout(r, wait))
      wait = Math.min(wait * 2, backoff.maxMs)
    }
  }

  // ---- catch-up: everything above the cursor ------------------------------

  private catchUp(account: ImapAccount, l: Live): Promise<void> {
    if (l.catchingUp) { l.rerun = true; return l.catchingUp }
    l.catchingUp = (async () => {
      try {
        do {
          l.rerun = false
          await this.fetchNew(account, l)
        } while (l.rerun && l.client)
      } catch (err) {
        l.status.lastError = (err as Error).message
        this.ctx.log(`[imap] ${account.name}: catch-up failed — ${(err as Error).message}`)
      } finally {
        l.catchingUp = null
      }
    })()
    return l.catchingUp
  }

  private async fetchNew(account: ImapAccount, l: Live): Promise<void> {
    const client = l.client
    const cursor = this.cursors[account.name]
    if (!client || !cursor) return
    // `N:*` with N above the highest UID still returns that highest message — filter, as al-mail.py does.
    const found = (await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })) || []
    const uids = found.filter((u) => u > cursor.lastUid).sort((a, b) => a - b)
    if (!uids.length) return
    const msgs = await client.fetchAll(uids.join(','), { uid: true, envelope: true, bodyStructure: true, flags: true, internalDate: true }, { uid: true })
    msgs.sort((a, b) => a.uid - b.uid)
    for (const msg of msgs) {
      if (msg.uid <= (this.cursors[account.name]?.lastUid ?? 0)) continue
      const snippet = await this.snippetOf(client, msg)
      this.emitMessage(account, msg, snippet, cursor.uidValidity)
      l.status.emitted++
      l.status.lastEventAt = this.now()
      this.setCursor(account.name, { uidValidity: cursor.uidValidity, lastUid: msg.uid, updatedAt: this.now() })
    }
    this.ctx.log(`[imap] ${account.name}: ${msgs.length} new → mail.received (cursor uid ${this.cursors[account.name]!.lastUid})`)
  }

  private async snippetOf(client: ImapClientLike, msg: ImapFetched): Promise<string> {
    const tp = textPart(msg.bodyStructure)
    if (!tp) return ''
    try {
      const { content } = await client.download(String(msg.uid), tp.part, { uid: true, maxBytes: SNIPPET_BYTES })
      return toSnippet(decodeBytes(await readCapped(content, SNIPPET_BYTES), tp.charset), tp.type)
    } catch {
      return ''
    }
  }

  private emitMessage(account: ImapAccount, msg: ImapFetched, snippet: string, uidValidity: string): void {
    const env = msg.envelope ?? {}
    const from = env.from?.[0]
    const date = env.date ? new Date(env.date) : msg.internalDate ? new Date(msg.internalDate) : null
    this.ctx.emit({
      topic: 'mail.received',
      source: `imap:${account.name}`,
      key: `imap:${account.name}:${uidValidity}:${msg.uid}`,
      data: {
        account: account.name,
        address: account.user,
        id: String(msg.uid),
        uid: msg.uid,
        messageId: env.messageId ?? '',
        inReplyTo: env.inReplyTo ?? '',
        from: formatAddress(from),
        fromName: from?.name ?? '',
        fromEmail: from?.address ?? '',
        to: (env.to ?? []).map(formatAddress).filter(Boolean).join(', '),
        subject: env.subject ?? '(no subject)',
        snippet,
        date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : '',
        hasAttachments: hasAttachments(msg.bodyStructure),
        unread: !(msg.flags?.has('\\Seen') ?? false),
      },
      ref: `python3 ~/exec/al-mail.py --account ${account.name} read ${msg.uid}`,
    })
  }

  // ---- cursors ------------------------------------------------------------

  private loadCursors(): Record<string, ImapCursor> {
    if (!existsSync(this.ctx.cursorFile)) return {}
    try { return JSON.parse(readFileSync(this.ctx.cursorFile, 'utf8')) as Record<string, ImapCursor> } catch { return {} }
  }

  private setCursor(name: string, cursor: ImapCursor): void {
    this.cursors[name] = cursor
    const l = this.live.get(name)
    if (l) l.status.cursor = cursor
    this.saveCursors()
  }

  private saveCursors(): void {
    mkdirSync(dirname(this.ctx.cursorFile), { recursive: true })
    const tmp = `${this.ctx.cursorFile}.tmp`
    writeFileSync(tmp, JSON.stringify(this.cursors, null, 2))
    renameSync(tmp, this.ctx.cursorFile)
  }
}
