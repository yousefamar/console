import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebhookStore } from '../webhooks/store.js'
import { buildDelivery, buildWebhookEnvelope, bodyPreview, processInbound, redeliver, sanitiseHeaders, sanitiseQuery, bodyIsText, webhookEvent, ENVELOPE_BODY_CHARS, type WebhookCtx } from '../webhooks/pipeline.js'
import type { EmitInput, HubEvent } from '../events/types.js'
import { handleWebhookRoutes, parseInboundPath, isWebhookInboundPath, webhookTokenName, inboundUrl, type WebhookRouteCtx } from '../routes/webhooks.js'
import { isAlwaysOpenPath } from '../auth-middleware.js'
import type { AuthStore, HubToken } from '../auth-store.js'

let dir: string
let store: WebhookStore
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webhooks-')); store = new WebhookStore(dir) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function ctxWith(opts: { owner?: string | null; live?: string[] } = {}): WebhookCtx & { delivered: Array<{ key: string; envelope: string }>; logs: string[] } {
  const delivered: Array<{ key: string; envelope: string }> = []
  const logs: string[] = []
  const live = new Set(opts.live ?? ['console-general'])
  return {
    store,
    resolveOwner: () => opts.owner === undefined ? 'console-general' : opts.owner,
    deliverToAgent: (key, envelope) => { if (!live.has(key)) return false; delivered.push({ key, envelope }); return true },
    log: (m) => logs.push(m),
    delivered, logs,
  }
}

const inbound = (over: Partial<Parameters<typeof processInbound>[1]> = {}) => ({
  project: 'console', method: 'POST', subpath: '', query: {}, headers: { 'content-type': 'application/json', 'user-agent': 'GitHub-Hookshot/1' },
  source: '140.82.115.1', body: Buffer.from(JSON.stringify({ action: 'opened', number: 7 })), via: 'http' as const, ...over,
})

