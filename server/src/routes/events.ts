// Event bus HTTP routes.
//
//   GET  /events?topic=<glob>&since=<ms|iso|2h>&until=&source=&limit=   log, newest first
//   GET  /events/topics                 topic docs + last example + count
//   GET  /events/status                 bus counters
//   GET  /events/<id>                   one event
//   POST /events {topic, data, key?, ref?}   custom emit (agents + scripts)
//   POST /events/<id>/redeliver {listener}   re-run one listener against an archived event
//   WS   /events/tail?topic=<glob>      live stream (wired in index.ts's upgrade handler)

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EventBus } from '../events/bus.js'
import type { HubEvent } from '../events/types.js'

export interface EventRouteCtx {
  bus: EventBus
  /** Set by the listener engine (card B); null until then. */
  redeliver?: (eventId: string, listenerId: string) => Promise<{ ok: boolean; detail: string }>
  /** Per-adapter health folded into `/events/status` (`adapters.imap.<account>` …). */
  adapters?: () => Record<string, unknown>
  log: (msg: string) => void
}

const REL_RE = /^(\d+)\s*(s|m|h|d|w)$/

/** `since` accepts epoch ms, ISO, or a relative window (`2h`, `30m`, `7d`). */
export function parseSince(raw: string | null, now = Date.now()): number | undefined {
  if (!raw) return undefined
  const rel = REL_RE.exec(raw.trim())
  if (rel) {
    const n = Number(rel[1])
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd' | 'w']
    return now - n * unit
  }
  if (/^\d{10,}$/.test(raw)) return Number(raw)
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : t
}

export function actorSource(req: IncomingMessage): string {
  const agent = (req.headers['x-console-agent'] as string | undefined)?.trim()
  return agent ? `cli:@${agent}` : 'http'
}

export function handleEventRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: EventRouteCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (path !== '/events' && !path.startsWith('/events/')) return false

  if (path === '/events' && req.method === 'GET') {
    json(ctx.bus.list({
      topic: url.searchParams.get('topic') ?? undefined,
      source: url.searchParams.get('source') ?? undefined,
      since: parseSince(url.searchParams.get('since')),
      until: parseSince(url.searchParams.get('until')),
      limit: Number(url.searchParams.get('limit') ?? 50) || 50,
    }))
    return true
  }

  if (path === '/events' && req.method === 'POST') {
    readBody(req).then((raw) => {
      const body = JSON.parse(raw || '{}') as { topic?: string; data?: unknown; key?: string; ref?: string }
      if (!body.topic) { json({ error: 'topic is required' }, 400); return }
      const data = body.data === undefined ? {} : body.data
      if (typeof data !== 'object' || data === null || Array.isArray(data)) { json({ error: 'data must be a JSON object' }, 400); return }
      const out = ctx.bus.emitWithOutcome({
        topic: body.topic, data: data as Record<string, unknown>, source: actorSource(req),
        ...(body.key ? { key: body.key } : {}), ...(body.ref ? { ref: body.ref } : {}),
      })
      if (!out.event) {
        if (out.dropped === 'invalid-topic') { json({ error: `bad topic "${body.topic}" — lower-case dotted segments, e.g. astera.release` }, 400); return }
        json({ ok: true, dropped: out.dropped, event: null }, 200)
        return
      }
      json({ ok: true, event: out.event })
    }).catch((e: Error) => json({ error: e.message }, 400))
    return true
  }

  if (path === '/events/topics' && req.method === 'GET') { json(ctx.bus.topics()); return true }
  if (path === '/events/status' && req.method === 'GET') { json({ ...ctx.bus.status(), adapters: ctx.adapters?.() ?? {} }); return true }

  const replay = /^\/events\/([^/]+)\/redeliver$/.exec(path)
  if (replay && req.method === 'POST') {
    readBody(req).then(async (raw) => {
      const { listener } = JSON.parse(raw || '{}') as { listener?: string }
      if (!listener) { json({ error: 'listener is required' }, 400); return }
      if (!ctx.redeliver) { json({ error: 'listener engine not available' }, 503); return }
      const id = decodeURIComponent(replay[1]!)
      if (!ctx.bus.get(id)) { json({ error: 'event not found' }, 404); return }
      json(await ctx.redeliver(id, listener))
    }).catch((e: Error) => json({ error: e.message }, 400))
    return true
  }

  const one = /^\/events\/([^/]+)$/.exec(path)
  if (one && req.method === 'GET') {
    const ev: HubEvent | null = ctx.bus.get(decodeURIComponent(one[1]!))
    if (!ev) { json({ error: 'not found' }, 404); return true }
    json(ev)
    return true
  }
  return false
}
