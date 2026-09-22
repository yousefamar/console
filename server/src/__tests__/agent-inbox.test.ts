import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MxrouteClient, MxrouteError, generateMailboxPassword, loadMxrouteConfig } from '../mxroute/client.js'
import { INBOX_NAME_RE, listInboxes, provisionInbox, removeInbox, skillPath, type InboxDeps } from '../agents/inbox.js'
import { renderInboxSkill } from '../agents/inbox-skill.js'
import { parseMailEnv, type ImapAccount } from '../imap/accounts.js'
import { ImapIdleWatcher, type ImapClientLike } from '../imap/watcher.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'inbox-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fixedRandom = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff)

// ---- mxroute client -----------------------------------------------------------

describe('mxroute client', () => {
  it('reads mxroute.env and defaults the domain', () => {
    const f = join(dir, 'mxroute.env')
    expect(loadMxrouteConfig(f)).toBeNull()
    writeFileSync(f, "MXROUTE_SERVER=blizzard.mxrouting.net\nMXROUTE_USERNAME='yousef'\nMXROUTE_API_KEY=k123\n")
    expect(loadMxrouteConfig(f)).toEqual({ server: 'blizzard.mxrouting.net', username: 'yousef', apiKey: 'k123', domain: 'amar.io', baseUrl: 'https://api.mxroute.com' })
    writeFileSync(f, 'MXROUTE_SERVER=s\nMXROUTE_USERNAME=u\n')
    expect(loadMxrouteConfig(f)).toBeNull()
  })

  it('sends the three auth headers and unwraps data', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ success: true, data: [{ username: 'al', email: 'al@amar.io', quota: 1024, usage: 3, limit: 9600, sent: 0, suspended: false }] }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new MxrouteClient({ server: 'srv', username: 'u', apiKey: 'k', domain: 'amar.io', baseUrl: 'https://api.test' }, fetchImpl)
    const list = await c.listEmailAccounts()
    expect(list[0]!.email).toBe('al@amar.io')
    expect(calls[0]!.url).toBe('https://api.test/domains/amar.io/email-accounts')
    const h = calls[0]!.init.headers as Record<string, string>
    expect(h['X-Server']).toBe('srv'); expect(h['X-Username']).toBe('u'); expect(h['X-API-Key']).toBe('k')
    await c.createEmailAccount({ username: 'x', password: 'Passw0rdX', quota: 512 })
    expect(calls[1]!.init.method).toBe('POST')
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ username: 'x', password: 'Passw0rdX', quota: 512 })
  })

  it('turns the error envelope into MxrouteError with the code', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message: 'exists', field: 'username' } }), { status: 409 })) as unknown as typeof fetch
    const c = new MxrouteClient({ server: 's', username: 'u', apiKey: 'k', domain: 'amar.io', baseUrl: 'https://api.test' }, fetchImpl)
    const err = await c.createEmailAccount({ username: 'al', password: 'Passw0rdX' }).catch((e) => e as MxrouteError)
    expect(err).toBeInstanceOf(MxrouteError)
    expect((err as MxrouteError).code).toBe('CONFLICT')
    expect((err as MxrouteError).status).toBe(409)
    expect((err as MxrouteError).field).toBe('username')
  })

  it('generates an alphanumeric password with upper, lower and digit', () => {
    for (let seed = 0; seed < 20; seed++) {
      const rnd = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 17 + 5) & 0xff)
      const p = generateMailboxPassword(rnd)
      expect(p).toHaveLength(28)
      expect(p).toMatch(/^[A-Za-z0-9]+$/)
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/)
    }
  })
})

// ---- provisioning -------------------------------------------------------------

interface Harness { deps: InboxDeps; mx: { created: { username: string; password: string; quota?: number }[]; deleted: string[]; remote: { username: string; email: string; quota: number; usage: number; limit: number; sent: number; suspended: boolean }[]; fail?: MxrouteError }; watcher: { added: ImapAccount[]; removed: string[]; live: Set<string> }; listeners: { id: string; owner: { claudeSessionId: string; agentKey?: string; cwd?: string }; on: string; where: string[]; name: string; action: { type: 'wake'; prompt: string } }[]; wakes: { csid?: string; content: string }[]; imapFails: number; verified: ImapAccount[] }

