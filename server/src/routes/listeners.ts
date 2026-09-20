// Listener HTTP routes.
//
//   GET    /listeners[?session=<csid>&topic=]        fleet-wide list
//   POST   /listeners  {owner:{claudeSessionId,agentKey?,cwd?}, on, where?[], guard?, coalesce?, cooldown?, hours?, days?, dropOutside?, maxPerHour?, name?, action,
//                       expect?: {by?, window?, after?, afterWhere?[], within?, then?}}   — expect present = act on the event's ABSENCE; action is the --else
//   GET    /listeners/<id>                            full record incl. outcomes
//   DELETE /listeners/<id>[?force=1]                  403 for an agent removing another session's listener without force
//   POST   /listeners/<id>/pause | /resume
//   POST   /listeners/<id>/test  {event?: <id>, topic?, data?}   dry run — which rung stops it
//   POST   /listeners/<id>/flush                      fire the pending batch now (expectation: judge the nearest deadline now)

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ListenerEngine, AddListenerInput } from '../listeners/engine.js'
import type { EventBus } from '../events/bus.js'
import type { HubEvent } from '../events/types.js'
import type { Session } from '../session.js'

export interface ListenerRouteCtx {
  engine: ListenerEngine
  bus: EventBus
  getSessions: () => Map<string, Session>
  log: (msg: string) => void
}

function nameForSession(csid: string, ctx: ListenerRouteCtx): string {
  for (const s of ctx.getSessions().values()) if (s.claudeSessionId === csid) return s.name || csid.slice(0, 8)
  return csid.slice(0, 8)
}

export function handleListenerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  ctx: ListenerRouteCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  if (path !== '/listeners' && !path.startsWith('/listeners/')) return false
  const actor = (req.headers['x-console-agent'] as string | undefined)?.trim() || undefined

  if (path === '/listeners' && req.method === 'GET') {
    const session = url.searchParams.get('session') ?? undefined
    const topic = url.searchParams.get('topic') ?? undefined
    json(ctx.engine.list({ claudeSessionId: session, topic }).map((l) => ({ ...l, ownerName: nameForSession(l.owner.claudeSessionId, ctx) })))
    return true
  }

  if (path === '/listeners' && req.method === 'POST') {
    readBody(req).then((raw) => {
      try {
        const input = JSON.parse(raw || '{}') as AddListenerInput
        if (input.owner && actor && !input.owner.agentKey) input.owner.agentKey = actor
        if (input.owner && !input.owner.cwd) {
          for (const s of ctx.getSessions().values()) if (s.claudeSessionId === input.owner.claudeSessionId) { input.owner.cwd = s.cwd; break }
        }
        json(ctx.engine.add(input))
      } catch (e) {
        json({ error: (e as Error).message }, 400)
      }
    }).catch((e: Error) => json({ error: e.message }, 500))
    return true
  }

  const m = /^\/listeners\/([A-Za-z0-9_-]+)(?:\/(pause|resume|test|flush))?$/.exec(path)
  if (!m) return false
  const id = m[1]!
  const verb = m[2]
  const l = ctx.engine.get(id)
  if (!l) { json({ error: `no listener ${id}` }, 404); return true }

  if (!verb && req.method === 'GET') { json({ ...l, ownerName: nameForSession(l.owner.claudeSessionId, ctx) }); return true }

  if (!verb && req.method === 'DELETE') {
    const force = url.searchParams.get('force') === '1'
    if (actor && !force) {
      const own = [...ctx.getSessions().values()].some((s) => s.agentKey === actor && s.claudeSessionId === l.owner.claudeSessionId) || l.owner.agentKey === actor
      if (!own) {
        json({ error: `listener ${id} belongs to session "${nameForSession(l.owner.claudeSessionId, ctx)}", not to ${actor}. Pass --force (?force=1) only if you are certain — the owner will be told.`, owner: l.owner.claudeSessionId }, 403)
        return true
      }
    }
    json({ removed: ctx.engine.remove(id, { actor: actor ?? 'unknown', reason: force ? 'forced' : undefined }) })
    return true
  }

  if (verb === 'pause' && req.method === 'POST') { json(ctx.engine.pause(id, `paused by ${actor ?? 'a human client'}`)); return true }
  if (verb === 'resume' && req.method === 'POST') { json(ctx.engine.resume(id)); return true }
  if (verb === 'flush' && req.method === 'POST') {
    if (l.expect) {
      void ctx.engine.judgeNow(l).then((r) => json({ ...r, outcome: l.outcomes[l.outcomes.length - 1] ?? null })).catch((e: Error) => json({ error: e.message }, 500))
      return true
    }
    if (!l.pending) { json({ ok: false, detail: 'nothing pending' }); return true }
    l.pending.dueAt = Date.now()
    void ctx.engine.flushPending(l).then(() => json({ ok: true, outcome: l.outcomes[l.outcomes.length - 1] ?? null })).catch((e: Error) => json({ error: e.message }, 500))
    return true
  }
  if (verb === 'test' && req.method === 'POST') {
    readBody(req).then(async (raw) => {
      const body = JSON.parse(raw || '{}') as { event?: string; topic?: string; data?: Record<string, unknown> }
      let ev: HubEvent | null = null
      if (body.event) ev = ctx.bus.get(body.event)
      else if (body.topic) ev = { id: 'test', topic: body.topic, at: Date.now(), source: `test:${actor ?? 'http'}`, hops: 0, data: body.data ?? {} }
      else ev = ctx.bus.list({ topic: l.on, limit: 1 })[0] ?? null
      if (!ev) { json({ error: 'no event to test with — pass {event: <id>} or {topic, data}, or emit one first' }, 400); return }
      json({ event: ev.id, ...(await ctx.engine.test(id, ev)) })
    }).catch((e: Error) => json({ error: e.message }, 400))
    return true
  }
  json({ error: 'method not allowed' }, 405)
  return true
}
