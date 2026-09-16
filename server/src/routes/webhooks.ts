// Project webhooks.
//
//   ANY  /hook/<project>[/<subpath>][?token=…]   inbound (public via Caddy as
//        https://con.amar.io/hub/hook/<project>) — the ONLY exempt path in the
//        auth wall; it authenticates itself: a `webhook`-scoped hub token named
//        `webhook:<project>` as `Authorization: Bearer …` OR `?token=` (many
//        providers can't set headers). A token for one project never opens
//        another — the name binds it to the slug.
//   GET  /webhooks                               status: every project with a
//        token and/or deliveries, its URL, owner, undelivered count
//   POST /webhooks/<project>/setup {rotate?}     mint the project's token
//        (plaintext shown once; refuses when one exists unless rotate, which
//        revokes the old one)
//   POST /webhooks/<project>/test  {body?, contentType?, headers?}
//        run the full pipeline as if the payload had arrived (no token needed
//        — it is behind the normal wall)
//   GET  /webhooks/<project>/deliveries[?limit]  project history, newest first
//   GET  /webhooks/deliveries/<id>               one record
//   POST /webhooks/deliveries/<id>/redeliver     replay to the current owner

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore } from '../auth-store.js'
import { MAX_WEBHOOK_BODY_BYTES, processInbound, redeliver, sanitiseQuery, type WebhookCtx } from '../webhooks/pipeline.js'