function harness(over: { session?: { claudeSessionId: string; agentKey: string; cwd: string }; imapFails?: number } = {}): Harness {
  const configHome = join(dir, 'config')
  const vaultProjects = join(dir, 'projects')
  mkdirSync(configHome, { recursive: true })
  mkdirSync(join(vaultProjects, 'opsec'), { recursive: true })
  const mx: Harness['mx'] = { created: [], deleted: [], remote: [] }
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (mx.fail) return new Response(JSON.stringify({ success: false, error: { code: mx.fail.code, message: mx.fail.message } }), { status: mx.fail.status })
    const m = /\/domains\/([^/]+)\/email-accounts(?:\/([^/]+))?$/.exec(url)!
    if (init.method === 'POST') { const b = JSON.parse(init.body as string); mx.created.push(b); mx.remote.push({ username: b.username, email: `${b.username}@${m[1]}`, quota: b.quota ?? 1024, usage: 0, limit: 9600, sent: 0, suspended: false }); return new Response(JSON.stringify({ success: true, data: { username: b.username } }), { status: 201 }) }
    if (init.method === 'DELETE') {
      const i = mx.remote.findIndex((r) => r.username === m[2])
      if (i < 0) return new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'no such account' } }), { status: 404 })
      mx.remote.splice(i, 1); mx.deleted.push(m[2]!)
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    return new Response(JSON.stringify({ success: true, data: mx.remote }), { status: 200 })
  }) as unknown as typeof fetch
  const watcher: Harness['watcher'] = { added: [], removed: [], live: new Set(['al']) }
  const listeners: Harness['listeners'] = []
  const wakes: Harness['wakes'] = []
  const verified: ImapAccount[] = []
  let imapFails = over.imapFails ?? 0
  let n = 0
  const deps: InboxDeps = {
    mxroute: new MxrouteClient({ server: 'blizzard.mxrouting.net', username: 'u', apiKey: 'k', domain: 'amar.io', baseUrl: 'https://api.test' }, fetchImpl),
    configHome, vaultProjects, imapHost: 'blizzard.mxrouting.net',
    watcher: { has: (name) => watcher.live.has(name), addAccount: (a) => { watcher.added.push(a); watcher.live.add(a.name) }, removeAccount: (name) => { watcher.removed.push(name); watcher.live.delete(name) } },
    liveSession: (key) => (over.session && over.session.agentKey === key ? { ...over.session, status: 'idle' } : undefined),
    addListener: (input) => { const l = { id: `L${++n}`, ...input }; listeners.push(l); return { id: l.id } },
    listenersFor: (name) => listeners.filter((l) => l.where.includes(`data.account=${name}`)),
    removeListener: (id) => { const i = listeners.findIndex((l) => l.id === id); if (i >= 0) listeners.splice(i, 1) },
    wake: (s, content) => { wakes.push({ csid: s.claudeSessionId, content }); return 'fired' },
    verifyImap: async (a) => { if (imapFails > 0) { imapFails--; throw new Error('LOGIN failed') } verified.push(a) },
    random: fixedRandom,
    sleep: async () => {},
    log: () => {},
  }
  return { deps, mx, watcher, listeners, wakes, imapFails: over.imapFails ?? 0, verified }
}

const OPSEC = { claudeSessionId: 'bbed9624-abb1-4ab1-8dea-292e65df06ba', agentKey: 'opsec', cwd: '' }

