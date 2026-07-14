// Hub cron HTTP routes — CRUD + ICS feed + upcoming-firings preview

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { HubCronScheduler, HubCronTask } from '../cron/scheduler.js'
import { buildIcs } from '../cron/ics.js'
import type { Session } from '../session.js'
import { AL_SESSION_ID } from '../al-bridge.js'

interface Deps {
  scheduler: HubCronScheduler
  getSessions: () => Map<string, Session>
  getAlConnected: () => boolean
  log: (msg: string) => void
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function methodNotAllowed(res: ServerResponse) {
  json(res, 405, { error: 'method not allowed' })
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function nameForSession(claudeSessionId: string, deps: Deps): string {
  for (const s of deps.getSessions().values()) {
    if (s.claudeSessionId === claudeSessionId) return s.name || claudeSessionId.slice(0, 8)
  }
  if (claudeSessionId === AL_SESSION_ID && deps.getAlConnected()) return 'Al'
  return claudeSessionId.slice(0, 8)
}

export function handleCronRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  deps: Deps,
  readBody: (req: IncomingMessage) => Promise<string>,
): boolean {
  const { scheduler } = deps

  // GET /cron[?session=<claudeSessionId>]
  if (path === '/cron' && req.method === 'GET') {
    const session = url.searchParams.get('session') ?? undefined
    const tasks = scheduler.list(session ? { claudeSessionId: session } : undefined)
    json(res, 200, tasks)
    return true
  }

  // POST /cron — { claudeSessionId, trigger, prompt, recurring }
  if (path === '/cron' && req.method === 'POST') {
    readBody(req).then((body) => {
      try {
        const parsed = JSON.parse(body) as Partial<HubCronTask> & { recurring?: boolean }
        const task = scheduler.add({
          claudeSessionId: String(parsed.claudeSessionId ?? ''),
          trigger: String(parsed.trigger ?? ''),
          prompt: String(parsed.prompt ?? ''),
          recurring: parsed.recurring !== false,
          ...(parsed.guard ? { guard: String(parsed.guard) } : {}),
        })
        json(res, 200, task)
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
      }
    }).catch((e) => json(res, 500, { error: (e as Error).message }))
    return true
  }

  // GET /cron/upcoming?n=20
  if (path === '/cron/upcoming' && req.method === 'GET') {
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n') ?? 20)))
    const out = scheduler.upcoming(n).map(({ task, fires }) => ({
      task,
      fires: fires.map((d) => d.toISOString()),
    }))
    json(res, 200, out)
    return true
  }

  // GET /cron/ics-token — token + the public Caddy-served URL.
  // CLI/SPA use publicUrl verbatim; null means no public origin configured.
  if (path === '/cron/ics-token' && req.method === 'GET') {
    const token = scheduler.getIcsToken()
    scheduler.getPublicIcsBase()
      .then((publicBase) => json(res, 200, {
        token,
        publicUrl: publicBase ? `${publicBase}/public/cron.ics?token=${token}` : null,
      }))
      .catch(() => json(res, 200, { token, publicUrl: null }))
    return true
  }

  // GET /cron.ics?token=...
  if (path === '/cron.ics' && req.method === 'GET') {
    const ua = String(req.headers['user-agent'] ?? '?').slice(0, 80)
    const ip = req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?'
    const token = url.searchParams.get('token') ?? ''
    if (!safeEqual(token, scheduler.getIcsToken())) {
      deps.log(`[cron.ics] FORBIDDEN ip=${ip} ua=${ua}`)
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('forbidden')
      return true
    }
    const upcoming = scheduler.upcoming(50)
    const ics = buildIcs(upcoming, { nameFor: (csid) => nameForSession(csid, deps) })
    deps.log(`[cron.ics] 200 ip=${ip} bytes=${ics.length} events=${upcoming.reduce((n, u) => n + u.fires.length, 0)} ua=${ua}`)
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'max-age=300',
    })
    res.end(ics)
    return true
  }

  // /cron/:id — DELETE | POST /run
  const m = path.match(/^\/cron\/([A-Za-z0-9_-]+)(?:\/(run))?$/)
  if (m) {
    const id = m[1]!
    const verb = m[2]
    if (req.method === 'DELETE' && !verb) {
      json(res, 200, { removed: scheduler.remove(id) })
      return true
    }
    if (req.method === 'POST' && verb === 'run') {
      void scheduler.runOnce(id).then((r) => json(res, 200, r)).catch((e) => json(res, 500, { error: (e as Error).message }))
      return true
    }
    methodNotAllowed(res)
    return true
  }

  return false
}