describe('webhooks: sanitising', () => {
  it('drops credentials and transport headers, keeps provider ones', () => {
    const h = sanitiseHeaders({ Authorization: 'Bearer x', cookie: 'a=b', host: 'con.amar.io', 'x-forwarded-for': '1.2.3.4', 'X-GitHub-Event': 'push', 'x-hub-signature-256': 'sha256=abc', accept: ['a', 'b'] })
    expect(h).toEqual({ 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=abc', accept: 'a, b' })
  })
  it('drops only the hub token from the query', () => {
    expect(sanitiseQuery(new URLSearchParams('token=secret&ref=main'))).toEqual({ ref: 'main' })
  })
  it('classifies bodies', () => {
    expect(bodyIsText('application/json', Buffer.from('{}'))).toBe(true)
    expect(bodyIsText('application/vnd.api+json', Buffer.from('{}'))).toBe(true)
    expect(bodyIsText('image/png', Buffer.from([0x89, 0x50]))).toBe(false)
    expect(bodyIsText(null, Buffer.from('plain words'))).toBe(true)
    expect(bodyIsText(null, Buffer.from([0x00, 0x01, 0xff, 0xfe]))).toBe(false)
  })
})

describe('webhooks: delivery + envelope', () => {
  it('records a text body verbatim and a binary one as base64', () => {
    const text = buildDelivery(store, inbound())
    expect(text.bodyText).toBe('{"action":"opened","number":7}')
    expect(text.bodyBase64).toBeUndefined()
    expect(text.headers.authorization).toBeUndefined()
    const bin = buildDelivery(store, inbound({ headers: { 'content-type': 'image/png' }, body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }))
    expect(bin.bodyText).toBeUndefined()
    expect(bin.bodyBase64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'))
    expect(bodyPreview(bin).text).toMatch(/^<binary body, 4 bytes, image\/png, sha256 [0-9a-f]{16}…>$/)
  })

  it('envelope names the project, pretty-prints JSON and points at the record', () => {
    const rec = buildDelivery(store, inbound({ subpath: '/deploy', query: { ref: 'main' }, headers: { 'content-type': 'application/json', 'user-agent': 'GitHub-Hookshot/1', 'x-github-event': 'pull_request' } }))
    const env = buildWebhookEnvelope(rec)
    expect(env.startsWith('[WEBHOOK — project console]')).toBe(true)
    expect(env).toContain('from 140.82.115.1 via GitHub-Hookshot/1')
    expect(env).toContain('POST /hook/console/deploy?ref=main · application/json')
    expect(env).toContain('Headers: x-github-event: pull_request')
    expect(env).toContain('  "action": "opened",')
    expect(env).toContain(`con webhook show ${rec.id}`)
    expect(env).toContain('con webhook list console')
    expect(env).not.toContain('token=')
  })

  it('clips a long body and says how much is left', () => {
    const big = JSON.stringify({ items: Array.from({ length: 800 }, (_, i) => ({ i, s: 'x'.repeat(20) })) })
    const rec = buildDelivery(store, inbound({ body: Buffer.from(big) }))
    const env = buildWebhookEnvelope(rec)
    const p = bodyPreview(rec)
    expect(p.truncated).toBe(true)
    expect(p.text.length).toBe(ENVELOPE_BODY_CHARS)
    expect(env).toMatch(/\[… [\d.]+ KB more — `con webhook show /)
  })

  it('empty body is stated, not omitted', () => {
    const rec = buildDelivery(store, inbound({ body: Buffer.alloc(0), headers: {} }))
    expect(buildWebhookEnvelope(rec)).toContain('Body: (empty)')
    expect(buildWebhookEnvelope(rec)).toContain('no content-type (0 B)')
  })
})

describe('webhooks: pipeline', () => {
  it('archives then delivers to the owner, recording the route', () => {
    const ctx = ctxWith()
    const rec = processInbound(ctx, inbound())
    expect(rec.route).toMatchObject({ owner: 'console-general', delivered: true })
    expect(ctx.delivered).toHaveLength(1)
    expect(ctx.delivered[0]!.key).toBe('console-general')
    expect(ctx.delivered[0]!.envelope).toContain(rec.id)
    expect(store.get(rec.id)?.route.delivered).toBe(true)
    expect(readdirSync(join(dir, 'webhooks', 'deliveries'))).toEqual([`${rec.id}.json`])
    expect(ctx.logs[0]).toMatch(/\[webhooks\] console POST \/ .* → @console-general/)
  })

  it('no owner → archived, undelivered, reason recorded', () => {
    const ctx = ctxWith({ owner: null })
    const rec = processInbound(ctx, inbound())
    expect(rec.route.delivered).toBe(false)
    expect(rec.route.owner).toBeNull()
    expect(rec.route.detail).toMatch(/no owner for project console/)
    expect(store.get(rec.id)).not.toBeNull()
    expect(ctx.delivered).toHaveLength(0)
  })

  it('owner resolved but not live → undelivered naming the owner', () => {
    const ctx = ctxWith({ owner: 'astera-general', live: [] })
    const rec = processInbound(ctx, inbound({ project: 'astera' }))
    expect(rec.route).toMatchObject({ owner: 'astera-general', delivered: false, detail: '@astera-general is not live' })
  })

  it('redeliver replays to the CURRENT owner and appends to the record', () => {
    const dead = ctxWith({ owner: 'astera-general', live: [] })
    const rec = processInbound(dead, inbound({ project: 'astera' }))
    expect(store.summary().astera).toMatchObject({ count: 1, undelivered: 1 })
    const alive = ctxWith({ owner: 'astera-general', live: ['astera-general'] })
    const replayed = redeliver(alive, rec.id)!
    expect(replayed.redeliveries).toHaveLength(1)
    expect(replayed.redeliveries![0]).toMatchObject({ owner: 'astera-general', delivered: true })
    expect(alive.delivered[0]!.envelope).toContain('[WEBHOOK — project astera, redelivered]')
    expect(store.summary().astera).toMatchObject({ count: 1, undelivered: 0 })
    expect(redeliver(alive, 'nope')).toBeNull()
  })

  it('list is newest first and filters by project', () => {
    const ctx = ctxWith()
    processInbound(ctx, inbound({ project: 'a' }))
    const b = processInbound(ctx, inbound({ project: 'b' }))
    processInbound(ctx, inbound({ project: 'a' }))
    expect(store.list().map((r) => r.project)).toEqual(['a', 'b', 'a'])
    expect(store.list({ project: 'b' }).map((r) => r.id)).toEqual([b.id])
    expect(store.list({ limit: 1 })).toHaveLength(1)
    expect(store.get('../etc/passwd')).toBeNull()
  })
})

describe('webhooks: event bus + listener takeover', () => {
  it('emits webhook.received with provider headers + parsed json, and still wakes the owner when no listener matched', () => {
    const emitted: EmitInput[] = []
    const ctx = { ...ctxWith(), emit: (i: EmitInput) => { emitted.push(i); return { ...i, id: 'evt', at: 0, hops: 0 } as HubEvent }, matchedListeners: () => [] }
    const rec = processInbound(ctx, inbound({ headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=x' } }))
    expect(emitted).toHaveLength(1)
    const ev = emitted[0]!
    expect(ev.topic).toBe('webhook.received')
    expect(ev.key).toBe(rec.id)
    expect(ev.data).toMatchObject({ project: 'console', deliveryId: rec.id, headers: { 'x-github-event': 'push' }, json: { action: 'opened', number: 7 } })
    expect(ev.ref).toBe(`con webhook show ${rec.id}`)
    expect(rec.route.delivered).toBe(true)
    expect(rec.handledBy).toBeUndefined()
  })

  it('a matching listener owns the delivery: no owner-wake, handledBy recorded, counted as landed', () => {
    const base = ctxWith()
    const ctx = { ...base, emit: (i: EmitInput) => ({ ...i, id: 'evt', at: 0, hops: 0 } as HubEvent), matchedListeners: () => ['Labc123'] }
    const rec = processInbound(ctx, inbound())
    expect(base.delivered).toHaveLength(0)
    expect(rec.handledBy).toEqual(['Labc123'])
    expect(rec.route.delivered).toBe(false)
    expect(rec.route.detail).toMatch(/handled by listener\(s\) Labc123/)
    expect(store.summary().console.undelivered).toBe(0)
    expect(ctx.logs[0]).toMatch(/→ listeners Labc123/)
  })

  it('webhookEvent clips a huge JSON body field-by-field and keeps the rest', () => {
    const big = { ref: 'refs/heads/main', commits: 'x'.repeat(20_000), pusher: { name: 'nic' } }
    const rec = buildDelivery(store, inbound({ body: Buffer.from(JSON.stringify(big)) }))
    const data = webhookEvent(rec).data as { json: Record<string, unknown>; bodyPreview: string }
    expect(data.json.ref).toBe('refs/heads/main')
    expect(data.json.pusher).toEqual({ name: 'nic' })
    expect(String(data.json.commits).length).toBeLessThan(300)
    expect(data.bodyPreview.length).toBe(1024)
  })
})

describe('webhooks: paths + auth wall', () => {
  it('parses inbound paths', () => {
    expect(parseInboundPath('/hook/console')).toEqual({ project: 'console', subpath: '' })
    expect(parseInboundPath('/hook/reflection-tools/deploy/done')).toEqual({ project: 'reflection-tools', subpath: '/deploy/done' })
    expect(parseInboundPath('/hook/')).toBeNull()
    expect(parseInboundPath('/hook/..%2Fx')).toBeNull()
    expect(parseInboundPath('/webhooks/console')).toBeNull()
  })
  it('only the inbound path is exempt from the wall', () => {
    expect(isWebhookInboundPath('/hook/console')).toBe(true)
    expect(isWebhookInboundPath('/hook/')).toBe(false)
    expect(isAlwaysOpenPath('/hook/console', 'POST')).toBe(true)
    expect(isAlwaysOpenPath('/webhooks', 'GET')).toBe(false)
    expect(isAlwaysOpenPath('/webhooks/console/setup', 'POST')).toBe(false)
    expect(isAlwaysOpenPath('/webhooks/deliveries/x', 'GET')).toBe(false)
  })
  it('token name binds the project; URL is the public one', () => {
    expect(webhookTokenName('astera')).toBe('webhook:astera')
    expect(inboundUrl('https://con.amar.io/', 'astera')).toBe('https://con.amar.io/hub/hook/astera')
  })
})

// ── Route handler over real HTTP, with a stub token store ────────────────
class StubAuth {
  tokens: Array<HubToken & { plaintext: string }> = []
  createHubToken(name: string, scope: HubToken['scope']) {
    const plaintext = `pt-${this.tokens.length}-${name}`
    const token: HubToken & { plaintext: string } = { id: `id${this.tokens.length}`, name, scope, tokenHash: 'h', createdAt: Date.now(), plaintext }
    this.tokens.push(token)
    return { token, plaintext }
  }
  validateHubToken(pt: string) { return this.tokens.find((t) => t.plaintext === pt && !t.revoked) ?? null }
  listHubTokens() { return this.tokens.map(({ tokenHash, plaintext, ...r }) => r) }
  revokeHubToken(id: string) { const t = this.tokens.find((x) => x.id === id); if (!t) return false; t.revoked = true; return true }
}

describe('webhooks: routes', () => {
  let server: Server
  let base: string
  let auth: StubAuth
  let rctx: WebhookRouteCtx & { delivered: Array<{ key: string; envelope: string }> }
  const readBody = (req: import('node:http').IncomingMessage) => new Promise<string>((res) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => res(d)) })

  beforeEach(async () => {
    auth = new StubAuth()
    const inner = ctxWith({ owner: 'console-general', live: ['console-general'] })
    rctx = {
      ...inner,
      authStore: auth as unknown as AuthStore,
      publicOrigin: 'https://con.amar.io',
      projectExists: (slug) => ['console', 'astera'].includes(slug),
      agentLive: (key) => key === 'console-general',
    }
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (!handleWebhookRoutes(req, res, url.pathname, url, rctx, readBody)) { res.writeHead(404); res.end() }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))
  afterAll(() => { /* tmp dirs handled per test */ })

  const setup = async (project: string, rotate = false) => {
    const r = await fetch(`${base}/webhooks/${project}/setup`, { method: 'POST', body: JSON.stringify({ rotate }) })
    return { status: r.status, body: await r.json() as { urlWithToken?: string; header?: string; tokenId?: string; revoked?: string[]; error?: string; owner?: string | null } }
  }

  it('setup mints once, 409s on repeat, rotates on request', async () => {
    const first = await setup('console')
    expect(first.status).toBe(200)
    expect(first.body.urlWithToken).toMatch(/^https:\/\/con\.amar\.io\/hub\/hook\/console\?token=pt-0-webhook:console$/)
    expect(first.body.header).toBe('Authorization: Bearer pt-0-webhook:console')
    expect(first.body.owner).toBe('console-general')
    const again = await setup('console')
    expect(again.status).toBe(409)
    expect(again.body.error).toMatch(/already has a webhook token \(id0\)/)
    const rotated = await setup('console', true)
    expect(rotated.status).toBe(200)
    expect(rotated.body.revoked).toEqual(['id0'])
    expect(auth.tokens[0]!.revoked).toBe(true)
    expect((await setup('nope')).status).toBe(404)
  })

  it('inbound: bearer or ?token=, bound to the project; wrong/missing → 401 and nothing archived', async () => {
    const { body: c } = await setup('console')
    const { body: a } = await setup('astera')
    const consoleTok = c.header!.replace('Authorization: Bearer ', '')
    const asteraTok = a.header!.replace('Authorization: Bearer ', '')

    const viaHeader = await fetch(`${base}/hook/console/ci?run=42`, { method: 'POST', headers: { Authorization: `Bearer ${consoleTok}`, 'Content-Type': 'application/json', 'X-GitHub-Event': 'workflow_run' }, body: '{"ok":true}' })
    expect(viaHeader.status).toBe(200)
    const j = await viaHeader.json() as { id: string; delivered: boolean; owner: string; project: string }
    expect(j).toMatchObject({ delivered: true, owner: 'console-general', project: 'console' })
    expect(rctx.delivered).toHaveLength(1)
    expect(rctx.delivered[0]!.envelope).toContain('POST /hook/console/ci?run=42')
    expect(rctx.delivered[0]!.envelope).toContain('x-github-event: workflow_run')
    expect(rctx.delivered[0]!.envelope).not.toContain(consoleTok)

    const viaQuery = await fetch(`${base}/hook/console?token=${consoleTok}`, { method: 'POST', body: 'hello' })
    expect(viaQuery.status).toBe(200)
    const rec = store.get(((await viaQuery.json()) as { id: string }).id)!
    expect(rec.query).toEqual({})
    expect(rec.bodyText).toBe('hello')

    const crossProject = await fetch(`${base}/hook/console`, { method: 'POST', headers: { Authorization: `Bearer ${asteraTok}` }, body: '{}' })
    expect(crossProject.status).toBe(401)
    const none = await fetch(`${base}/hook/console`, { method: 'POST', body: '{}' })
    expect(none.status).toBe(401)
    const garbage = await fetch(`${base}/hook/console?token=nope`, { method: 'POST', body: '{}' })
    expect(garbage.status).toBe(401)
    expect(store.list({ project: 'console' })).toHaveLength(2)
    // A token for a project that has no deliveries yet still opens only that project.
    expect((await fetch(`${base}/hook/astera`, { method: 'GET', headers: { Authorization: `Bearer ${asteraTok}` } })).status).toBe(200)
  })

  it('inbound with no live owner → 202 and archived as undelivered; redeliver later lands', async () => {
    const { body: a } = await setup('astera')
    const tok = a.header!.replace('Authorization: Bearer ', '')
    rctx.resolveOwner = () => 'astera-general'
    const r = await fetch(`${base}/hook/astera`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: '{"deploy":"done"}' })
    expect(r.status).toBe(202)
    const { id } = await r.json() as { id: string }
    expect(store.get(id)!.route).toMatchObject({ owner: 'astera-general', delivered: false })

    const status = await (await fetch(`${base}/webhooks`)).json() as { projects: Array<{ project: string; undelivered: number; owner: string | null; ownerLive: boolean }> }
    expect(status.projects.find((p) => p.project === 'astera')).toMatchObject({ undelivered: 1, owner: 'astera-general', ownerLive: false })

    rctx.deliverToAgent = (key, envelope) => { rctx.delivered.push({ key, envelope }); return true }
    const replay = await fetch(`${base}/webhooks/deliveries/${id}/redeliver`, { method: 'POST' })
    expect(await replay.json()).toMatchObject({ ok: true, delivered: true, owner: 'astera-general' })
    expect(rctx.delivered.at(-1)!.envelope).toContain('redelivered')
    expect((await fetch(`${base}/webhooks/deliveries/zzz/redeliver`, { method: 'POST' })).status).toBe(404)
  })

  it('test runs the pipeline without a token; deliveries + show read back', async () => {
    const t = await fetch(`${base}/webhooks/console/test`, { method: 'POST', body: JSON.stringify({ body: { event: 'ping' } }) })
    expect(t.status).toBe(200)
    const { id } = await t.json() as { id: string }
    expect(rctx.delivered[0]!.envelope).toContain('"event": "ping"')
    expect(rctx.delivered[0]!.envelope).toContain('(cli)')
    const list = await (await fetch(`${base}/webhooks/console/deliveries`)).json() as { deliveries: Array<{ id: string; bodyPreview: string; bodyText?: string }> }
    expect(list.deliveries.map((d) => d.id)).toEqual([id])
    expect(list.deliveries[0]!.bodyPreview).toBe('{"event":"ping"}')
    expect(list.deliveries[0]!.bodyText).toBeUndefined()
    const one = await (await fetch(`${base}/webhooks/deliveries/${id}`)).json() as { bodyText: string; via: string }
    expect(one).toMatchObject({ bodyText: '{"event":"ping"}', via: 'cli' })
    expect((await fetch(`${base}/webhooks/nope/test`, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await fetch(`${base}/webhooks/deliveries/missing`)).status).toBe(404)
  })

  it('oversized body → 413, nothing archived', async () => {
    const { body: c } = await setup('console')
    const tok = c.header!.replace('Authorization: Bearer ', '')
    const r = await fetch(`${base}/hook/console`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: Buffer.alloc(1024 * 1024 + 1, 0x61) }).catch(() => null)
    if (r) expect(r.status).toBe(413)
    expect(store.list({ project: 'console' })).toHaveLength(0)
  })
})
