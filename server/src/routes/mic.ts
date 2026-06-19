// Push-to-talk mic routes. See server/src/mic.ts for the ownership model.
//
// All resolution (target → session id, effective owner, transcript inject)
// is supplied by index.ts via the ctx closures, since the session map, the
// Al accessor, and the agent registry all live there.

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface MicRouteCtx {
  /** Effective owner = explicit owner if alive, else Al. null if neither up. */
  effectiveOwnerId: () => string | null
  ownerName: (sessionId: string | null) => string | undefined
  isHot: () => boolean
  /** Explicit (stored) owner session id, or null if defaulting to Al. */
  explicitOwnerId: () => string | null
  /** Resolve a session id / name / agentKey to a live session id (or null). */
  resolveTarget: (target: string) => string | null
  /** Set the owner. null reverts to default (Al). */
  setOwner: (sessionId: string | null) => void
  setHot: (hot: boolean) => void
  /** Inject + auto-send a transcript to a session. Returns false if not live. */
  injectToSession: (sessionId: string, content: string) => boolean
  /** Broadcast a transcript to the owner's SPA composer WITHOUT sending it
   *  (review-before-send). Returns the owner id (or null if none). */
  compose: (text: string) => string | null
}

export function handleMicRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: MicRouteCtx,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  if (!path.startsWith('/mic')) return false
  const json = (data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (path === '/mic/status' && req.method === 'GET') {
    const owner = ctx.effectiveOwnerId()
    json({ owner, ownerName: ctx.ownerName(owner), hot: ctx.isHot(), explicit: ctx.explicitOwnerId() })
    return true
  }

  // POST /mic/owner { target } — give the mic. target = session id | name |
  // agentKey. Empty / "default" / "al" reverts to Al.
  if (path === '/mic/owner' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { target } = JSON.parse(body || '{}') as { target?: string }
      const t = (target ?? '').trim()
      if (!t || t.toLowerCase() === 'default' || t.toLowerCase() === 'al') {
        ctx.setOwner(null)
        const owner = ctx.effectiveOwnerId()
        json({ ok: true, owner, ownerName: ctx.ownerName(owner) })
        return
      }
      const sessionId = ctx.resolveTarget(t)
      if (!sessionId) { json({ error: `no live session matching "${t}"` }, 404); return }
      ctx.setOwner(sessionId)
      json({ ok: true, owner: sessionId, ownerName: ctx.ownerName(sessionId) })
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  // POST /mic/hot { hot } — flip the recording indicator (desktop/phone PTT).
  if (path === '/mic/hot' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { hot } = JSON.parse(body || '{}') as { hot?: boolean }
      ctx.setHot(!!hot)
      json({ ok: true, hot: !!hot })
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  // POST /mic/say { text } — route a transcript to the current owner and
  // auto-send it. This is the PTT delivery endpoint.
  if (path === '/mic/say' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { text } = JSON.parse(body || '{}') as { text?: string }
      const t = (text ?? '').trim()
      if (!t) { console.log('[mic] say: empty transcript (skipped)'); json({ ok: true, skipped: 'empty transcript' }); return }
      const owner = ctx.effectiveOwnerId()
      if (!owner) { console.log('[mic] say: no owner'); json({ error: 'no mic owner available (is Al up?)' }, 503); return }
      const ok = ctx.injectToSession(owner, t)
      console.log(`[mic] say → owner=${owner} (${ctx.ownerName(owner)}) live=${ok} text=${JSON.stringify(t.slice(0, 80))}`)
      json(ok ? { ok: true, owner, ownerName: ctx.ownerName(owner) } : { error: 'owner session not live' }, ok ? 200 : 503)
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  // POST /mic/compose { text } — drop a transcript into the owner's SPA
  // composer, unsent, for review/edit before the user hits send. Default
  // PTT behaviour (vs /mic/say's auto-send).
  if (path === '/mic/compose' && req.method === 'POST') {
    readBody(req).then((body) => {
      const { text } = JSON.parse(body || '{}') as { text?: string }
      const t = (text ?? '').trim()
      if (!t) { console.log('[mic] compose: empty transcript (skipped)'); json({ ok: true, skipped: 'empty transcript' }); return }
      const owner = ctx.compose(t)
      console.log(`[mic] compose → owner=${owner} (${ctx.ownerName(owner)}) text=${JSON.stringify(t.slice(0, 80))}`)
      json({ ok: true, owner, ownerName: ctx.ownerName(owner) })
    }).catch((err: Error) => json({ error: err.message }, 400))
    return true
  }

  return false
}