export interface WebhookRouteCtx extends WebhookCtx {
  authStore: AuthStore
  /** `https://con.amar.io` — the inbound URL is built on it. */
  publicOrigin: string
  /** A vault project this slug names (folder or flat .md). */
  projectExists: (slug: string) => boolean
  /** Is the session with this agentKey live right now? */
  agentLive: (agentKey: string) => boolean
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function webhookTokenName(project: string): string {
  return `webhook:${project}`
}

export function inboundUrl(publicOrigin: string, project: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/hub/hook/${encodeURIComponent(project)}`
}

/** Inbound paths are open in the auth wall (they carry their own token). */
export function isWebhookInboundPath(path: string): boolean {
  return path.startsWith('/hook/') && path.length > '/hook/'.length
}

/** `/hook/<project>[/<subpath>]` → parts, or null. */
export function parseInboundPath(path: string): { project: string; subpath: string } | null {
  const m = /^\/hook\/([^/]+)(\/.*)?$/.exec(path)
  if (!m) return null
  const project = decodeURIComponent(m[1]!)
  if (!SLUG_RE.test(project)) return null
  return { project, subpath: m[2] ?? '' }
}

function readRaw(req: IncomingMessage, max = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { reject(Object.assign(new Error(`body exceeds ${max} bytes`), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function bearerOf(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? '').trim())
  return m ? m[1]!.trim() : null
}

function clientIp(req: IncomingMessage): string | null {
  const xff = req.headers['x-forwarded-for']
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim()
  return first || req.socket.remoteAddress || null
}

export function handleWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: WebhookRouteCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  // ── Inbound ────────────────────────────────────────────────────────────
  if (path.startsWith('/hook/')) {
    const parsed = parseInboundPath(path)
    if (!parsed) { json({ error: 'bad project slug' }, 404); return true }
    const presented = bearerOf(req) ?? url.searchParams.get('token')
    const token = presented ? ctx.authStore.validateHubToken(presented) : null
    if (!token || token.scope !== 'webhook' || token.name !== webhookTokenName(parsed.project)) {
      ctx.log(`[webhooks] rejected ${req.method} ${path} from ${clientIp(req) ?? '?'}: ${presented ? 'token not valid for this project' : 'no token'}`)
      json({ error: 'invalid webhook token' }, 401)
      return true
    }
    readRaw(req).then((body) => {
      const rec = processInbound(ctx, {
        project: parsed.project,
        method: req.method ?? 'POST',
        subpath: parsed.subpath,
        query: sanitiseQuery(url.searchParams),
        headers: req.headers,
        source: clientIp(req),
        body,
        via: 'http',
      })
      json({ ok: true, id: rec.id, project: rec.project, delivered: rec.route.delivered, owner: rec.route.owner }, rec.route.delivered ? 200 : 202)
    }).catch((err: Error & { status?: number }) => {
      ctx.log(`[webhooks] ${path} failed: ${err.message}`)
      json({ error: err.message }, err.status ?? 400)
    })
    return true
  }

  if (!path.startsWith('/webhooks')) return false

  // ── Management ─────────────────────────────────────────────────────────
  if (path === '/webhooks' && req.method === 'GET') {
    const tokens = ctx.authStore.listHubTokens().filter((t) => t.scope === 'webhook' && !t.revoked && t.name.startsWith('webhook:'))
    const summary = ctx.store.summary()
    const slugs = new Set<string>([...tokens.map((t) => t.name.slice('webhook:'.length)), ...Object.keys(summary)])
    const projects = [...slugs].sort().map((project) => {
      const tok = tokens.find((t) => t.name === webhookTokenName(project))
      const owner = ctx.resolveOwner(project)
      return {
        project,
        url: inboundUrl(ctx.publicOrigin, project),
        token: tok ? { id: tok.id, createdAt: tok.createdAt, lastUsedAt: tok.lastUsedAt ?? null } : null,
        owner,
        ownerLive: owner ? ctx.agentLive(owner) : false,
        deliveries: summary[project]?.count ?? 0,
        undelivered: summary[project]?.undelivered ?? 0,
        lastReceivedAt: summary[project]?.lastReceivedAt ?? null,
      }
    })
    json({ projects })
    return true
  }

  const one = /^\/webhooks\/deliveries\/([^/]+)$/.exec(path)
  if (one && req.method === 'GET') {
    const rec = ctx.store.get(decodeURIComponent(one[1]!))
    if (!rec) { json({ error: 'not found' }, 404); return true }
    json(rec)
    return true
  }

  const replay = /^\/webhooks\/deliveries\/([^/]+)\/redeliver$/.exec(path)
  if (replay && req.method === 'POST') {
    const rec = redeliver(ctx, decodeURIComponent(replay[1]!))
    if (!rec) { json({ error: 'not found' }, 404); return true }
    const last = rec.redeliveries![rec.redeliveries!.length - 1]!
    json({ ok: true, id: rec.id, project: rec.project, delivered: last.delivered, owner: last.owner, detail: last.detail ?? null })
    return true
  }

  const proj = /^\/webhooks\/([^/]+)\/(setup|test|deliveries)$/.exec(path)
  if (!proj) return false
  const project = decodeURIComponent(proj[1]!)
  const verb = proj[2]!
  if (!SLUG_RE.test(project)) { json({ error: 'bad project slug' }, 400); return true }

  if (verb === 'deliveries' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
    json({ project, deliveries: ctx.store.list({ project, limit }).map(({ bodyText, bodyBase64, ...r }) => ({ ...r, bodyPreview: bodyText?.slice(0, 200) ?? (bodyBase64 ? '<binary>' : '') })) })
    return true
  }

  if (verb === 'setup' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { rotate } = JSON.parse(body || '{}') as { rotate?: boolean }
      if (!ctx.projectExists(project)) { json({ error: `no vault project "${project}"` }, 404); return }
      const name = webhookTokenName(project)
      const existing = ctx.authStore.listHubTokens().filter((t) => t.scope === 'webhook' && t.name === name && !t.revoked)
      if (existing.length && !rotate) {
        json({ error: `project ${project} already has a webhook token (${existing.map((t) => t.id).join(', ')}) — pass rotate to replace it`, tokenIds: existing.map((t) => t.id) }, 409)
        return
      }
      for (const t of existing) ctx.authStore.revokeHubToken(t.id)
      const { token, plaintext } = ctx.authStore.createHubToken(name, 'webhook')
      const owner = ctx.resolveOwner(project)
      const urlBase = inboundUrl(ctx.publicOrigin, project)
      ctx.log(`[webhooks] ${rotate && existing.length ? 'rotated' : 'minted'} token for ${project} (${token.id})`)
      json({
        project,
        url: urlBase,
        urlWithToken: `${urlBase}?token=${plaintext}`,
        header: `Authorization: Bearer ${plaintext}`,
        tokenId: token.id,
        revoked: existing.map((t) => t.id),
        owner,
        ownerLive: owner ? ctx.agentLive(owner) : false,
      })
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  if (verb === 'test' && req.method === 'POST') {
    readBody(req).then((raw) => {
      const { body, contentType, headers } = JSON.parse(raw || '{}') as { body?: unknown; contentType?: string; headers?: Record<string, string> }
      if (!ctx.projectExists(project)) { json({ error: `no vault project "${project}"` }, 404); return }
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      const ct = contentType ?? (typeof body === 'string' || body === undefined ? 'text/plain' : 'application/json')
      const rec = processInbound(ctx, {
        project,
        method: 'POST',
        subpath: '',
        query: {},
        headers: { ...(headers ?? {}), 'content-type': ct, 'user-agent': 'con webhook test' },
        source: 'cli',
        body: Buffer.from(text, 'utf8'),
        via: 'cli',
      })
      json({ ok: true, id: rec.id, project, delivered: rec.route.delivered, owner: rec.route.owner, detail: rec.route.detail ?? null })
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  return false
}
