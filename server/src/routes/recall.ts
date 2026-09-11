// Past-session recall over HTTP — backs `con agent search` / `con agent read`.
//   GET /agents/recall/search?q=&project=&here=&since=&until=&file=&branch=&session=&limit=&tools=1&cwd=&self=1
//   GET /agents/recall/read?address=&turns=&grep=&max=&tools=1
//   GET /agents/recall/stats

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RecallIndex } from '../recall/index.js'
import type { QueryLog } from '../recall/qlog.js'
import { NotFoundError } from '../recall/query.js'
import type { Session } from '../session.js'

interface Deps {
  recall: RecallIndex | null
  qlog: QueryLog
  getSessions: () => Map<string, Session>
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The caller's own claudeSessionId, from the X-Console-Agent header the CLI
 *  sends — its session is excluded from results (it knows what it did). */
function callerSession(req: IncomingMessage, deps: Deps): { agentKey: string; claudeSessionId: string } {
  const agentKey = String(req.headers['x-console-agent'] ?? '').trim()
  if (!agentKey) return { agentKey: '', claudeSessionId: '' }
  for (const s of deps.getSessions().values()) {
    if (s.agentKey === agentKey && s.status !== 'ended' && s.claudeSessionId) return { agentKey, claudeSessionId: s.claudeSessionId }
  }
  return { agentKey, claudeSessionId: '' }
}

function flag(url: URL, name: string): boolean {
  const v = url.searchParams.get(name)
  return v !== null && v !== '' && v !== '0' && v !== 'false'
}

function num(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name)
  if (v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function handleRecallRoutes(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: Deps): boolean {
  if (!path.startsWith('/agents/recall/')) return false
  if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return true }
  if (!deps.recall) { json(res, 503, { error: 'recall index disabled' }); return true }
  const recall = deps.recall

  if (path === '/agents/recall/stats') {
    recall.stats().then((s) => json(res, 200, s), (err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }))
    return true
  }

  const caller = callerSession(req, deps)
  const cwd = url.searchParams.get('cwd') ?? ''
  const t0 = Date.now()

  if (path === '/agents/recall/search') {
    const query = url.searchParams.get('q') ?? ''
    const filters = {
      project: url.searchParams.get('project') ?? undefined,
      under: flag(url, 'here') && cwd ? cwd : undefined,
      since: url.searchParams.get('since') ?? undefined,
      until: url.searchParams.get('until') ?? undefined,
      file: url.searchParams.get('file') ?? undefined,
      branch: url.searchParams.get('branch') ?? undefined,
      session: url.searchParams.get('session') ?? undefined,
      excludeId: flag(url, 'self') ? undefined : caller.claudeSessionId || undefined,
    }
    const params = { query, filters, limit: num(url, 'limit'), cwdHint: cwd || undefined, includeTools: flag(url, 'tools') }
    recall.search(params).then(
      (r) => {
        deps.qlog.append({ ts: new Date().toISOString(), tool: 'search', agentKey: caller.agentKey, session: caller.claudeSessionId, cwd, query, params: compact({ ...filters, limit: params.limit, tools: params.includeTools || undefined }), hits: r.hits, ms: Date.now() - t0 })
        json(res, 200, { ...r, query, filters: compact(filters) })
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err)
        deps.qlog.append({ ts: new Date().toISOString(), tool: 'search', agentKey: caller.agentKey, session: caller.claudeSessionId, cwd, query, params: compact(filters), hits: null, ms: Date.now() - t0, error: message })
        json(res, err instanceof NotFoundError ? 404 : 400, { error: message })
      },
    )
    return true
  }

  if (path === '/agents/recall/read') {
    const address = url.searchParams.get('address') ?? ''
    if (!address.trim()) { json(res, 400, { error: 'missing address (<session8>[/<uuid8>|/t<idx>][#<seq>] or a cite tag)' }); return true }
    const params = { address, turns: url.searchParams.get('turns') ?? undefined, grep: url.searchParams.get('grep') ?? undefined, maxChars: num(url, 'max'), includeTools: flag(url, 'tools') }
    recall.read(params).then(
      (r) => {
        deps.qlog.append({ ts: new Date().toISOString(), tool: 'read', agentKey: caller.agentKey, session: caller.claudeSessionId, cwd, query: address, params: compact({ turns: params.turns, grep: params.grep, max: params.maxChars, tools: params.includeTools || undefined }), hits: 1, ms: Date.now() - t0 })
        json(res, 200, { ...r, address })
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err)
        deps.qlog.append({ ts: new Date().toISOString(), tool: 'read', agentKey: caller.agentKey, session: caller.claudeSessionId, cwd, query: address, params: {}, hits: null, ms: Date.now() - t0, error: message })
        json(res, /no indexed session|no turn|no tool call|ambiguous/.test(message) ? 404 : 400, { error: message })
      },
    )
    return true
  }

  json(res, 404, { error: 'unknown recall route' })
  return true
}

function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null && v !== false) out[k] = v
  return out
}