describe('provisionInbox', () => {
  it('creates the mailbox, writes the .env al-mail.py reads, verifies IMAP, hot-adds the watcher, teaches the agent', async () => {
    const h = harness({ session: { ...OPSEC, cwd: join(dir, 'projects', 'opsec') } })
    const r = await provisionInbox({ name: 'opsec', fromName: 'OpSec', agentKey: 'opsec' }, h.deps)

    expect(r.address).toBe('opsec@amar.io')
    expect(r.created).toBe(true)
    expect(h.mx.created).toEqual([{ username: 'opsec', password: expect.stringMatching(/^[A-Za-z0-9]{28}$/), quota: 1024 }])

    // the .env: same shape as al-mail.py's, 0600 in a 0700 dir, password single-quoted
    const envFile = join(h.deps.configHome, 'opsec-mail', '.env')
    expect(r.envFile).toBe(envFile)
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(h.deps.configHome, 'opsec-mail')).mode & 0o777).toBe(0o700)
    const text = readFileSync(envFile, 'utf8')
    expect(text).toMatch(/^MAIL_PASS='[A-Za-z0-9]{28}'$/m)
    const kv = parseMailEnv(text)
    expect(kv.MAIL_HOST).toBe('blizzard.mxrouting.net')
    expect(kv.MAIL_USER).toBe('opsec@amar.io')
    expect(kv.MAIL_PASS).toBe(h.mx.created[0]!.password)
    expect(kv.MAIL_FROM_NAME).toBe('OpSec')
    expect(kv.MAIL_SIGNATURE).toBe('OpSec\\n\\nOpSec is an AI agent acting for Yousef Amar.')

    expect(r.imap).toEqual({ ok: true, attempts: 1 })
    expect(h.verified[0]).toMatchObject({ name: 'opsec', user: 'opsec@amar.io', pass: kv.MAIL_PASS, port: 993 })
    expect(r.watcher).toBe('added')
    expect(h.watcher.added[0]!.name).toBe('opsec')

    // skill in the agent's cwd, listener on its session, one wake
    expect(r.skillFile).toBe(skillPath(join(dir, 'projects', 'opsec'), 'opsec'))
    const skill = readFileSync(r.skillFile!, 'utf8')
    expect(skill).toMatch(/^name: opsec-email$/m)
    expect(skill).toContain('--account opsec')
    expect(skill).toContain('opsec@amar.io')
    expect(skill).toContain('Never fire off an email unprompted')
    expect(skill).toContain(`listener \`${r.listener!.id}\``)
    expect(h.listeners).toHaveLength(1)
    expect(h.listeners[0]).toMatchObject({ owner: { claudeSessionId: OPSEC.claudeSessionId, agentKey: 'opsec' }, on: 'mail.received', where: ['data.account=opsec'], name: 'opsec@ mail (IDLE)' })
    expect(h.listeners[0]!.action.prompt).toContain('--account opsec read <uid> --mark-read')
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0]!.csid).toBe(OPSEC.claudeSessionId)
    expect(h.wakes[0]!.content).toContain('[MAILBOX PROVISIONED]')
    expect(h.wakes[0]!.content).toContain(r.skillFile)
    expect(r.wake).toBe('fired')
    expect(r.warnings).toEqual([])
  })

  it('refuses a name that is not a safe local part / config key', async () => {
    const h = harness()
    for (const bad of ['', 'Op Sec', '-x', 'a@b', 'x'.repeat(40)]) {
      await expect(provisionInbox({ name: bad }, h.deps)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(INBOX_NAME_RE.test('scout.2')).toBe(true)
    expect(h.mx.created).toEqual([])
  })

  it('refuses to overwrite an existing local config, and never touches mxroute first', async () => {
    const h = harness()
    mkdirSync(join(h.deps.configHome, 'al-mail'))
    writeFileSync(join(h.deps.configHome, 'al-mail', '.env'), 'MAIL_HOST=h\nMAIL_USER=al@amar.io\nMAIL_PASS=p\n')
    await expect(provisionInbox({ name: 'al' }, h.deps)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.mx.created).toEqual([])
  })

  it('an mxroute CONFLICT explains how to adopt; --password adopts without creating', async () => {
    const h = harness()
    h.mx.fail = new MxrouteError(409, 'CONFLICT', 'Email account already exists')
    // .catch's return type unions with the promise's success type — narrow it:
    // the call MUST reject here, so make the success path fail the test.
    const err = await provisionInbox({ name: 'ceo' }, h.deps).then(
      () => { throw new Error('expected provisionInbox to reject on CONFLICT') },
      (e) => e as Error & { code: string },
    )
    expect(err.code).toBe('CONFLICT')
    expect(err.message).toContain('--password')
    expect(existsSync(join(h.deps.configHome, 'ceo-mail'))).toBe(false)

    h.mx.fail = undefined
    const r = await provisionInbox({ name: 'ceo', password: 'Existing1Pass', project: 'opsec', fromName: 'CEO', signature: 'CEO\\nAmar Systems Ltd' }, h.deps)
    expect(r.created).toBe(false)
    expect(h.mx.created).toEqual([])
    const kv = parseMailEnv(readFileSync(r.envFile, 'utf8'))
    expect(kv.MAIL_PASS).toBe('Existing1Pass')
    expect(kv.MAIL_SIGNATURE).toBe('CEO\\nAmar Systems Ltd')
    // no session: skill goes to the project dir, no listener, no wake, and the skill tells it how to register one
    expect(r.skillFile).toBe(skillPath(join(dir, 'projects', 'opsec'), 'ceo'))
    expect(readFileSync(r.skillFile!, 'utf8')).toContain('con listen add --on mail.received --where data.account=ceo')
    expect(r.listener).toBeNull()
    expect(r.wake).toBeNull()
  })

  it('retries the IMAP login while the fresh mailbox propagates, and warns (not fails) if it never does', async () => {
    const h = harness({ imapFails: 2 })
    const r = await provisionInbox({ name: 'slow', project: 'opsec' }, h.deps)
    expect(r.imap).toEqual({ ok: true, attempts: 3 })

    const h2 = harness({ imapFails: 99 })
    const r2 = await provisionInbox({ name: 'never', project: 'opsec' }, h2.deps)
    expect(r2.imap.ok).toBe(false)
    expect(r2.imap.attempts).toBe(6)
    expect(r2.warnings.some((w) => w.includes('IMAP login'))).toBe(true)
    expect(existsSync(r2.envFile)).toBe(true)
    expect(h2.watcher.added.map((a) => a.name)).toContain('never')
  })

  it('unknown --agent is a NOT_FOUND before anything is created; no --agent/--project warns that nobody was told', async () => {
    const h = harness()
    await expect(provisionInbox({ name: 'ghost', agentKey: 'nobody' }, h.deps)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(h.mx.created).toEqual([])
    const r = await provisionInbox({ name: 'lonely' }, h.deps)
    expect(r.skillFile).toBeNull()
    expect(r.warnings.join(' ')).toContain('nobody has been told')
  })

  it('does not stack a second listener when the session already has one for the account', async () => {
    const h = harness({ session: { ...OPSEC, cwd: join(dir, 'projects', 'opsec') } })
    h.listeners.push({ id: 'Lold', owner: { claudeSessionId: OPSEC.claudeSessionId }, on: 'mail.received', where: ['data.account=opsec'], name: 'x', action: { type: 'wake', prompt: 'p' } })
    const r = await provisionInbox({ name: 'opsec', agentKey: 'opsec', quiet: true }, h.deps)
    expect(r.listener).toBeNull()
    expect(h.listeners).toHaveLength(1)
    expect(r.warnings.join(' ')).toContain('already has a mail.received listener')
    expect(h.wakes).toEqual([])
  })
})

describe('removeInbox + listInboxes', () => {
  it('lists local configs joined with mxroute, then remove undoes every step', async () => {
    const h = harness({ session: { ...OPSEC, cwd: join(dir, 'projects', 'opsec') } })
    h.mx.remote.push({ username: 'al', email: 'al@amar.io', quota: 1024, usage: 12, limit: 9600, sent: 2, suspended: false })
    mkdirSync(join(h.deps.configHome, 'al-mail'))
    writeFileSync(join(h.deps.configHome, 'al-mail', '.env'), 'MAIL_HOST=h\nMAIL_USER=al@amar.io\nMAIL_PASS=p\n')
    const r = await provisionInbox({ name: 'opsec', agentKey: 'opsec' }, h.deps)

    const list = await listInboxes(h.deps)
    expect(list.domain).toBe('amar.io')
    expect(list.inboxes.map((i) => [i.name, i.local, i.watched, i.listeners.length, i.mxroute?.usage])).toEqual([
      ['al', true, true, 0, 12],
      ['opsec', true, true, 1, 0],
    ])

    const rm = await removeInbox('opsec', {}, h.deps)
    expect(rm).toMatchObject({ address: 'opsec@amar.io', mxroute: 'deleted', envRemoved: true, listenersRemoved: [r.listener!.id], skillsRemoved: [r.skillFile] })
    expect(h.mx.deleted).toEqual(['opsec'])
    expect(existsSync(join(h.deps.configHome, 'opsec-mail'))).toBe(false)
    expect(existsSync(r.skillFile!)).toBe(false)
    expect(h.watcher.removed).toEqual(['opsec'])
    expect(h.listeners).toEqual([])
    expect((await listInboxes(h.deps)).inboxes.map((i) => i.name)).toEqual(['al'])
  })

  it('--keep-mailbox leaves the mxroute account; a mailbox already gone on mxroute is reported, not an error', async () => {
    const h = harness()
    await provisionInbox({ name: 'keep', project: 'opsec' }, h.deps)
    expect((await removeInbox('keep', { keepMailbox: true }, h.deps)).mxroute).toBe('kept')
    expect(h.mx.remote.map((r) => r.username)).toEqual(['keep'])
    await provisionInbox({ name: 'gone', project: 'opsec' }, h.deps)
    h.mx.remote.length = 0
    expect((await removeInbox('gone', {}, h.deps)).mxroute).toBe('absent')
  })

  it('a listed mxroute account with no local config shows as remote-only', async () => {
    const h = harness()
    h.mx.remote.push({ username: 'ops', email: 'ops@amar.io', quota: 0, usage: 1, limit: 9600, sent: 0, suspended: false })
    const list = await listInboxes(h.deps)
    expect(list.inboxes).toEqual([{ name: 'ops', address: 'ops@amar.io', local: false, watched: false, mxroute: expect.objectContaining({ username: 'ops' }), listeners: [] }])
  })
})

describe('inbox skill text', () => {
  it('names the account everywhere the agent will type it and carries the signature verbatim', () => {
    const s = renderInboxSkill({ name: 'scout', address: 'scout@amar.io', fromName: 'Scout', host: 'h', envFile: '/e/.env', listenerId: 'L1', signature: 'Scout\n\nScout is an AI agent acting for Yousef Amar.' })
    expect(s.match(/--account scout/g)!.length).toBeGreaterThanOrEqual(5)
    expect(s).toContain('  Scout\n  \n  Scout is an AI agent acting for Yousef Amar.')
    expect(s).not.toContain('watch                           # cron guard')
  })
})

// ---- watcher hot-add / remove -------------------------------------------------

class FakeClient extends EventEmitter implements ImapClientLike {
  capabilities = new Map<string, boolean | number>([['IDLE', true]])
  closed = false
  constructor(readonly opened: string[], readonly name: string) { super() }
  async connect(): Promise<void> {}
  async mailboxOpen(): Promise<{ uidValidity: bigint; uidNext: number; exists: number }> { this.opened.push(this.name); return { uidValidity: 1n, uidNext: 5, exists: 4 } }
  async search(): Promise<number[]> { return [] }
  async fetchAll(): Promise<never[]> { return [] }
  async download(): Promise<{ content: Readable }> { return { content: Readable.from([]) } }
  close(): void { if (this.closed) return; this.closed = true; this.emit('close') }
}

describe('ImapIdleWatcher.addAccount / removeAccount', () => {
  it('starts a loop for a mailbox added after boot and stops it on removal, dropping its cursor', async () => {
    const opened: string[] = []
    const clients: FakeClient[] = []
    const cursorFile = join(dir, 'cursors.json')
    const w = new ImapIdleWatcher({
      accounts: [{ name: 'al', host: 'h', user: 'al@amar.io', pass: 'p', port: 993 }],
      cursorFile,
      connect: (a) => { const c = new FakeClient(opened, a.name); clients.push(c); return c },
      emit: () => null,
      log: () => {},
      backoff: { minMs: 5, maxMs: 10 },
    })
    w.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(opened).toEqual(['al'])
    expect(w.has('opsec')).toBe(false)

    w.addAccount({ name: 'opsec', host: 'h', user: 'opsec@amar.io', pass: 'p', port: 993 })
    w.addAccount({ name: 'opsec', host: 'h', user: 'opsec@amar.io', pass: 'p', port: 993 })
    await new Promise((r) => setTimeout(r, 20))
    expect(opened).toEqual(['al', 'opsec'])
    expect(w.has('opsec')).toBe(true)
    expect(w.status().opsec).toMatchObject({ connected: true, address: 'opsec@amar.io' })
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).toHaveProperty('opsec')

    w.removeAccount('opsec')
    await new Promise((r) => setTimeout(r, 40))
    expect(w.has('opsec')).toBe(false)
    expect(w.status()).not.toHaveProperty('opsec')
    expect(JSON.parse(readFileSync(cursorFile, 'utf8'))).not.toHaveProperty('opsec')
    expect(clients.filter((c) => c.name === 'opsec')).toHaveLength(1)
    expect(clients.find((c) => c.name === 'opsec')!.closed).toBe(true)
    expect(opened.filter((n) => n === 'al')).toHaveLength(1)
    await w.stop()
  })
})
